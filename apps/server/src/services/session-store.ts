/**
 * session-store.ts — sessões revogáveis do painel, persistidas em
 * data/sessions.json (chmod 600). NÃO é JWT stateless: cada sessão pode ser
 * invalidada individualmente (logout, troca de senha).
 *
 * O cookie carrega `<id>.<hmac>` — o HMAC usa o segredo de sessão gerado no
 * primeiro boot e persistido em data/session-secret (chmod 600), garantindo
 * que um cookie forjado sem o segredo seja rejeitado.
 *
 * Toda alteração passa por `persist()`: aplicada e gravada DENTRO da fila de
 * gravações e desfeita em memória se a gravação falhar, com o erro
 * `storage_write_failed` chegando a quem pediu. Revogação é segurança: uma
 * sessão dada como encerrada não pode voltar a valer depois de um reinício.
 *
 * `onRevoked` avisa quem guarda conexões presas a uma sessão (o WebSocket do
 * terminal) quando ela deixa de valer: só DEPOIS de a revogação estar no
 * disco — uma revogação que falhou não derruba nada, porque a sessão continua
 * valendo. A expiração não passa por aqui: quem guarda conexão confere
 * `expiresAt` por conta própria (ver isSessionExpired).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { SESSION_TTL_MS, type ApiTokenScope } from "@paas/core";
import type { TokenReach } from "./api-token-store.js";
import { loadJson, loadOrCreateKey, writeFileAtomic } from "./json-file.js";

export interface Session {
  id: string;
  userId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * Só na "sessão sintética" de um token de API (plugins/auth.ts): nunca é
   * gravada em sessions.json nem tem cookie. Presente = a requisição veio de
   * um token, com este escopo; rotas só para humanos conferem isto.
   */
  token?: { id: string; scope: ApiTokenScope; reach: TokenReach };
}

interface SessionsFile {
  sessions: Session[];
}

export class SessionStore {
  private readonly file: string;
  private readonly secretFile: string;
  private sessions: Session[] = [];
  private loading: Promise<void> | null = null;
  private secret: Buffer | null = null;
  private secretLoading: Promise<Buffer> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly revokedListeners = new Set<(ids: readonly string[]) => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sessions.json");
    this.secretFile = path.join(dataDir, "session-secret");
  }

  /**
   * Carrega (ou gera no primeiro boot) o segredo de sessão. Erro de leitura
   * que não seja "não existe" é lançado (chave nova derrubaria todas as
   * sessões e, pior, esconderia o problema); conteúdo que não é um segredo
   * hexa de 32 bytes é guardado à parte e substituído (json-file.ts).
   */
  async init(): Promise<void> {
    if (this.secret) return;
    this.secret = await (this.secretLoading ??= loadOrCreateKey(this.secretFile, 32, { log: (m) => console.warn(m) }).catch((err: unknown) => {
      this.secretLoading = null;
      throw err;
    }));
  }

  /**
   * Registra quem quer saber das sessões revogadas (logout, troca de senha,
   * "Recomeçar do zero"). Recebe os ids que deixaram de valer. Devolve a
   * função que cancela o registro.
   */
  onRevoked(listener: (ids: readonly string[]) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }

  /** Carga única e compartilhada (chamadas concorrentes esperam a mesma leitura). */
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!this.secret) await this.init();
    this.sessions = await loadJson<Session[]>(this.file, {
      empty: () => [],
      parse: (raw) => {
        const sessions = (raw as Partial<SessionsFile> | null)?.sessions;
        return Array.isArray(sessions) ? sessions : null;
      },
    });
    // descarta sessões expiradas no boot
    const now = Date.now();
    await this.persist(() => {
      const valid = this.sessions.filter((s) => Date.parse(s.expiresAt) > now);
      if (valid.length !== this.sessions.length) this.sessions = valid;
    }).catch(() => {
      // Falha ao regravar sem as expiradas não impede o boot: elas continuam
      // em memória e no disco, e resolve() recusa sessão expirada de qualquer
      // jeito — memória e disco seguem dizendo a mesma coisa.
    });
  }

  private sign(id: string): string {
    if (!this.secret) throw new Error("SessionStore não inicializado (init() não chamado)");
    return createHmac("sha256", this.secret).update(id).digest("hex");
  }

  /** Cria uma sessão e retorna o valor assinado do cookie. */
  async create(
    user: { id: string; username: string },
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ session: Session; cookieValue: string }> {
    await this.ensureLoaded();
    const now = new Date();
    const session: Session = {
      id: randomBytes(24).toString("hex"),
      userId: user.id,
      username: user.username,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    };
    await this.persist(() => {
      this.sessions = [...this.sessions, session];
    });
    return { session, cookieValue: `${session.id}.${this.sign(session.id)}` };
  }

  /** Resolve o valor do cookie em uma sessão válida (assinatura + expiração). */
  async resolve(cookieValue: string | undefined): Promise<Session | null> {
    if (!cookieValue) return null;
    await this.ensureLoaded();
    const dot = cookieValue.indexOf(".");
    if (dot <= 0) return null;
    const id = cookieValue.slice(0, dot);
    const signature = cookieValue.slice(dot + 1);
    const expected = this.sign(id);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    if (isSessionExpired(session)) {
      // Expirada é recusada mesmo que a limpeza não chegue ao disco: a
      // validade vem de expiresAt, não da presença no arquivo.
      await this.destroy(id).catch(() => undefined);
      return null;
    }
    return session;
  }

  /**
   * A sessão ainda vale agora? Conferência SÍNCRONA, só em memória (sem
   * cookie e sem disco): para quem guarda conexão aberta e precisa fechar a
   * corrida entre resolver a sessão e registrar a conexão.
   */
  isActive(id: string): boolean {
    const session = this.sessions.find((s) => s.id === id);
    return session !== undefined && !isSessionExpired(session);
  }

  async destroy(id: string): Promise<void> {
    await this.revoke((s) => s.id === id);
  }

  /** Encerra todas as sessões ("Recomeçar do zero"). */
  async destroyAll(): Promise<void> {
    await this.revoke(() => true);
  }

  /** Invalida todas as sessões do usuário, exceto a atual (troca de senha). */
  async destroyOthersForUser(userId: string, keepSessionId: string): Promise<number> {
    return (await this.revoke((s) => s.userId === userId && s.id !== keepSessionId)).length;
  }

  /** Remove as sessões que casam com `match`, grava e avisa os ouvintes. */
  private async revoke(match: (s: Session) => boolean): Promise<string[]> {
    await this.ensureLoaded();
    const ids = await this.persist(() => {
      const removidas = this.sessions.filter(match).map((s) => s.id);
      if (removidas.length > 0) this.sessions = this.sessions.filter((s) => !match(s));
      return removidas;
    });
    if (ids.length > 0) {
      for (const listener of this.revokedListeners) {
        try {
          listener(ids);
        } catch {
          // um ouvinte com defeito não desfaz a revogação já gravada
        }
      }
    }
    return ids;
  }

  /**
   * Aplica `change` e grava, em fila (sem intercalar JSON no arquivo).
   *
   * `change` só roda na vez dele, com as alterações anteriores já gravadas (ou
   * já desfeitas): restaurar a lista de antes em caso de falha nunca apaga a
   * alteração de outra chamada, e uma alteração que falhou nunca pega carona
   * na gravação de outra. As alterações trocam a lista inteira (nunca mutam
   * em lugar), então "nada mudou" é a mesma referência e dispensa a gravação.
   *
   * A falha REJEITA para quem chamou, mas a cadeia `writing` segue resolvida:
   * a próxima gravação roda normalmente.
   */
  private persist<T>(change: () => T): Promise<T> {
    const run = this.writing.then(async () => {
      const antes = this.sessions;
      const result = change();
      if (this.sessions === antes) return result;
      try {
        await this.save();
      } catch (err) {
        this.sessions = antes;
        throw storageWriteFailed(err);
      }
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async save(): Promise<void> {
    const data: SessionsFile = { sessions: this.sessions };
    await writeFileAtomic(this.file, JSON.stringify(data, null, 2) + "\n");
  }
}

/** A sessão já venceu? (a mesma regra de resolve(), para quem guarda conexão aberta) */
export function isSessionExpired(session: Pick<Session, "expiresAt">, now = Date.now()): boolean {
  return Date.parse(session.expiresAt) <= now;
}

/**
 * Erro de gravação com formato de HttpError (`statusCode` + `code`) e mensagem
 * sem detalhe do sistema de arquivos — o caminho e o errno ficam em `cause`,
 * para log. As rotas trocam a mensagem pela do contexto (o que NÃO foi feito).
 */
function storageWriteFailed(cause: unknown): Error & { statusCode: number; code: string } {
  const err = new Error(
    "Não foi possível salvar as sessões no disco do servidor. Nada foi alterado.",
    { cause },
  ) as Error & { statusCode: number; code: string };
  err.statusCode = 500;
  err.code = "storage_write_failed";
  return err;
}
