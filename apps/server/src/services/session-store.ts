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
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_TTL_MS } from "@paas/core";

export interface Session {
  id: string;
  userId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
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
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sessions.json");
    this.secretFile = path.join(dataDir, "session-secret");
  }

  /** Carrega (ou gera no primeiro boot) o segredo de sessão. */
  async init(): Promise<void> {
    try {
      const raw = (await readFile(this.secretFile, "utf8")).trim();
      if (raw.length >= 32) {
        this.secret = Buffer.from(raw, "hex");
        return;
      }
    } catch {
      // arquivo inexistente ou ilegível — gera um novo abaixo
    }
    const generated = randomBytes(32);
    await mkdir(path.dirname(this.secretFile), { recursive: true });
    await writeFile(this.secretFile, generated.toString("hex") + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.secretFile, 0o600).catch(() => undefined);
    this.secret = generated;
  }

  /** Carga única e compartilhada (chamadas concorrentes esperam a mesma leitura). */
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!this.secret) await this.init();
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<SessionsFile>;
      this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    } catch {
      this.sessions = [];
    }
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
    if (Date.parse(session.expiresAt) <= Date.now()) {
      // Expirada é recusada mesmo que a limpeza não chegue ao disco: a
      // validade vem de expiresAt, não da presença no arquivo.
      await this.destroy(id).catch(() => undefined);
      return null;
    }
    return session;
  }

  async destroy(id: string): Promise<void> {
    await this.ensureLoaded();
    await this.persist(() => {
      const restantes = this.sessions.filter((s) => s.id !== id);
      if (restantes.length !== this.sessions.length) this.sessions = restantes;
    });
  }

  /** Invalida todas as sessões do usuário, exceto a atual (troca de senha). */
  async destroyOthersForUser(userId: string, keepSessionId: string): Promise<number> {
    await this.ensureLoaded();
    return this.persist(() => {
      const restantes = this.sessions.filter(
        (s) => s.userId !== userId || s.id === keepSessionId,
      );
      const removed = this.sessions.length - restantes.length;
      if (removed > 0) this.sessions = restantes;
      return removed;
    });
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
    await mkdir(path.dirname(this.file), { recursive: true });
    const data: SessionsFile = { sessions: this.sessions };
    await writeFile(this.file, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
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
