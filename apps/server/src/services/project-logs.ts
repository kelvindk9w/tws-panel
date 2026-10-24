/**
 * project-logs.ts — aba "Logs" do projeto: lê o que os containers DO PROJETO
 * escrevem (stdout/stderr com horário) e o estado de cada serviço.
 *
 * Regras de segurança:
 *  - os containers vêm da listagem do painel e só valem os gerenciados com o
 *    slug do projeto (a mesma identidade de container-identity.ts); o pedido
 *    escolhe entre eles pelo nome do serviço, nunca informa container;
 *  - o nome do serviço é validado por formato (400) e por pertencer ao projeto (404);
 *  - quantidade de linhas, período, tamanho de cada linha, bytes lidos do
 *    Docker, número de serviços e tamanho da resposta têm limite;
 *  - o texto é limpo e mascarado (log-mask.ts) antes de sair.
 */
import {
  PROJECT_LOGS_SINCE,
  PROJECT_LOGS_TAIL_DEFAULT,
  PROJECT_LOGS_TAIL_MAX,
  type DockerContainerInfo,
  type ProjectLogLine,
  type ProjectLogService,
  type ProjectLogsResponse,
  type ProjectLogsSince,
} from "@paas/core";
import { demuxLogStream, splitTimestamp, type ContainerRuntime, type DockerLogsResult } from "./docker-logs.js";
import { buildLogMasker, cleanLogText } from "./log-mask.js";
import { httpError } from "./http-error.js";

/** Containers do projeto que a aba lê de uma vez (o resto fica de fora, com aviso). */
export const MAX_LOG_SERVICES = 40;
/** Soma dos textos das linhas devolvidas; acima disso ficam as mais recentes. */
export const MAX_RESPONSE_CHARS = 1_000_000;

/** Nome de serviço do compose / de container: sem barra, espaço, ponto-e-vírgula nem começo com hífen. */
export const LOG_SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

const SINCE_SECONDS: Record<ProjectLogsSince, number> = { "15m": 900, "1h": 3600, "24h": 86_400 };

export interface ProjectLogsDeps {
  /** Containers da máquina (lança DockerUnavailableError sem Docker). */
  listContainers(): Promise<DockerContainerInfo[]>;
  inspect(id: string): Promise<ContainerRuntime | null>;
  logs(id: string, opts: { tail: number; sinceSeconds: number | null }): Promise<DockerLogsResult>;
  now(): number;
}

export interface ProjectLogsQuery {
  service?: string;
  tail?: number;
  since?: ProjectLogsSince;
}

interface Collected {
  line: ProjectLogLine;
  ms: number;
  order: number;
}

/** Docker corta zeros finais da fração e usa até 9 dígitos: compara em milissegundos. */
function toMs(time: string): number {
  return Date.parse(time.replace(/(\.\d{3})\d+/, "$1"));
}

export class ProjectLogsService {
  constructor(private readonly deps: ProjectLogsDeps) {}

  /** `secrets`: valores das variáveis do projeto, para mascarar (log-mask.ts). */
  async read(project: { slug: string }, query: ProjectLogsQuery, secrets: readonly string[]): Promise<ProjectLogsResponse> {
    const wanted = query.service ?? null;
    if (wanted !== null && !LOG_SERVICE_RE.test(wanted)) {
      throw httpError(400, "invalid_service", "Nome de serviço inválido.");
    }
    const tail = query.tail ?? PROJECT_LOGS_TAIL_DEFAULT;
    if (!Number.isInteger(tail) || tail < 1 || tail > PROJECT_LOGS_TAIL_MAX) {
      throw httpError(400, "invalid_log_query", `Escolha de 1 a ${PROJECT_LOGS_TAIL_MAX} linhas.`);
    }
    const since = query.since ?? null;
    if (since !== null && !PROJECT_LOGS_SINCE.includes(since)) {
      throw httpError(400, "invalid_log_query", "Período inválido.");
    }
    const nowMs = this.deps.now();
    const sinceSeconds = since === null ? null : Math.floor(nowMs / 1000) - SINCE_SECONDS[since];

    const all = (await this.deps.listContainers())
      .filter((c) => c.managed && c.projectSlug === project.slug)
      .map((c) => ({ c, service: c.service ?? c.name }))
      .sort((a, b) => a.service.localeCompare(b.service) || a.c.name.localeCompare(b.c.name));
    const mine = all.slice(0, MAX_LOG_SERVICES);
    let truncated = all.length > mine.length;

    if (wanted !== null && !mine.some((m) => m.service === wanted)) {
      throw httpError(404, "service_not_found", "Esse serviço não existe neste projeto.");
    }

    const mask = buildLogMasker(secrets);
    const services: ProjectLogService[] = [];
    const collected: Collected[] = [];
    let order = 0;

    await Promise.all(
      mine.map(async ({ c, service }, index) => {
        const runtime = await this.deps.inspect(c.id);
        const info: ProjectLogService = {
          service,
          container: c.name,
          state: runtime?.state ?? c.state,
          status: c.status,
          health: runtime ? runtime.health : (c.health ?? null),
          restartCount: runtime?.restartCount ?? null,
          startedAt: runtime?.startedAt ?? null,
          finishedAt: runtime?.finishedAt ?? null,
          exitCode: runtime?.exitCode ?? null,
          logsError: null,
        };
        services[index] = info;
        if (wanted !== null && service !== wanted) return;
        if (!runtime) {
          info.logsError = "unavailable";
          return;
        }
        const res = await this.deps.logs(c.id, { tail, sinceSeconds });
        if (!res.ok) {
          info.logsError = res.reason;
          return;
        }
        let lastMs = 0;
        for (const raw of demuxLogStream(res.body, runtime.tty)) {
          const { time, text } = splitTimestamp(raw.text);
          if (time !== null) lastMs = toMs(time);
          collected.push({
            ms: lastMs,
            order: index * 1e7 + order++,
            line: { time, service, container: c.name, stream: raw.stream, text: cleanLogText(text, mask) },
          });
        }
      }),
    );

    collected.sort((a, b) => a.ms - b.ms || a.order - b.order);
    let lines = collected.slice(-tail).map((x) => x.line);
    let chars = 0;
    let keepFrom = lines.length;
    while (keepFrom > 0 && chars + lines[keepFrom - 1]!.text.length <= MAX_RESPONSE_CHARS) {
      chars += lines[keepFrom - 1]!.text.length;
      keepFrom--;
    }
    if (keepFrom > 0) {
      truncated = true;
      lines = lines.slice(keepFrom);
    }

    return { service: wanted, tail, since, services, lines, truncated, generatedAt: new Date(nowMs).toISOString() };
  }
}
