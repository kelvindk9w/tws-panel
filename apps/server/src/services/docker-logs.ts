/**
 * docker-logs.ts — logs e estado de UM container pela Docker Engine API
 * (unix socket). Somente leitura (GET).
 *
 * Por que a API e não `docker logs`: o CLI joga stdout num fluxo e stderr em
 * outro, e a ordem entre os dois se perde. A API devolve um fluxo único,
 * em quadros de 8 bytes de cabeçalho (tipo + tamanho) quando o container não
 * tem TTY — dá para marcar qual é stdout/stderr e manter a ordem.
 *
 * O id do container vem sempre da listagem do próprio painel (docker-service),
 * nunca do pedido; mesmo assim só passa se for hexadecimal curto/longo, para
 * que nada que não seja um id vire pedaço do caminho da API.
 */
import http from "node:http";
import type { ProjectLogStream } from "@paas/core";

/** Mais que isto numa resposta de log = o serviço escreve demais para a janela pedida. */
export const DOCKER_LOGS_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ID_RE = /^[0-9a-f]{12,64}$/;
const INSPECT_MAX_BYTES = 1024 * 1024;

export type GetResult = { ok: true; status: number; body: Buffer } | { ok: false; reason: "unavailable" | "too_large" };

export function dockerGet(socketPath: string, pathAndQuery: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<GetResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // Pedido cancelado (cliente fechou a conexão): derruba a requisição ao Docker na hora.
    function onAbort() {
      done({ ok: false, reason: "unavailable" });
      req.destroy();
    }
    const req = http.request({ socketPath, method: "GET", path: pathAndQuery }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          done({ ok: false, reason: "too_large" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => done({ ok: true, status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", () => done({ ok: false, reason: "unavailable" }));
    });
    // Prazo para a resposta INTEIRA (um log que escorre devagar também para).
    const timer = setTimeout(() => {
      done({ ok: false, reason: "unavailable" });
      req.destroy();
    }, timeoutMs);
    req.on("error", () => done({ ok: false, reason: "unavailable" }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

export type DockerLogsResult = { ok: true; body: Buffer } | { ok: false; reason: "unavailable" | "too_large" };

export interface DockerLogsOptions {
  tail: number;
  /** Segundos desde a época; null = sem limite de início. */
  sinceSeconds: number | null;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Corpo cru de `GET /containers/:id/logs` (stdout+stderr, com horário, só o fim). */
export async function dockerLogs(socketPath: string, id: string, opts: DockerLogsOptions): Promise<DockerLogsResult> {
  if (!ID_RE.test(id)) return { ok: false, reason: "unavailable" };
  const query = `stdout=1&stderr=1&timestamps=1&tail=${Math.trunc(opts.tail)}${opts.sinceSeconds === null ? "" : `&since=${Math.trunc(opts.sinceSeconds)}`}`;
  const r = await dockerGet(socketPath, `/containers/${id}/logs?${query}`, opts.maxBytes ?? DOCKER_LOGS_MAX_BYTES, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  if (!r.ok) return r;
  return r.status === 200 ? { ok: true, body: r.body } : { ok: false, reason: "unavailable" };
}

export interface ContainerRuntime {
  /** running, exited, restarting, paused, created, dead; "unknown" se o Docker não disse. */
  state: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  restartCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  tty: boolean;
  /** PID do processo principal no host (State.Pid); null = parado ou o Docker não disse. */
  pid?: number | null;
  /** O último encerramento foi por falta de memória (State.OOMKilled). */
  oomKilled?: boolean;
  /** Política de reinício (HostConfig.RestartPolicy.Name): "no", "always", "on-failure", "unless-stopped"; null = o Docker não disse. */
  restartPolicy?: string | null;
  /** Fim da primeira verificação de saúde que passou desde o início atual (State.Health.Log); null = nenhuma no registro. */
  healthyAt?: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** O Docker usa 0001-01-01 para "nunca". */
const when = (v: unknown): string | null => {
  const s = str(v);
  return s === null || s.startsWith("0001-01-01") ? null : s;
};

/** `GET /containers/:id/json` → o que a aba Logs mostra do serviço; null se não deu para consultar. */
export async function dockerInspect(socketPath: string, id: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<ContainerRuntime | null> {
  if (!ID_RE.test(id)) return null;
  const r = await dockerGet(socketPath, `/containers/${id}/json`, INSPECT_MAX_BYTES, timeoutMs, signal);
  if (!r.ok || r.status !== 200) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(r.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as {
    RestartCount?: unknown;
    Config?: { Tty?: unknown } | null;
    State?: Record<string, unknown> | null;
    HostConfig?: { RestartPolicy?: { Name?: unknown } | null } | null;
  };
  const s = d.State ?? {};
  const health = (s.Health as { Status?: unknown } | undefined)?.Status;
  return {
    state: str(s.Status) ?? "unknown",
    health: health === "healthy" || health === "unhealthy" || health === "starting" ? health : null,
    restartCount: num(d.RestartCount),
    startedAt: when(s.StartedAt),
    finishedAt: when(s.FinishedAt),
    exitCode: num(s.ExitCode),
    tty: d.Config?.Tty === true,
    pid: typeof s.Pid === "number" && Number.isSafeInteger(s.Pid) && s.Pid > 0 ? s.Pid : null,
    oomKilled: s.OOMKilled === true,
    restartPolicy: str(d.HostConfig?.RestartPolicy?.Name) ?? (d.HostConfig?.RestartPolicy ? "no" : null),
    healthyAt: firstHealthyAt((s.Health as { Log?: unknown } | undefined)?.Log, when(s.StartedAt)),
  };
}

/** Fim da primeira verificação de saúde bem-sucedida (ExitCode 0) depois de `startedAt`; null se o registro não a tem mais. */
function firstHealthyAt(log: unknown, startedAt: string | null): string | null {
  if (!Array.isArray(log)) return null;
  const from = startedAt === null ? Number.NaN : Date.parse(startedAt);
  let best: { ms: number; iso: string } | null = null;
  for (const entry of log.slice(0, 20)) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { ExitCode?: unknown; End?: unknown };
    const end = when(e.End);
    if (e.ExitCode !== 0 || end === null) continue;
    const ms = Date.parse(end);
    if (!Number.isFinite(ms) || (Number.isFinite(from) && ms < from)) continue;
    if (best === null || ms < best.ms) best = { ms, iso: end };
  }
  return best?.iso ?? null;
}

export interface RawLogLine {
  stream: ProjectLogStream;
  text: string;
}

function splitLines(payload: string, stream: ProjectLogStream, out: RawLogLine[]): void {
  const parts = payload.split("\n");
  // o "\n" final gera um pedaço vazio que não é uma linha do app
  if (parts.at(-1) === "") parts.pop();
  for (const p of parts) out.push({ stream, text: p.replace(/\r$/, "") });
}

/**
 * Corpo de `/logs` → linhas. Sem TTY vem em quadros [tipo, 0, 0, 0, tamanho
 * (4 bytes)] + conteúdo (1 = stdout, 2 = stderr); com TTY é texto cru. Quadro
 * cortado no fim (resposta interrompida) é descartado.
 */
export function demuxLogStream(buf: Buffer, tty: boolean): RawLogLine[] {
  const out: RawLogLine[] = [];
  if (tty) {
    if (buf.length > 0) splitLines(buf.toString("utf8"), "stdout", out);
    return out;
  }
  let at = 0;
  while (at + 8 <= buf.length) {
    const type = buf[at];
    const size = buf.readUInt32BE(at + 4);
    const end = at + 8 + size;
    if (end > buf.length) break;
    splitLines(buf.subarray(at + 8, end).toString("utf8"), type === 2 ? "stderr" : "stdout", out);
    at = end;
  }
  return out;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?: (.*))?$/s;

/** Linha do `/logs?timestamps=1` → horário do Docker + texto do app. */
export function splitTimestamp(line: string): { time: string | null; text: string } {
  const m = TIMESTAMP.exec(line);
  if (!m || Number.isNaN(Date.parse(m[1]!.replace(/(\.\d{3})\d+/, "$1")))) return { time: null, text: line };
  return { time: m[1]!, text: m[2] ?? "" };
}
