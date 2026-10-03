/**
 * compose-diagnose.ts — "por que falhou" de um `docker compose up` com erro.
 *
 * Validação real (cassino, 03/10/2026): o deploy terminou com
 * "dependency failed to start: container paas-cassino-wallet-1 is unhealthy"
 * e o log do painel não dizia o que o wallet escreveu antes de ficar
 * unhealthy. Quando o `up` falha, o painel agora:
 *  1. consulta `compose ps -a` (mesmos -p/-f/--env-file do deploy);
 *  2. para cada serviço que ficou unhealthy, saiu com erro ou fica
 *     reiniciando, anexa o fim do log dele e as últimas verificações do
 *     healthcheck (`docker inspect … .State.Health`);
 *  3. devolve uma frase curta ("o serviço wallet não ficou saudável — veja o
 *     log dele acima") para a mensagem final do erro.
 *
 * O texto vem dos containers (não confiável): passa por sanitizeLogBlock (sem
 * cores nem caracteres de controle, linhas e total limitados).
 */
import { parse } from "yaml";
import type { ExecResult } from "./exec.js";

/**
 * Serviços que o `up` sobe: os declarados, menos os de `profiles` (só sobem
 * com --profile, que o painel não passa) — esses não contam como "não criado".
 */
export function startableServices(composeContent: string): string[] {
  let doc: { services?: unknown } | null;
  try {
    doc = parse(composeContent) as { services?: unknown } | null;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];
  return Object.entries(services as Record<string, unknown>)
    .filter(([, svc]) => !(svc && typeof svc === "object" && "profiles" in svc))
    .map(([name]) => name);
}

export type ComposeRunner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Linhas do fim do log de cada serviço com problema. */
export const DIAGNOSE_LOG_TAIL = 80;
/** Verificações do healthcheck mostradas (as mais recentes). */
const HEALTH_ENTRIES = 3;
const MAX_LINE = 1_000;
const MAX_SERVICE_LOG = 8_000;
const MAX_HEALTH_OUTPUT = 500;
const MAX_TOTAL = 30_000;

export interface ComposePsEntry {
  service: string;
  name: string;
  /** running, exited, created, restarting, dead, paused… */
  state: string;
  /** healthy, unhealthy, starting ou "" (sem healthcheck) */
  health: string;
  exitCode: number | null;
}

export type ServiceFailureKind = "unhealthy" | "exited" | "restarting" | "not-started" | "missing";

export interface ServiceFailure {
  service: string;
  container: string | null;
  kind: ServiceFailureKind;
  exitCode: number | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toEntry(raw: unknown): ComposePsEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const service = str(o.Service);
  if (!service) return null;
  return {
    service,
    name: str(o.Name),
    state: str(o.State).toLowerCase(),
    health: str(o.Health).toLowerCase(),
    exitCode: typeof o.ExitCode === "number" ? o.ExitCode : null,
  };
}

/**
 * Saída de `compose ps -a --format json`: array JSON (compose < 2.21) ou um
 * objeto por linha (NDJSON, compose ≥ 2.21). Linhas inválidas são ignoradas.
 */
export function parseComposePs(stdout: string): ComposePsEntry[] {
  const text = stdout.trim();
  if (!text) return [];
  const raws: unknown[] = [];
  for (const line of text.split("\n")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) raws.push(...parsed);
      else raws.push(parsed);
    } catch {
      /* linha que não é JSON (aviso do compose): ignorada */
    }
  }
  return raws.map(toEntry).filter((e): e is ComposePsEntry => e !== null);
}

/**
 * Serviços com problema: primeiro os que falharam de fato (unhealthy, saíram
 * com erro, reiniciando), na ordem do ps; depois os que só não chegaram a
 * iniciar (esperavam um serviço que falhou) e os declarados que nem foram
 * criados. Saída com código 0 é tarefa que terminou (migração), não falha.
 */
export function failedServices(entries: ComposePsEntry[], declared: string[]): ServiceFailure[] {
  const primary: ServiceFailure[] = [];
  const waiting: ServiceFailure[] = [];
  for (const e of entries) {
    const base = { service: e.service, container: e.name || null, exitCode: e.exitCode };
    if (e.health === "unhealthy") primary.push({ ...base, kind: "unhealthy" });
    else if (e.state === "restarting") primary.push({ ...base, kind: "restarting" });
    else if (e.state === "dead" || (e.state === "exited" && e.exitCode !== 0)) primary.push({ ...base, kind: "exited" });
    else if (e.state === "created") waiting.push({ ...base, kind: "not-started" });
  }
  const seen = new Set(entries.map((e) => e.service));
  const missing = declared
    .filter((s) => !seen.has(s))
    .map((service): ServiceFailure => ({ service, container: null, kind: "missing", exitCode: null }));
  return [...primary, ...waiting, ...missing];
}

function describeFailure(f: ServiceFailure): string {
  switch (f.kind) {
    case "unhealthy":
      return `o serviço ${f.service} não ficou saudável`;
    case "restarting":
      return `o serviço ${f.service} fica reiniciando sem parar`;
    default:
      return `o serviço ${f.service} parou com erro${f.exitCode !== null ? ` (código ${f.exitCode})` : ""}`;
  }
}

function isPrimary(f: ServiceFailure): boolean {
  return f.kind === "unhealthy" || f.kind === "exited" || f.kind === "restarting";
}

/** Frase curta para a mensagem final do deploy. "" quando não há o que dizer. */
export function failureSummary(failures: ServiceFailure[]): string {
  const primary = failures.filter(isPrimary);
  if (primary.length > 0) {
    return `${primary.map(describeFailure).join("; ")} — veja o log ${primary.length === 1 ? "dele" : "deles"} acima`;
  }
  if (failures.length === 0) return "";
  const names = failures.map((f) => f.service);
  return names.length === 1
    ? `o serviço ${names[0]} não chegou a iniciar`
    : `os serviços ${names.join(", ")} não chegaram a iniciar`;
}

/**
 * Texto de container para o log do deploy: sem sequências ANSI nem
 * caracteres de controle (mantém quebra de linha e tab), cada linha limitada
 * e, no total, só o FIM (é onde está o erro).
 */
export function sanitizeLogBlock(text: string, max = MAX_SERVICE_LOG): string {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
  const joined = lines.join("\n").replace(/\n+$/, "");
  return joined.length > max ? `…${joined.slice(joined.length - max)}` : joined;
}

interface HealthLogEntry {
  ExitCode?: unknown;
  Output?: unknown;
}

function healthLines(stdout: string): string[] {
  let health: { Log?: unknown } | null;
  try {
    health = JSON.parse(stdout.trim()) as { Log?: unknown } | null;
  } catch {
    return [];
  }
  const log = Array.isArray(health?.Log) ? (health.Log as HealthLogEntry[]) : [];
  return log.slice(-HEALTH_ENTRIES).map((entry) => {
    const code = typeof entry.ExitCode === "number" ? entry.ExitCode : "?";
    const output = sanitizeLogBlock(str(entry.Output), MAX_HEALTH_OUTPUT).replace(/\n/g, " ").trim();
    return `  · código ${code}: ${output || "(sem saída)"}`;
  });
}

async function serviceBlock(base: string[], f: ServiceFailure, run: ComposeRunner): Promise<string> {
  let block = `\n=== Por que falhou: serviço ${f.service} ===\n${describeFailure(f)}.\n`;
  const logs = await run("docker", [...base, "logs", "--no-color", "--tail", String(DIAGNOSE_LOG_TAIL), f.service], {
    timeoutMs: 30_000,
  });
  if (logs.code !== 0) {
    block += `(não foi possível ler o log (${sanitizeLogBlock(logs.stderr, 300).replace(/\n/g, " ")}))\n`;
  } else {
    const text = sanitizeLogBlock(`${logs.stdout}${logs.stderr}`);
    block += `Últimas linhas do log:\n${text || "(o serviço não escreveu nada no log)"}\n`;
  }
  if (f.container) {
    const inspect = await run("docker", ["inspect", "--format", "{{json .State.Health}}", f.container], {
      timeoutMs: 15_000,
    });
    const lines = inspect.code === 0 ? healthLines(inspect.stdout) : [];
    if (lines.length > 0) block += `Healthcheck (últimas verificações):\n${lines.join("\n")}\n`;
  }
  return block;
}

/**
 * Consulta o estado dos serviços depois de um `up` com erro, escreve o
 * diagnóstico no log e devolve o resumo (ou null quando não achou culpado).
 * `base` = argumentos do compose do deploy (`compose -p … --env-file … -f …`).
 */
export async function diagnoseComposeFailure(
  base: string[],
  declared: string[],
  onLog: (chunk: string) => void,
  run: ComposeRunner,
): Promise<string | null> {
  const ps = await run("docker", [...base, "ps", "-a", "--format", "json"], { timeoutMs: 30_000 });
  if (ps.code !== 0) {
    onLog(
      `\n(não foi possível consultar o estado dos serviços (${sanitizeLogBlock(ps.stderr, 300).replace(/\n/g, " ")}))\n`,
    );
    return null;
  }
  const failures = failedServices(parseComposePs(ps.stdout), declared);
  if (failures.length === 0) return null;

  let total = 0;
  for (const f of failures.filter(isPrimary)) {
    if (total >= MAX_TOTAL) {
      onLog(`\n(diagnóstico encurtado: o log de ${f.service} e dos seguintes ficou de fora)\n`);
      break;
    }
    const block = await serviceBlock(base, f, run);
    total += block.length;
    onLog(block);
  }
  const others = failures.filter((f) => !isPrimary(f));
  if (others.length > 0) {
    onLog(
      `\nOutros serviços:\n${others
        .map((f) => `  · ${f.service}: ${f.kind === "missing" ? "não foi criado" : "não chegou a iniciar"} (provavelmente esperava um serviço que falhou)`)
        .join("\n")}\n`,
    );
  }
  return failureSummary(failures);
}
