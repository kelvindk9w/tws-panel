/**
 * credential-vault.ts — cofre das credenciais de LEITURA dos repositórios
 * privados dos projetos.
 *
 * Restrição inegociável do produto: o painel só LÊ repositórios — nunca
 * escreve, commita ou faz push. A credencial recomendada é um token de escopo
 * mínimo de leitura (no GitHub, um fine-grained PAT com `Contents: Read`).
 *
 * Em repouso o valor fica CIFRADO com AES-256-GCM:
 *  - chave de 32 bytes em `data/credentials-key` (0600), gerada no primeiro
 *    uso — mesmo padrão do segredo de sessão (services/session-store.ts),
 *    mas em ARQUIVO PRÓPRIO: rotacionar um não pode invalidar o outro;
 *  - nonce (IV) novo a cada gravação — dois `set` do mesmo valor produzem
 *    cifras diferentes;
 *  - tag de autenticação verificada na leitura: conteúdo adulterado FALHA,
 *    nunca devolve texto claro corrompido.
 *
 * O valor em claro só existe em memória, durante o clone (ver
 * packages/deploy/src/ingest.ts). Ele NUNCA volta pela API e NUNCA entra em
 * log ou auditoria — a API só conta que a credencial existe e, no máximo, os
 * 4 últimos caracteres como dica de conferência.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GIT_CREDENTIAL_USERNAME,
  type GitReadCredential,
  type ProjectCredentialInfo,
} from "@paas/core";

/** Registro persistido: metadados em claro, segredo cifrado. */
interface CredentialRecord {
  projectId: string;
  /** Últimos 4 caracteres do token — dica não sensível para o operador. */
  hint: string | null;
  updatedAt: string;
  /** Nonce da gravação (base64, 12 bytes). */
  iv: string;
  /** Tag de autenticação do GCM (base64, 16 bytes). */
  tag: string;
  /** `{ username, token }` cifrado (base64). */
  data: string;
}

interface CredentialsFile {
  credentials: CredentialRecord[];
}

const IV_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialVault {
  private readonly file: string;
  private readonly keyFile: string;
  private records: CredentialRecord[] = [];
  private loaded = false;
  private key: Buffer | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "credentials.json");
    this.keyFile = path.join(dataDir, "credentials-key");
  }

  /** Carrega (ou gera no primeiro uso) a chave do cofre. */
  async init(): Promise<void> {
    if (this.key) return;
    try {
      const raw = (await readFile(this.keyFile, "utf8")).trim();
      const chave = Buffer.from(raw, "hex");
      if (chave.length === KEY_BYTES) {
        this.key = chave;
        return;
      }
    } catch {
      // arquivo inexistente ou ilegível — gera uma nova abaixo
    }
    const gerada = randomBytes(KEY_BYTES);
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    await writeFile(this.keyFile, gerada.toString("hex") + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    this.key = gerada;
  }

  private async ensureLoaded(): Promise<void> {
    await this.init();
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<CredentialsFile>;
      this.records = Array.isArray(raw.credentials) ? raw.credentials : [];
    } catch {
      this.records = [];
    }
  }

  /** Grava (ou substitui) a credencial de leitura de um projeto. */
  async set(projectId: string, credential: GitReadCredential): Promise<ProjectCredentialInfo> {
    await this.ensureLoaded();
    const token = credential.token.trim();
    if (!token) throw new Error("Token vazio: informe o token de leitura do repositório.");
    const username = credential.username.trim() || DEFAULT_GIT_CREDENTIAL_USERNAME;

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), iv);
    const payload = Buffer.concat([
      cipher.update(JSON.stringify({ username, token }), "utf8"),
      cipher.final(),
    ]);
    const record: CredentialRecord = {
      projectId,
      hint: token.slice(-4),
      updatedAt: new Date().toISOString(),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: payload.toString("base64"),
    };
    this.records = [...this.records.filter((r) => r.projectId !== projectId), record];
    await this.persist();
    return this.infoOf(record);
  }

  /**
   * Devolve a credencial em CLARO. Uso interno (clone/fetch/pull) apenas —
   * nenhuma rota da API pode expor este retorno.
   */
  async get(projectId: string): Promise<GitReadCredential | null> {
    await this.ensureLoaded();
    const record = this.records.find((r) => r.projectId === projectId);
    if (!record) return null;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.requireKey(),
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const claro = Buffer.concat([
        decipher.update(Buffer.from(record.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(claro) as Partial<GitReadCredential>;
      if (typeof parsed.token !== "string" || !parsed.token) {
        throw new Error("conteúdo inesperado");
      }
      return {
        username: parsed.username || DEFAULT_GIT_CREDENTIAL_USERNAME,
        token: parsed.token,
      };
    } catch {
      // GCM falhou (tag/cifra adulteradas ou chave trocada). Devolver texto
      // corrompido seria pior que falhar: o git receberia lixo como senha e o
      // operador veria um erro de autenticação sem explicação.
      throw new Error(
        "Não foi possível decifrar a credencial deste projeto — o arquivo do cofre ou a chave " +
          "foram alterados. Cadastre o token de leitura novamente.",
      );
    }
  }

  /** Existe credencial para este projeto? */
  async has(projectId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.records.some((r) => r.projectId === projectId);
  }

  /** O que pode ser dito publicamente sobre a credencial (nunca o valor). */
  async info(projectId: string): Promise<ProjectCredentialInfo> {
    await this.ensureLoaded();
    const record = this.records.find((r) => r.projectId === projectId);
    if (!record) return { configured: false, hint: null, username: null, updatedAt: null };
    return this.infoOf(record);
  }

  /** Apaga a credencial. Retorna true se havia algo para apagar. */
  async remove(projectId: string): Promise<boolean> {
    await this.ensureLoaded();
    const antes = this.records.length;
    this.records = this.records.filter((r) => r.projectId !== projectId);
    if (this.records.length === antes) return false;
    await this.persist();
    return true;
  }

  /**
   * Dica pública derivada do registro. O `username` fica em claro no retorno
   * (não é segredo: no GitHub é literalmente "x-access-token"), mas em disco
   * ele também vai cifrado junto com o token.
   */
  private infoOf(record: CredentialRecord): ProjectCredentialInfo {
    return {
      configured: true,
      hint: record.hint,
      username: this.usernameEmClaro(record),
      updatedAt: record.updatedAt,
    };
  }

  private usernameEmClaro(record: CredentialRecord): string | null {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.requireKey(),
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const claro = Buffer.concat([
        decipher.update(Buffer.from(record.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(claro) as Partial<GitReadCredential>;
      return parsed.username ?? null;
    } catch {
      // info() nunca pode derrubar a listagem de projetos: sem conseguir
      // decifrar, o painel ainda sabe (e mostra) que existe uma credencial.
      return null;
    }
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error("CredentialVault não inicializado (init() não chamado).");
    return this.key;
  }

  /** Serializa as escritas para não intercalar JSON no arquivo. */
  private async persist(): Promise<void> {
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const data: CredentialsFile = { credentials: this.records };
    await writeFile(this.file, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
