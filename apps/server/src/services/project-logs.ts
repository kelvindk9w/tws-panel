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

/** Containers lidos ao mesmo tempo dentro de UM pedido (memória: no máximo isto × 8 MiB de corpo). */
export const LOG_CONCURRENCY = 4;
/** Leituras de logs simultâneas no painel inteiro; acima disso, 429. */
export const MAX_ACTIVE_READS = 6;
/** Soma dos corpos lidos do Docker por pedido; o que passar disso não é lido (too_large). */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Prazo TOTAL de um pedido: serviço que não deu tempo de ler aparece como indisponível. */
export const TOTAL_DEADLINE_MS = 15_000;
/** Teto de cada chamada ao Docker (inspect ou logs); dentro do prazo total. */
export const CALL_TIMEOUT_MS = 10_000;
/** Linha crua acima disso é cortada ANTES da máscara (o Docker já parte linhas em 16 KiB). */
export const RAW_LINE_MAX = 8_000;
/** Orçamento da máscara por resposta: caracteres e tempo. Esgotado: o resto sai omitido, nunca sem máscara. */
export const MAX_MASK_CHARS = 4_000_000;
export const MASK_BUDGET_MS = 2_000;
export const LOG_OMITTED = "[linha omitida: limite de processamento da máscara]";

export interface ProjectLogsDeps {
  /** Containers da máquina (lança DockerUnavailableError sem Docker). */
  listContainers(): Promise<DockerContainerInfo[]>;
  inspect(id: string, timeoutMs?: number): Promise<ContainerRuntime | null>;
  logs(id: string, opts: { tail: number; sinceSeconds: number | null; timeoutMs?: number }): Promise<DockerLogsResult>;
  now(): number;
  /** Relógio monotônico em ms (prazos e orçamento da máscara); padrão: performance.now. */
  clock?: () => number;
}

export interface ProjectLogsQuery {
  service?: string;
  tail?: number;
  since?: ProjectLogsSince;
}

interface Collected {
  time: string | null;
  service: string;
  container: string;
  stream: ProjectLogLine["stream"];
  /** Texto cru (já cortado em RAW_LINE_MAX); só vira texto de resposta depois da máscara. */
  raw: string;
  ms: number;
  order: number;
}

/** Docker corta zeros finais da fração e usa até 9 dígitos: compara em milissegundos. */
function toMs(time: string): number {
  return Date.parse(time.replace(/(\.\d{3})\d+/, "$1"));
}

export class ProjectLogsService {
  private active = 0;

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
    if (this.active >= MAX_ACTIVE_READS) {
      throw httpError(429, "logs_busy", "Há leituras de logs demais em andamento. Tente de novo em alguns segundos.");
    }
    this.active++;
    try {
      return await this.run(project, wanted, tail, since, secrets);
    } finally {
      this.active--;
    }
  }

  private async run(
    project: { slug: string },
    wanted: string | null,
    tail: number,
    since: ProjectLogsSince | null,
    secrets: readonly string[],
  ): Promise<ProjectLogsResponse> {
    const clock = this.deps.clock ?? (() => performance.now());
    const deadline = clock() + TOTAL_DEADLINE_MS;
    /** Tempo que cada chamada ao Docker ainda pode levar (nunca passa do prazo total). */
    const remaining = () => Math.min(CALL_TIMEOUT_MS, deadline - clock());

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
    const services: ProjectLogService[] = mine.map(({ c, service }) => ({
      service,
      container: c.name,
      state: c.state,
      status: c.status,
      health: c.health ?? null,
      restartCount: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      logsError: null,
    }));
    const collected: Collected[] = [];
    let order = 0;
    let bytesRead = 0;

    const one = async (index: number): Promise<void> => {
      const { c, service } = mine[index]!;
      const info = services[index]!;
      if (remaining() <= 0) {
        info.logsError = "unavailable";
        return;
      }
      const runtime = await this.deps.inspect(c.id, remaining());
      if (runtime) {
        info.state = runtime.state;
        info.health = runtime.health;
        info.restartCount = runtime.restartCount;
        info.startedAt = runtime.startedAt;
        info.finishedAt = runtime.finishedAt;
        info.exitCode = runtime.exitCode;
      }
      if (wanted !== null && service !== wanted) return;
      if (!runtime || remaining() <= 0) {
        info.logsError = "unavailable";
        return;
      }
      if (bytesRead > MAX_TOTAL_BYTES) {
        info.logsError = "too_large";
        return;
      }
      const res = await this.deps.logs(c.id, { tail, sinceSeconds, timeoutMs: remaining() });
      if (!res.ok) {
        info.logsError = res.reason;
        return;
      }
      bytesRead += res.body.length;
      let lastMs = 0;
      for (const raw of demuxLogStream(res.body, runtime.tty)) {
        const { time, text } = splitTimestamp(raw.text);
        if (time !== null) lastMs = toMs(time);
        collected.push({
          time,
          service,
          container: c.name,
          stream: raw.stream,
          raw: text.length > RAW_LINE_MAX ? text.slice(0, RAW_LINE_MAX) : text,
          ms: lastMs,
          order: index * 1e7 + order++,
        });
      }
    };

    // Poucos containers por vez: a memória de um pedido fica em LOG_CONCURRENCY × 8 MiB, não em 40 ×.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < mine.length) await one(next++);
    };
    await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, mine.length) }, worker));

    collected.sort((a, b) => a.ms - b.ms || a.order - b.order);
    const last = collected.slice(-tail);
    // Máscara com orçamento (caracteres e tempo), das mais novas para as mais velhas: esgotado, a linha
    // sai omitida — nunca sem máscara.
    const maskStart = clock();
    let budget = MAX_MASK_CHARS;
    let lines: ProjectLogLine[] = new Array<ProjectLogLine>(last.length);
    for (let i = last.length - 1; i >= 0; i--) {
      const x = last[i]!;
      let text: string;
      if (budget <= 0 || clock() - maskStart > MASK_BUDGET_MS) {
        text = LOG_OMITTED;
        truncated = true;
      } else {
        budget -= x.raw.length;
        text = cleanLogText(x.raw, mask);
      }
      lines[i] = { time: x.time, service: x.service, container: x.container, stream: x.stream, text };
    }
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
