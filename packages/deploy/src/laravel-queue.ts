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
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectNotice } from "@paas/core";

export const QUEUE_WORKER_RE = /\bqueue:(?:work|listen)\b|\bhorizon\b/;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 60;
const WORKER_FILE_RE = /(^dockerfile|dockerfile$|\.(conf|ini|sh|ya?ml|toml)$|^procfile$|supervis)/i;
const WORKER_DIRS = ["", "docker", ".docker", "deploy", "deployment", "infra", "supervisor", "devops", ".deploy"];

async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Algum arquivo do projeto (compose, Dockerfile, supervisor, scripts) sobe um worker de fila? */
export async function hasQueueWorker(srcDir: string, composeFile: string | null): Promise<boolean> {
  const files = new Set<string>();
  if (composeFile) files.add(path.join(srcDir, composeFile));
  for (const dir of WORKER_DIRS) {
    let names: string[];
    try {
      names = await readdir(path.join(srcDir, dir));
    } catch {
      continue;
    }
    for (const name of names) if (WORKER_FILE_RE.test(name)) files.add(path.join(srcDir, dir, name));
  }
  let read = 0;
  for (const file of files) {
    if (read++ >= MAX_FILES) break;
    const text = await readSmall(file);
    if (text !== null && QUEUE_WORKER_RE.test(text)) return true;
  }
  return false;
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
  const [queue, mail, log] = await Promise.all(
    ["queue", "mail", "logging"].map((name) => readSmall(path.join(srcDir, "config", `${name}.php`))),
  );
  return { queue: envDefault(queue!, "QUEUE_CONNECTION"), mail: envDefault(mail!, "MAIL_MAILER"), log: envDefault(log!, "LOG_CHANNEL") };
}

export interface LaravelFacts {
  /** Variáveis do projeto (nome → valor). */
  env: Readonly<Record<string, string>>;
  defaults: LaravelDefaults;
  hasWorker: boolean;
}

const norm = (v: string | undefined): string | null => {
  const t = v?.trim().toLowerCase();
  return t ? t : null;
};

/** Valor efetivo: o das Variáveis; sem ele, o padrão do projeto (null = não dá para saber). */
export function effectiveSetting(facts: LaravelFacts, name: string, fallback: string | null): string | null {
  return norm(facts.env[name]) ?? fallback;
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
  if (norm(facts.env.LOG_CHANNEL) === null && norm(facts.env.LOG_STACK) === null && log !== "stderr" && log !== "errorlog" && log !== "syslog") {
    notices.push({ code: "log_channel_stderr", severity: "info" });
  }
  return notices;
}
