/**
 * user-store.ts — persistência dos usuários do painel em data/users.json
 * (JSON com chmod 600, mesmo padrão dos demais stores em data/).
 * Armazena APENAS o hash argon2 da senha — nunca a senha em claro.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredUser {
  id: string;
  username: string;
  /** username normalizado para busca case-insensitive. */
  usernameLower: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

interface UsersFile {
  users: StoredUser[];
}

export class UserStore {
  private readonly file: string;
  private users: StoredUser[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "users.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<UsersFile>;
      this.users = Array.isArray(raw.users) ? raw.users : [];
    } catch {
      this.users = [];
    }
  }

  /** O painel tem uma única conta admin (criada no Passo 4 do wizard). */
  async hasAdmin(): Promise<boolean> {
    await this.ensureLoaded();
    return this.users.length > 0;
  }

  async findByUsername(username: string): Promise<StoredUser | null> {
    await this.ensureLoaded();
    const lower = username.toLowerCase();
    return this.users.find((u) => u.usernameLower === lower) ?? null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    await this.ensureLoaded();
    return this.users.find((u) => u.id === id) ?? null;
  }

  /**
   * Cria o usuário admin. Lança "admin_exists" se já houver qualquer conta —
   * protege contra corrida entre duas chamadas concorrentes do endpoint.
   */
  async create(username: string, passwordHash: string): Promise<StoredUser> {
    await this.ensureLoaded();
    if (this.users.length > 0) {
      throw new Error("admin_exists");
    }
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: randomBytes(8).toString("hex"),
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      createdAt: now,
      updatedAt: now,
    };
    this.users.push(user);
    await this.persist();
    return user;
  }

  async updatePassword(id: string, passwordHash: string): Promise<StoredUser | null> {
    await this.ensureLoaded();
    const user = this.users.find((u) => u.id === id);
    if (!user) return null;
    user.passwordHash = passwordHash;
    user.updatedAt = new Date().toISOString();
    await this.persist();
    return user;
  }

  /** Serializa as escritas para não intercalar JSON no arquivo. */
  private async persist(): Promise<void> {
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const data: UsersFile = { users: this.users };
    await writeFile(this.file, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
