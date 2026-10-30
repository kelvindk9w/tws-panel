/**
 * laravel-queue.ts — avisos de Laravel que explicam "o e-mail não chegou" e "o erro não aparece nos Logs":
 *
 *  - fila sem worker: QUEUE_CONNECTION diferente de `sync` e nenhum processo `queue:work`/`queue:listen`/`horizon`
 *    em lugar nenhum do projeto → e-mails e tarefas enfileirados ficam parados para sempre;
 *  - mailer que não envia: MAIL_MAILER `log` ou `array` (o e-mail é escrito num arquivo ou descartado);
 *  - LOG_CHANNEL: sem `stderr` (ou `stack` que o inclui) as exceções vão para storage/logs e a aba Logs não as vê.
 *
 * Só avisa com CONFIANÇA. O valor vem das Variáveis do projeto (o `.env` do repositório não vai para o container).
 * Quando a variável não está definida, o padrão é o do próprio projeto: `config/queue.php`, `config/mail.php` e
 * `config/logging.php` (Laravel 11 mudou os padrões de fila para `database` e de e-mail para `log`). Se o arquivo não
 * for encontrado ou tiver outro formato, nada é afirmado.
 *
 * A busca pelo worker olha o compose, Dockerfiles, supervisor e scripts da raiz e de pastas conhecidas (não o
 * composer.json: o script `dev` do esqueleto do Laravel usa queue:listen e enganaria a conferência).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ProjectNotice } from "@paas/core";
import { readRegularFileLimited } from "./safe-fs.js";

export const QUEUE_WORKER_RE = /\bqueue:(?:work|listen)\b|\bhorizon\b/;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 80;
/** Níveis de subpasta abaixo de cada pasta conhecida (docker/php/supervisor/conf.d = 3). */
const MAX_DEPTH = 3;
const WORKER_FILE_RE = /(^dockerfile|dockerfile$|\.(conf|ini|sh|ya?ml|toml)$|^procfile$|supervis)/i;
/** Pastas conhecidas onde se costuma pôr Dockerfile, supervisor e scripts de entrada. */
const WORKER_DIRS = ["docker", ".docker", "deploy", "deployment", "infra", "supervisor", "supervisord", "devops", ".deploy", "scripts", "bin", "build"];

/** Leitura limitada e sem seguir link simbólico (o repositório é de terceiros). */
async function readSmall(file: string): Promise<string | null> {
  return (await readRegularFileLimited(file, MAX_FILE_BYTES)) ?? null;
}

/** Arquivos candidatos: os da raiz e, até MAX_DEPTH níveis, os das pastas conhecidas (links simbólicos ficam de fora). */
async function candidateFiles(srcDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && WORKER_FILE_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < MAX_DEPTH) await walk(full, depth + 1);
    }
  };
  let rootEntries;
  try {
    rootEntries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of rootEntries) if (e.isFile() && WORKER_FILE_RE.test(e.name)) out.push(path.join(srcDir, e.name));
  for (const dir of WORKER_DIRS) await walk(path.join(srcDir, dir), 0);
  return out;
}

/** Algum arquivo do projeto (compose, Dockerfile, supervisor, scripts) sobe um worker de fila? */
export async function hasQueueWorker(srcDir: string, composeFile: string | null): Promise<boolean> {
  const files = new Set<string>();
  if (composeFile) files.add(path.join(srcDir, composeFile));
  for (const f of await candidateFiles(srcDir)) files.add(f);
  let read = 0;
  for (const file of files) {
    if (read++ >= MAX_FILES) break;
    const text = await readSmall(file);
    if (text !== null && QUEUE_WORKER_RE.test(text)) return true;
  }
  return false;
}

const FILE_ENV_NAMES = new Set(["QUEUE_CONNECTION", "MAIL_MAILER", "LOG_CHANNEL", "LOG_STACK"]);

/** `${NOME:-padrão}` → padrão; `${NOME}` sem padrão e qualquer outra interpolação → null (não dá para saber). */
function literalValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  const m = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}$/.exec(v);
  if (m) return m[1]!.trim() || null;
  return v && !v.includes("$") ? v : null;
}

function takeEnv(out: Record<string, string>, name: string, value: unknown): void {
  if (!FILE_ENV_NAMES.has(name) || name in out) return;
  const v = literalValue(value);
  if (v !== null) out[name] = v;
}

function dotenvInto(out: Record<string, string>, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) takeEnv(out, m[1]!, m[2]!.replace(/\s+#.*$/, ""));
  }
}

function dockerfileInto(out: Record<string, string>, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*ENV\s+(.+)$/i.exec(line);
    if (!m) continue;
    const body = m[1]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(body)) {
      for (const pair of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)) takeEnv(out, pair[1]!, pair[2]);
    } else {
      const [name, ...rest] = body.split(/\s+/);
      takeEnv(out, name!, rest.join(" "));
    }
  }
}

/**
 * Valores de QUEUE_CONNECTION, MAIL_MAILER, LOG_CHANNEL e LOG_STACK que o PROJETO já define para o container, fora das
 * Variáveis do painel: `environment:` do compose, `env_file:` e `ENV` dos Dockerfiles. Prioridade: environment >
 * env_file > Dockerfile. Só valores literais (interpolação sem padrão é ignorada). Nunca lança.
 */
export async function readProjectFileEnv(srcDir: string, composeFile: string | null): Promise<Record<string, string>> {
  const fromEnvironment: Record<string, string> = {};
  const fromEnvFile: Record<string, string> = {};
  const fromDockerfile: Record<string, string> = {};

  const composeText = composeFile ? await readSmall(path.join(srcDir, composeFile)) : null;
  type ComposeDoc = { services?: Record<string, { environment?: unknown; env_file?: unknown } | null> } | null;
  let doc: ComposeDoc = null;
  try {
    doc = composeText ? (parse(composeText) as ComposeDoc) : null;
  } catch {
    doc = null; // compose inválido: o resto (Dockerfile) ainda vale
  }

  for (const def of Object.values(doc?.services ?? {})) {
    const environment = def?.environment;
    if (Array.isArray(environment)) {
      for (const item of environment) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(String(item));
        if (m) takeEnv(fromEnvironment, m[1]!, m[2]);
      }
    } else if (environment && typeof environment === "object") {
      for (const [k, v] of Object.entries(environment)) takeEnv(fromEnvironment, k, v);
    }
    const files: unknown[] = Array.isArray(def?.env_file) ? def.env_file : def?.env_file ? [def.env_file] : [];
    for (const f of files) {
      const rel = typeof f === "string" ? f : typeof f === "object" && f !== null ? (f as { path?: unknown }).path : null;
      if (typeof rel !== "string" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
      const text = await readSmall(path.join(srcDir, rel));
      if (text) dotenvInto(fromEnvFile, text);
    }
  }

  for (const file of await candidateFiles(srcDir)) {
    if (!/dockerfile/i.test(path.basename(file))) continue;
    const text = await readSmall(file);
    if (text) dockerfileInto(fromDockerfile, text);
  }
  return { ...fromDockerfile, ...fromEnvFile, ...fromEnvironment };
}

export interface LaravelDefaults {
  /** `env('QUEUE_CONNECTION', '<padrão>')` de config/queue.php; null = não achei. */
  queue: string | null;
  /** `env('MAIL_MAILER', '<padrão>')` de config/mail.php. */
  mail: string | null;
  /** `env('LOG_CHANNEL', '<padrão>')` de config/logging.php. */
  log: string | null;
}

function envDefault(text: string | null, name: string): string | null {
  if (text === null) return null;
  const m = new RegExp(`env\\(\\s*['"]${name}['"]\\s*,\\s*['"]([A-Za-z0-9_-]{1,40})['"]\\s*\\)`).exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** Padrões do projeto para as três variáveis, lidos dos arquivos de configuração. */
export async function readLaravelDefaults(srcDir: string): Promise<LaravelDefaults> {
  const [queue, mail, log] = await Promise.all(["queue", "mail", "logging"].map((name) => readSmall(path.join(srcDir, "config", `${name}.php`))));
  return { queue: envDefault(queue!, "QUEUE_CONNECTION"), mail: envDefault(mail!, "MAIL_MAILER"), log: envDefault(log!, "LOG_CHANNEL") };
}

export interface LaravelFacts {
  /** Variáveis do projeto (nome → valor). */
  env: Readonly<Record<string, string>>;
  defaults: LaravelDefaults;
  hasWorker: boolean;
  /** Valores definidos pelo próprio projeto (compose, env_file, Dockerfile); valem abaixo das Variáveis do painel. */
  fileEnv?: Readonly<Record<string, string>>;
}

const norm = (v: string | undefined): string | null => {
  const t = v?.trim().toLowerCase();
  return t ? t : null;
};

/** Valor efetivo: o das Variáveis; sem ele, o padrão do projeto (null = não dá para saber). */
export function effectiveSetting(facts: LaravelFacts, name: string, fallback: string | null): string | null {
  return norm(facts.env[name]) ?? norm(facts.fileEnv?.[name]) ?? fallback;
}

/** Fila que precisa de worker e não tem. */
export function queueWithoutWorker(facts: LaravelFacts): boolean {
  const queue = effectiveSetting(facts, "QUEUE_CONNECTION", facts.defaults.queue);
  if (queue === null || queue === "sync" || queue === "null") return false;
  return !facts.hasWorker;
}

/** O mailer efetivo escreve em arquivo ou descarta (`log`, `array`)? Devolve o valor, ou null. */
export function silentMailer(facts: LaravelFacts): "log" | "array" | null {
  const mailer = effectiveSetting(facts, "MAIL_MAILER", facts.defaults.mail);
  return mailer === "log" || mailer === "array" ? mailer : null;
}

/** Avisos do projeto. Só chamar para projeto Laravel. */
export function laravelNotices(facts: LaravelFacts): ProjectNotice[] {
  const notices: ProjectNotice[] = [];
  if (queueWithoutWorker(facts)) notices.push({ code: "queue_no_worker", severity: "warning" });
  const log = effectiveSetting(facts, "LOG_CHANNEL", facts.defaults.log);
  // `stack` pode incluir stderr (LOG_STACK); só sugere quando o canal é o de arquivo e nada foi definido.
  if (effectiveSetting(facts, "LOG_STACK", null) === null && (norm(facts.env.LOG_CHANNEL) ?? norm(facts.fileEnv?.LOG_CHANNEL)) === null && log !== "stderr" && log !== "errorlog" && log !== "syslog") {
    notices.push({ code: "log_channel_stderr", severity: "info" });
  }
  return notices;
}
