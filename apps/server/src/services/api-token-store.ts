/**
 * api-token-store.ts — tokens de API do painel, persistidos em
 * data/api-tokens.json (chmod 600), no mesmo estilo das sessões.
 *
 * O arquivo guarda só o HASH (SHA-256) do token. O valor tem 256 bits sorteados
 * pelo sistema: não há senha fraca para adivinhar, então um hash rápido basta
 * (um KDF lento só pesaria em toda requisição). A busca compara o hash de
 * TODOS os registros em tempo constante, sem parar no primeiro acerto.
 *
 * Toda alteração passa por `persist()`: aplicada e gravada DENTRO da fila de
 * gravações e desfeita em memória se a gravação falhar (`storage_write_failed`).
 * Revogação é segurança: um token dado como revogado não volta a valer.
 *
 * Falha fechada: arquivo ilegível é guardado à parte (json-file.ts) e a lista
 * começa vazia — nenhum token antigo vale; erro de disco ao ler LANÇA e quem
 * chama responde 503, sem aceitar nada. O painel sobe de qualquer jeito: a
 * carga é preguiçosa, só acontece quando alguém usa ou lista tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_PROJECTS,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  type ApiTokenInfo,
  type ApiTokenReach,
  type ApiTokenScope,
  type ApiTokenStatus,
} from "@paas/core";
import { httpError } from "./http-error.js";
import { loadJson, writeFileAtomic } from "./json-file.js";

export interface StoredApiToken {
  id: string;
  name: string;
  scope: ApiTokenScope;
  /**
   * Alcance (Fase 0b). Depois de carregado, sempre preenchido: arquivo da Fase 0
   * (sem estes campos) vira painel inteiro; alcance ilegível vira "sem alcance"
   * (projetos, lista vazia, não cria) — nunca amplia.
   */
  reach: ApiTokenReach;
  projects: string[];
  canCreate: boolean;
  /** SHA-256 do token, em hexa. O token em si nunca é gravado. */
  hash: string;
  /** Quem criou (a conta do painel). */
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface TokensFile {
  tokens: StoredApiToken[];
}

/** Revogado ou vencido há mais que isso sai do arquivo (o histórico fica na Auditoria). */
const KEEP_INACTIVE_MS = 90 * 24 * 60 * 60 * 1000;
/** O "último uso" só é regravado se o anterior tiver mais que isso (evita um write por requisição). */
const TOUCH_EVERY_MS = 60 * 1000;
/** Teto de registros no arquivo, contando os inativos. */
const MAX_RECORDS = 200;

const SCOPES = new Set<string>(["read", "write", "admin"]);

/** O que o token alcança, no formato que o plugin de autenticação e as rotas usam. */
export type TokenReach = { kind: "panel" } | { kind: "projects"; ids: readonly string[]; canCreate: boolean };

export function reachOf(t: Pick<StoredApiToken, "reach" | "projects" | "canCreate">): TokenReach {
  return t.reach === "panel" ? { kind: "panel" } : { kind: "projects", ids: [...t.projects], canCreate: t.canCreate };
}

const NO_REACH = { reach: "projects", projects: [], canCreate: false } as const;

function validProjectId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 1 && id.length <= 64;
}

/**
 * Lê o alcance de um registro do disco. Ausência TOTAL dos três campos = arquivo
 * da Fase 0 = painel inteiro. Qualquer outra coisa que não seja exatamente um
 * alcance válido vira "sem alcance": o token não alcança projeto nenhum.
 */
function reachFromDisk(t: Record<string, unknown>): Pick<StoredApiToken, "reach" | "projects" | "canCreate"> {
  if (t.reach === undefined && t.projects === undefined && t.canCreate === undefined) {
    return { reach: "panel", projects: [], canCreate: false };
  }
  if (t.reach === "panel") return { reach: "panel", projects: [], canCreate: false };
  if (t.reach !== "projects") return { ...NO_REACH, projects: [] };
  const list = t.projects;
  const canCreate = t.canCreate === undefined ? false : t.canCreate;
  if (
    !Array.isArray(list) ||
    list.length > API_TOKEN_MAX_PROJECTS ||
    !list.every(validProjectId) ||
    typeof canCreate !== "boolean"
  ) {
    return { ...NO_REACH, projects: [] };
  }
  return { reach: "projects", projects: [...new Set(list)], canCreate };
}

function invalidReach(message: string): Error {
  return httpError(400, "invalid_token_reach", message);
}

/** Confere e normaliza o alcance pedido (criação/edição). Lança invalid_token_reach. */
function checkedReach(input: { reach?: ApiTokenReach | undefined; projects?: string[] | undefined; canCreate?: boolean | undefined }): Pick<
  StoredApiToken,
  "reach" | "projects" | "canCreate"
> {
  const reach = input.reach ?? "panel";
  const projects = [...new Set(input.projects ?? [])];
  const canCreate = input.canCreate === true;
  if (reach === "panel") {
    if (projects.length > 0 || canCreate) {
      throw invalidReach("Token de painel inteiro não tem lista de projetos nem 'pode criar projetos'.");
    }
    return { reach: "panel", projects: [], canCreate: false };
  }
  if (projects.length > API_TOKEN_MAX_PROJECTS || !projects.every(validProjectId)) {
    throw invalidReach(`Lista de projetos inválida (até ${API_TOKEN_MAX_PROJECTS} projetos).`);
  }
  if (projects.length === 0 && !canCreate) {
    throw invalidReach("Escolha ao menos um projeto, ou permita que o token crie projetos novos.");
  }
  return { reach: "projects", projects, canCreate };
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function validRecord(r: unknown): r is StoredApiToken {
  if (!r || typeof r !== "object") return false;
  const t = r as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.scope === "string" &&
    SCOPES.has(t.scope) &&
    typeof t.hash === "string" &&
    /^[0-9a-f]{64}$/.test(t.hash) &&
    typeof t.userId === "string" &&
    typeof t.createdAt === "string" &&
    typeof t.expiresAt === "string" &&
    Number.isFinite(Date.parse(t.expiresAt)) &&
    (t.lastUsedAt === null || typeof t.lastUsedAt === "string") &&
    (t.revokedAt === null || typeof t.revokedAt === "string")
  );
}

export function tokenStatus(t: Pick<StoredApiToken, "expiresAt" | "revokedAt">, now = Date.now()): ApiTokenStatus {
  if (t.revokedAt !== null) return "revoked";
  return Date.parse(t.expiresAt) <= now ? "expired" : "active";
}

export function toInfo(t: StoredApiToken, now = Date.now()): ApiTokenInfo {
  return {
    id: t.id,
    name: t.name,
    scope: t.scope,
    reach: t.reach,
    projects: [...t.projects],
    canCreate: t.canCreate,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    status: tokenStatus(t, now),
  };
}

export class ApiTokenStore {
  private readonly file: string;
  private tokens: StoredApiToken[] = [];
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Gravações do "último uso" em andamento (flush() espera por elas). */
  private readonly touching = new Set<Promise<unknown>>();
  /** Quando cada token teve o "último uso" disparado (memória; some no reinício). */
  private readonly lastTouch = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.file = path.join(dataDir, "api-tokens.json");
  }

  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = null; // erro de disco: a próxima chamada tenta de novo
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    this.tokens = await loadJson<StoredApiToken[]>(this.file, {
      empty: () => [],
      parse: (raw) => {
        const list = (raw as Partial<TokensFile> | null)?.tokens;
        // Um registro malformado invalida o arquivo inteiro: melhor nenhum token
        // do que um token com escopo ou validade lidos de lixo.
        if (!Array.isArray(list) || !list.every(validRecord)) return null;
        return list.map((t) => ({ ...t, ...reachFromDisk(t as unknown as Record<string, unknown>) }));
      },
      log: this.log,
    });
  }

  /** Sorteia o token: prefixo + 32 bytes (256 bits) em base64url. */
  static generate(): string {
    return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  }

  /**
   * Cria um token. Devolve o valor em claro UMA vez; o arquivo guarda só o hash.
   * O limite de ativos e o nome único são conferidos DENTRO da fila de gravação
   * (criações simultâneas não passam do teto).
   */
  async create(input: {
    name: string;
    scope: ApiTokenScope;
    ttlHours: number;
    userId: string;
    reach?: ApiTokenReach;
    projects?: string[];
    canCreate?: boolean;
  }): Promise<{ token: string; info: ApiTokenInfo }> {
    const alcance = checkedReach(input);
    await this.ensureLoaded();
    const token = ApiTokenStore.generate();
    const now = Date.now();
    const record: StoredApiToken = {
      id: randomBytes(8).toString("hex"),
      name: input.name,
      scope: input.scope,
      ...alcance,
      hash: hashToken(token).toString("hex"),
      userId: input.userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlHours * 3_600_000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.persist(() => {
      const active = this.tokens.filter((t) => tokenStatus(t, now) === "active");
      if (active.length >= API_TOKEN_MAX_ACTIVE) {
        throw httpError(
          409,
          "too_many_tokens",
          `Limite de ${API_TOKEN_MAX_ACTIVE} tokens ativos. Revogue algum antes de criar outro.`,
        );
      }
      if (active.some((t) => t.name.toLowerCase() === record.name.toLowerCase())) {
        throw httpError(409, "token_name_taken", "Já existe um token ativo com esse nome. Escolha outro nome.");
      }
      const keep = this.tokens.filter((t) => tokenStatus(t, now) === "active" || tokenInactiveSince(t) > now - KEEP_INACTIVE_MS);
      this.tokens = [...keep, record].slice(-MAX_RECORDS);
    });
    return { token, info: toInfo(record, now) };
  }

  /**
   * O token (valor em claro) vale agora? Devolve o registro ou null. Mesmo
   * resultado (null) para formato errado, inexistente, vencido e revogado —
   * quem chama não distingue, e não pode haver oráculo.
   */
  async resolve(token: string): Promise<StoredApiToken | null> {
    if (!API_TOKEN_PATTERN.test(token)) return null;
    await this.ensureLoaded();
    const wanted = hashToken(token);
    let found: StoredApiToken | null = null;
    // Sem `break`: o tempo não revela em que posição (ou se) o token está.
    for (const t of this.tokens) {
      if (timingSafeEqual(Buffer.from(t.hash, "hex"), wanted)) found = t;
    }
    if (!found || tokenStatus(found) !== "active") return null;
    this.touch(found.id);
    return found;
  }

  /** Registra o último uso (no máximo uma gravação por minuto por token; falha de disco não derruba o pedido). */
  private touch(id: string): void {
    const now = Date.now();
    const before = this.lastTouch.get(id);
    if (before !== undefined && now - before < TOUCH_EVERY_MS) return;
    this.lastTouch.set(id, now); // síncrono: uma rajada de pedidos dispara uma gravação só
    const stamp = new Date(now).toISOString();
    const op = this.persist(() => {
      this.tokens = this.tokens.map((t) => (t.id === id && t.revokedAt === null ? { ...t, lastUsedAt: stamp } : t));
    }).catch((err: unknown) => {
      this.log(`api-tokens: último uso não gravado (${err instanceof Error ? err.message : String(err)})`);
    });
    this.touching.add(op);
    void op.finally(() => this.touching.delete(op));
  }

  /** Espera as gravações de "último uso" já disparadas (testes, desligamento). */
  async flush(): Promise<void> {
    while (this.touching.size > 0) await Promise.allSettled([...this.touching]);
    await this.writing;
  }

  async list(): Promise<ApiTokenInfo[]> {
    await this.ensureLoaded();
    const now = Date.now();
    return this.tokens.map((t) => toInfo(t, now)).reverse();
  }

  /** Revoga o token (vale na hora). Devolve o token revogado, ou null se não existe / já estava revogado. */
  async revoke(id: string): Promise<ApiTokenInfo | null> {
    await this.ensureLoaded();
    const at = new Date().toISOString();
    return this.persist(() => {
      const target = this.tokens.find((t) => t.id === id && t.revokedAt === null);
      if (!target) return null;
      const revoked = { ...target, revokedAt: at };
      this.tokens = this.tokens.map((t) => (t === target ? revoked : t));
      return toInfo(revoked);
    });
  }

  /**
   * Registra na lista do token o projeto que ELE acabou de criar. Só vale para token
   * ativo, de alcance "projects" e com "pode criar". Devolve false quando não vale
   * (quem chama desfaz a criação do projeto); falha de gravação lança
   * storage_write_failed e a lista fica como estava.
   */
  async addProject(tokenId: string, projectId: string): Promise<boolean> {
    if (!validProjectId(projectId)) throw invalidReach("Id de projeto inválido.");
    await this.ensureLoaded();
    return this.persist(() => {
      const target = this.tokens.find((t) => t.id === tokenId);
      if (!target || tokenStatus(target) !== "active" || target.reach !== "projects" || !target.canCreate) return false;
      if (target.projects.includes(projectId)) return true;
      if (target.projects.length >= API_TOKEN_MAX_PROJECTS) return false;
      this.tokens = this.tokens.map((t) => (t === target ? { ...t, projects: [...t.projects, projectId] } : t));
      return true;
    });
  }

  /** Troca a lista e o "pode criar" de um token ativo de alcance "projects". null = não existe / não vale editar. */
  async updateReach(id: string, input: { projects: string[]; canCreate: boolean }): Promise<ApiTokenInfo | null> {
    const alcance = checkedReach({ reach: "projects", projects: input.projects, canCreate: input.canCreate });
    await this.ensureLoaded();
    return this.persist(() => {
      const target = this.tokens.find((t) => t.id === id);
      if (!target || tokenStatus(target) !== "active" || target.reach !== "projects") return null;
      const updated = { ...target, ...alcance };
      this.tokens = this.tokens.map((t) => (t === target ? updated : t));
      return toInfo(updated);
    });
  }

  /** Projeto apagado: sai da lista de TODOS os tokens (ativos e inativos). */
  async forgetProject(projectId: string): Promise<void> {
    await this.ensureLoaded();
    await this.persist(() => {
      if (!this.tokens.some((t) => t.projects.includes(projectId))) return;
      this.tokens = this.tokens.map((t) => (t.projects.includes(projectId) ? { ...t, projects: t.projects.filter((p) => p !== projectId) } : t));
    });
  }

  /** Revoga todos os ativos (troca de senha, "Recomeçar do zero"). Devolve quantos. */
  async revokeAll(): Promise<number> {
    await this.ensureLoaded();
    const at = new Date().toISOString();
    return this.persist(() => {
      const count = this.tokens.filter((t) => t.revokedAt === null).length;
      if (count > 0) this.tokens = this.tokens.map((t) => (t.revokedAt === null ? { ...t, revokedAt: at } : t));
      return count;
    });
  }

  /**
   * Aplica `change` e grava em fila. A alteração troca a lista inteira (nunca
   * muta em lugar): "nada mudou" é a mesma referência e dispensa a gravação.
   * Se `change` lança ou a gravação falha, a lista volta ao que era.
   */
  private persist<T>(change: () => T): Promise<T> {
    const run = this.writing.then(async () => {
      const antes = this.tokens;
      let result: T;
      try {
        result = change();
      } catch (err) {
        this.tokens = antes;
        throw err;
      }
      if (this.tokens === antes) return result;
      try {
        await writeFileAtomic(this.file, JSON.stringify({ tokens: this.tokens } satisfies TokensFile, null, 2) + "\n");
      } catch (err) {
        this.tokens = antes;
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
}

/** Quando o token deixou de valer (revogação ou vencimento), em epoch ms. */
function tokenInactiveSince(t: StoredApiToken): number {
  return Math.min(Date.parse(t.expiresAt), t.revokedAt === null ? Infinity : Date.parse(t.revokedAt));
}

function storageWriteFailed(cause: unknown): Error & { statusCode: number; code: string } {
  const err = new Error("Não foi possível salvar os tokens no disco do servidor. Nada foi alterado.", {
    cause,
  }) as Error & { statusCode: number; code: string };
  err.statusCode = 500;
  err.code = "storage_write_failed";
  return err;
}
