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
import path from "node:path";
import { buildVarProblem } from "@paas/deploy";
import { httpError } from "./http-error.js";
import { JsonFile, loadOrCreateKey } from "./json-file.js";

export interface EnvVar {
  key: string;
  value: string;
  /**
   * Variável "de build": pública (vai para o JavaScript do site), passada ao build estático e ao
   * `docker build`. Só vale `true` quando a pessoa marcou; ausente = não entra no build.
   */
  build?: boolean;
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
/** Um .env real passa de 200 (o dono tem ~260); o teto só barra abuso. */
export const ENV_MAX_VARS = 1000;
const ENV_MAX_VALUE = 32 * 1024;

function validate(vars: EnvVar[]): EnvVar[] {
  if (vars.length > ENV_MAX_VARS) throw httpError(400, "too_many_env_vars", `No máximo ${ENV_MAX_VARS} variáveis.`);
  const seen = new Set<string>();
  return vars.map(({ key, value, build }) => {
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
    // "De build" com nome reservado ou valor que o build não aceita NÃO bloqueia o salvar: o dado é válido e o deploy já
    // deixa essa variável de fora do build (selectBuildVars) avisando no log. A tela mostra o aviso (buildVarIssues).
    if (build === true) return { key: k, value, build: true };
    return { key: k, value };
  });
}

/** Marcadas "de build" que o build não vai receber (nome reservado, valor com quebra de linha…): só nomes e motivo. */
export function buildVarIssues(vars: readonly EnvVar[]): Array<{ name: string; reason: string }> {
  return vars.flatMap((v) => {
    const reason = v.build === true ? buildVarProblem(v.key, v.value) : null;
    return reason ? [{ name: v.key, reason }] : [];
  });
}

/**
 * Toda alteração é ler → alterar → cifrar → gravar DENTRO da fila do
 * project-env.json (services/json-file.ts): duas gravações paralelas (duas
 * abas, ou salvar enquanto outro projeto é excluído) nunca partem da mesma
 * leitura. A chave é criada uma vez só, com criação exclusiva do arquivo.
 */
export class ProjectEnvStore {
  private readonly json: JsonFile<EnvRecord[]>;
  private readonly keyFile: string;
  private keyLoading: Promise<Buffer> | null = null;

  constructor(dataDir: string) {
    this.json = new JsonFile<EnvRecord[]>(path.join(dataDir, "project-env.json"), {
      empty: () => [],
      parse: (raw) => {
        const projects = (raw as { projects?: unknown } | null)?.projects;
        return Array.isArray(projects) ? (projects as EnvRecord[]) : null;
      },
      serialize: (projects) => JSON.stringify({ projects }, null, 2) + "\n",
    });
    this.keyFile = path.join(dataDir, "project-env-key");
  }

  /** Chave de cifra: lida (ou criada) uma vez só (services/json-file.ts). */
  private loadKey(): Promise<Buffer> {
    this.keyLoading ??= loadOrCreateKey(this.keyFile, 32, { log: (m) => console.warn(m) }).catch((err: unknown) => {
      this.keyLoading = null;
      throw err;
    });
    return this.keyLoading;
  }

  private decrypt(record: EnvRecord, key: Buffer): EnvVar[] {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as EnvVar[];
  }

  private encrypt(projectId: string, clean: EnvVar[], key: Buffer): EnvRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(clean), "utf8"), cipher.final()]);
    return {
      projectId,
      updatedAt: new Date().toISOString(),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  async get(projectId: string): Promise<EnvVar[]> {
    const record = (await this.json.read()).find((r) => r.projectId === projectId);
    if (!record) return [];
    return this.decrypt(record, await this.loadKey());
  }

  /** Só as marcadas como "de build" (nome → valor). */
  async buildRecord(projectId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.get(projectId)).filter((v) => v.build === true).map((v) => [v.key, v.value]));
  }

  async asRecord(projectId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.get(projectId)).map((v) => [v.key, v.value]));
  }

  /** Substitui a lista inteira do projeto (variável que saiu da lista é apagada). */
  async set(projectId: string, vars: EnvVar[]): Promise<EnvVar[]> {
    const clean = validate(vars);
    const key = clean.length > 0 ? await this.loadKey() : null;
    await this.json.update((records) => {
      const others = records.filter((r) => r.projectId !== projectId);
      if (!key) return others.length === records.length ? records : others;
      return [...others, this.encrypt(projectId, clean, key)];
    });
    return clean;
  }

  /**
   * Acrescenta ou troca as variáveis informadas e mantém todas as outras, DENTRO da fila do arquivo (ler, mesclar
   * e gravar numa transação só): uma pessoa que salva outra variável ao mesmo tempo nunca é desfeita por esta
   * mescla. Nunca apaga. `allowOverwrite: false` recusa (409 `env_changed`) trocar ou esvaziar uma variável que
   * já tem valor diferente: quem chama já decidiu, com base no que viu, que só estava criando variáveis novas.
   */
  async merge(projectId: string, incoming: EnvVar[], opts: { allowOverwrite: boolean }): Promise<EnvVar[]> {
    const fresh = validate(incoming);
    const key = await this.loadKey();
    let result: EnvVar[] = [];
    await this.json.update((records) => {
      const record = records.find((r) => r.projectId === projectId);
      const map = new Map((record ? this.decrypt(record, key) : []).map((v) => [v.key, v]));
      if (!opts.allowOverwrite) {
        for (const v of fresh) {
          const current = map.get(v.key)?.value;
          if (current !== undefined && current !== "" && current !== v.value) {
            throw httpError(409, "env_changed", `A variável ${v.key} já tem valor e foi mantida: trocar ou esvaziar uma variável existente pede a aprovação de uma pessoa.`);
          }
        }
      }
      // A marca "de build" de quem já existe é preservada (quem chama, como o MCP, não a conhece nem a muda); `build: true`
      // informado marca a variável. Quem quiser tirar a marca usa setEnv (a tela). Variável nova entra sem marca.
      for (const v of fresh) {
        const keepBuild = v.build ?? map.get(v.key)?.build;
        map.set(v.key, keepBuild === true ? { key: v.key, value: v.value, build: true } : { key: v.key, value: v.value });
      }
      result = validate([...map.values()]);
      return [...records.filter((r) => r.projectId !== projectId), this.encrypt(projectId, result, key)];
    });
    return result;
  }

  async remove(projectId: string): Promise<void> {
    await this.json.update((records) => {
      const others = records.filter((r) => r.projectId !== projectId);
      return others.length === records.length ? records : others;
    });
  }
}
