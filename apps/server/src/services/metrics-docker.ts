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
  /** Container de `docker compose run` (execução avulsa): não é réplica nem serviço esperado. */
  oneoff?: boolean;
  /** Outro serviço do mesmo projeto espera por este com `service_completed_successfully` (label depends_on dos dependentes). */
  awaited?: boolean;
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_DEPENDS_LABEL = "com.docker.compose.depends_on";

/** Serviços que o container espera concluir: label `servico:condição:obrigatório,...` do compose. */
export function completionDependencies(label: string | undefined): string[] {
  if (!label) return [];
  const out: string[] = [];
  for (const part of label.split(",")) {
    const [service, condition] = part.split(":");
    if (service && condition === "service_completed_successfully") out.push(service);
  }
  return out;
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
  /** projeto/serviço → algum dependente espera a conclusão dele */
  const awaitedKeys = new Set<string>();
  const projectOf: string[] = [];
  for (const item of doc.slice(0, MAX_CONTAINERS)) {
    if (!isRecord(item) || typeof item.Id !== "string" || !ID_RE.test(item.Id)) continue;
    const labels: Record<string, string> = {};
    if (isRecord(item.Labels)) {
      for (const [k, v] of Object.entries(item.Labels)) if (typeof v === "string" && k !== "__proto__") labels[k] = v;
    }
    const names = Array.isArray(item.Names) ? item.Names : [];
    const first = typeof names[0] === "string" ? names[0].replace(/^\//, "") : "";
    const identity = containerIdentity(labels);
    const project = labels[COMPOSE_PROJECT_LABEL] ?? "";
    for (const dep of completionDependencies(labels[COMPOSE_DEPENDS_LABEL])) awaitedKeys.add(`${project}/${dep}`);
    projectOf.push(project);
    out.push({
      id: item.Id,
      name: first || item.Id.slice(0, 12),
      state: typeof item.State === "string" && item.State !== "" ? item.State : "unknown",
      managed: identity.managed,
      projectSlug: identity.projectSlug,
      service: labels[COMPOSE_SERVICE_LABEL] ?? null,
      oneoff: (labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true",
    });
  }
  out.forEach((e, i) => {
    if (e.service !== null && awaitedKeys.has(`${projectOf[i]}/${e.service}`)) e.awaited = true;
  });
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
