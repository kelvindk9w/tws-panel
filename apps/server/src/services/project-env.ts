/**
 * project-env.ts — variáveis de ambiente dos projetos (seção Variáveis).
 *
 * Valores costumam ser segredos (senha de banco, chave de API): em disco ficam
 * CIFRADOS (AES-256-GCM, chave em data/project-env-key, 0600, arquivo próprio
 * — mesmo padrão do cofre de credenciais). São injetados no próximo deploy
 * (Dockerfile: -e; compose: override) e nunca vão para log nem auditoria —
 * só os nomes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpError } from "./http-error.js";

export interface EnvVar {
  key: string;
  value: string;
}

interface EnvRecord {
  projectId: string;
  updatedAt: string;
  iv: string;
  tag: string;
  /** EnvVar[] cifrado (base64). */
  data: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ENV_MAX_VARS = 200;
const ENV_MAX_VALUE = 32 * 1024;

function validate(vars: EnvVar[]): EnvVar[] {
  if (vars.length > ENV_MAX_VARS) throw httpError(400, "too_many_env_vars", `No máximo ${ENV_MAX_VARS} variáveis.`);
  const seen = new Set<string>();
  return vars.map(({ key, value }) => {
    const k = key.trim();
    if (!KEY_RE.test(k)) {
      throw httpError(
        400,
        "invalid_env_key",
        `Nome inválido: "${k.slice(0, 60)}". Use letras, números e _ (sem começar com número), ex.: DATABASE_URL.`,
      );
    }
    if (seen.has(k)) throw httpError(400, "duplicate_env_key", `A variável ${k} aparece mais de uma vez.`);
    seen.add(k);
    if (value.includes("\0") || value.length > ENV_MAX_VALUE) {
      throw httpError(400, "invalid_env_value", `Valor inválido em ${k} (muito longo ou com caractere nulo).`);
    }
    return { key: k, value };
  });
}

export class ProjectEnvStore {
  private readonly file: string;
  private readonly keyFile: string;
  private key: Buffer | null = null;
  private records: EnvRecord[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "project-env.json");
    this.keyFile = path.join(dataDir, "project-env-key");
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    try {
      const raw = Buffer.from((await readFile(this.keyFile, "utf8")).trim(), "hex");
      if (raw.length === 32) return (this.key = raw);
    } catch {
      // primeira vez — gera abaixo
    }
    const gerada = randomBytes(32);
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    await writeFile(this.keyFile, gerada.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    return (this.key = gerada);
  }

  private async load(): Promise<EnvRecord[]> {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { projects?: EnvRecord[] };
      this.records = Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  private persist(records: EnvRecord[]): Promise<void> {
    const run = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify({ projects: records }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      this.records = records;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  async get(projectId: string): Promise<EnvVar[]> {
    const record = (await this.load()).find((r) => r.projectId === projectId);
    if (!record) return [];
    const decipher = createDecipheriv("aes-256-gcm", await this.loadKey(), Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as EnvVar[];
  }

  async asRecord(projectId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.get(projectId)).map((v) => [v.key, v.value]));
  }

  /** Substitui a lista inteira do projeto (variável que saiu da lista é apagada). */
  async set(projectId: string, vars: EnvVar[]): Promise<EnvVar[]> {
    const clean = validate(vars);
    const others = (await this.load()).filter((r) => r.projectId !== projectId);
    if (clean.length === 0) {
      await this.persist(others);
      return [];
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.loadKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(clean), "utf8"), cipher.final()]);
    await this.persist([
      ...others,
      {
        projectId,
        updatedAt: new Date().toISOString(),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      },
    ]);
    return clean;
  }

  async remove(projectId: string): Promise<void> {
    const records = await this.load();
    if (records.some((r) => r.projectId === projectId)) {
      await this.persist(records.filter((r) => r.projectId !== projectId));
    }
  }
}
