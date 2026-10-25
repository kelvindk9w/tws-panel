/**
 * metrics-docker.ts — o que o coletor pede à API do Docker pelo socket: a lista
 * de containers (uma chamada, sem subir o CLI a cada minuto) e, quando o cgroup
 * do host não está montado, as estatísticas de um container. Só leitura (GET),
 * com limite de bytes e de tempo (o mesmo cliente da aba Logs).
 */
import { containerIdentity } from "@paas/core";
import { dockerGet } from "./docker-logs.js";
import { parseDockerStats, type DockerStatsRaw } from "./metrics-parse.js";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const ID_RE = /^[0-9a-f]{12,64}$/;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const STATS_MAX_BYTES = 1024 * 1024;
const EVENTS_MAX_BYTES = 1024 * 1024;
/** Containers acompanhados por coleta (o resto fica de fora). */
export const MAX_CONTAINERS = 200;

export interface DockerEntry {
  id: string;
  name: string;
  state: string;
  managed: boolean;
  projectSlug: string | null;
  /** Serviço do compose; null fora do compose. */
  service: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Containers da máquina (todos, parados inclusive). null = o Docker não respondeu direito. */
export async function dockerListEntries(socketPath: string, timeoutMs = 8000, signal?: AbortSignal): Promise<DockerEntry[] | null> {
  const r = await dockerGet(socketPath, "/containers/json?all=1", LIST_MAX_BYTES, timeoutMs, signal);
  if (!r.ok || r.status !== 200) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(r.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  const out: DockerEntry[] = [];
  for (const item of doc.slice(0, MAX_CONTAINERS)) {
    if (!isRecord(item) || typeof item.Id !== "string" || !ID_RE.test(item.Id)) continue;
    const labels: Record<string, string> = {};
    if (isRecord(item.Labels)) {
      for (const [k, v] of Object.entries(item.Labels)) if (typeof v === "string" && k !== "__proto__") labels[k] = v;
    }
    const names = Array.isArray(item.Names) ? item.Names : [];
    const first = typeof names[0] === "string" ? names[0].replace(/^\//, "") : "";
    const identity = containerIdentity(labels);
    out.push({
      id: item.Id,
      name: first || item.Id.slice(0, 12),
      state: typeof item.State === "string" && item.State !== "" ? item.State : "unknown",
      managed: identity.managed,
      projectSlug: identity.projectSlug,
      service: labels[COMPOSE_SERVICE_LABEL] ?? null,
    });
  }
  return out;
}

/**
 * Mortes por falta de memória que o Docker registrou entre dois instantes (epoch s, inclusive): um evento
 * "oom" por morte, com o id do container. É o único sinal que sobrevive ao reinício do container (o Docker
 * zera State.OOMKilled ao voltar a rodar e o cgroup novo começa com o contador em zero). Com `until` a
 * chamada termina sozinha. null = o Docker não respondeu: não se conclui nada.
 */
export async function dockerOomEvents(socketPath: string, sinceSec: number, untilSec: number, timeoutMs = 8000, signal?: AbortSignal): Promise<Array<{ id: string; t: number }> | null> {
  if (!Number.isSafeInteger(sinceSec) || !Number.isSafeInteger(untilSec) || sinceSec < 0 || untilSec < sinceSec) return null;
  const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["oom"] }));
  const r = await dockerGet(socketPath, `/events?since=${sinceSec}&until=${untilSec}&filters=${filters}`, EVENTS_MAX_BYTES, timeoutMs, signal);
  if (!r.ok || r.status !== 200) return null;
  const out: Array<{ id: string; t: number }> = [];
  for (const line of r.body.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    const actor = isRecord(ev.Actor) ? ev.Actor : {};
    const id = typeof actor.ID === "string" ? actor.ID : ev.id;
    if (typeof id !== "string" || !ID_RE.test(id)) continue;
    out.push({ id, t: typeof ev.time === "number" ? ev.time : sinceSec });
  }
  return out;
}

/** Estatísticas de um container, uma leitura (one-shot). null se não deu. */
export async function dockerStatsRaw(socketPath: string, id: string, timeoutMs = 8000, signal?: AbortSignal): Promise<DockerStatsRaw | null> {
  if (!ID_RE.test(id)) return null;
  const r = await dockerGet(socketPath, `/containers/${id}/stats?stream=false&one-shot=true`, STATS_MAX_BYTES, timeoutMs, signal);
  if (!r.ok || r.status !== 200) return null;
  try {
    return parseDockerStats(JSON.parse(r.body.toString("utf8")));
  } catch {
    return null;
  }
}
