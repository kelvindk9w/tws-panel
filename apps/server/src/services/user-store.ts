/**
 * user-store.ts — persistência dos usuários do painel em data/users.json
 * (JSON com chmod 600, mesmo padrão dos demais stores em data/).
 * Armazena APENAS o hash argon2 da senha — nunca a senha em claro.
 *
 * Toda alteração passa por `persist()`: aplicada e gravada DENTRO da fila de
 * gravações. Se a gravação falha, a alteração é desfeita em memória e quem
 * pediu recebe o erro `storage_write_failed` — o processo nunca passa a se
 * comportar de um jeito que um reinício desfaria (ex.: senha "trocada" que
 * volta a ser a antiga depois do restart).
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
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "users.json");
  }

  /**
   * Carga única e compartilhada: chamadas concorrentes esperam a MESMA leitura.
   * Com uma flag simples, a segunda chamada seguiria com a lista vazia e a
   * leitura atrasada sobrescreveria depois o que ela tivesse alterado.
   */
  private ensureLoaded(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<UsersFile>;
        this.users = Array.isArray(raw.users) ? raw.users : [];
      } catch {
        this.users = [];
      }
    })();
    return this.loading;
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
    // A checagem roda dentro da fila: duas criações concorrentes nunca veem,
    // as duas, a lista vazia.
    return this.persist(() => {
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
      this.users = [...this.users, user];
      return user;
    });
  }

  async updatePassword(id: string, passwordHash: string): Promise<StoredUser | null> {
    await this.ensureLoaded();
    return this.persist(() => {
      const atual = this.users.find((u) => u.id === id);
      if (!atual) return null;
      // objeto NOVO em vez de mutar o existente: se a gravação falhar, basta
      // voltar à lista anterior — e quem guardou a referência antiga não vê
      // uma senha que nunca chegou ao disco.
      const user: StoredUser = {
        ...atual,
        passwordHash,
        updatedAt: new Date().toISOString(),
      };
      this.users = this.users.map((u) => (u.id === id ? user : u));
      return user;
    });
  }

  /**
   * Aplica `change` e grava, em fila (sem intercalar JSON no arquivo).
   *
   * `change` só roda na vez dele, com as alterações anteriores já gravadas (ou
   * já desfeitas): por isso restaurar a lista de antes em caso de falha nunca
   * apaga a alteração de outra chamada — nenhuma outra roda no meio. As
   * alterações trocam a lista inteira (nunca mutam em lugar), então "nada
   * mudou" é a mesma referência e dispensa a gravação.
   *
   * A falha REJEITA para quem chamou, mas a cadeia `writing` segue resolvida:
   * a próxima gravação roda normalmente.
   */
  private persist<T>(change: () => T): Promise<T> {
    const run = this.writing.then(async () => {
      const antes = this.users;
      const result = change();
      if (this.users === antes) return result;
      try {
        await this.save();
      } catch (err) {
        this.users = antes;
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
    const data: UsersFile = { users: this.users };
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
    "Não foi possível salvar os dados de usuário no disco do servidor. Nada foi alterado.",
    { cause },
  ) as Error & { statusCode: number; code: string };
  err.statusCode = 500;
  err.code = "storage_write_failed";
  return err;
}
