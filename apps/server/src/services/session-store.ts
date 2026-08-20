/**
 * session-store.ts — sessões revogáveis do painel, persistidas em
 * data/sessions.json (chmod 600). NÃO é JWT stateless: cada sessão pode ser
 * invalidada individualmente (logout, troca de senha).
 *
 * O cookie carrega `<id>.<hmac>` — o HMAC usa o segredo de sessão gerado no
 * primeiro boot e persistido em data/session-secret (chmod 600), garantindo
 * que um cookie forjado sem o segredo seja rejeitado.
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
  private loaded = false;
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

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.secret) await this.init();
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<SessionsFile>;
      this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    } catch {
      this.sessions = [];
    }
    // descarta sessões expiradas no boot
    const now = Date.now();
    const valid = this.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    if (valid.length !== this.sessions.length) {
      this.sessions = valid;
      await this.persist();
    }
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
    this.sessions.push(session);
    await this.persist();
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
      await this.destroy(id);
      return null;
    }
    return session;
  }

  async destroy(id: string): Promise<void> {
    await this.ensureLoaded();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length !== before) await this.persist();
  }

  /** Invalida todas as sessões do usuário, exceto a atual (troca de senha). */
  async destroyOthersForUser(userId: string, keepSessionId: string): Promise<number> {
    await this.ensureLoaded();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(
      (s) => s.userId !== userId || s.id === keepSessionId,
    );
    const removed = before - this.sessions.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  /** Serializa as escritas para não intercalar JSON no arquivo. */
  private async persist(): Promise<void> {
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
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
