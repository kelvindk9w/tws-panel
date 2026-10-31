/**
 * server-logs.ts — página "Logs do servidor": o que os containers do PRÓPRIO painel (painel, proxy, servidor de
 * e-mail) e duas unidades do host (Docker e SSH) escrevem. Somente leitura.
 *
 * Reaproveita o leitor da aba Logs do projeto (project-logs.ts), com os mesmos limites (linhas, período, bytes,
 * prazo, vagas simultâneas), a mesma limpeza e a mesma máscara. O que muda é só QUEM pode ser lido:
 *  - containers: uma lista FECHADA de nomes (SERVER_LOG_SOURCES). O pedido escolhe um id da lista, nunca informa
 *    nome de container; qualquer outro container da máquina (inclusive os dos projetos) nem aparece;
 *  - host: duas fontes do journal com unidades fixas, pela allowlist do host bridge (packages/security/src/host-journal.ts):
 *    nenhum texto do cliente vira comando, só a quantidade de linhas e o início da janela, validados.
 *
 * Segredos: os valores que o painel conhece (senhas das caixas, senha de administração do e-mail, segredo do aviso de
 * envio, variáveis dos projetos) entram na máscara, além dos padrões de log-mask.ts (Bearer, senha em URL, token do
 * painel, JWT, cookie...). Melhor esforço, como na aba Logs. Sem conseguir montar a lista de segredos, nenhum log sai.
 */
import {
  PROJECT_LOGS_SINCE,
  PROJECT_LOGS_TAIL_DEFAULT,
  PROJECT_LOGS_TAIL_MAX,
  SERVER_LOG_SOURCES,
  SERVER_LOG_SOURCE_IDS,
  type DockerContainerInfo,
  type ProjectLogLine,
  type ProjectLogService,
  type ServerLogSourceId,
  type ServerLogsResponse,
  type ServerLogsSince,
} from "@paas/core";
import type { JournalLine, JournalSource } from "@paas/security";
import { buildLogMasker, cleanLogText, stripLogControl } from "./log-mask.js";
import {
  LOG_OMITTED,
  MASK_BUDGET_MS,
  MAX_MASK_CHARS,
  MAX_RESPONSE_CHARS,
  ProjectLogsService,
  RAW_LINE_MAX,
  type ProjectLogsDeps,
  type ReadContext,
} from "./project-logs.js";
import { httpError } from "./http-error.js";

const SINCE_SECONDS: Record<ServerLogsSince, number> = { "15m": 900, "1h": 3600, "24h": 86_400 };

/** Id interno do "projeto" que o leitor reaproveitado enxerga. */
const SERVER_SLUG = "_server";

const SOURCE_BY_CONTAINER = new Map<string, ServerLogSourceId>(
  SERVER_LOG_SOURCES.flatMap((s) => (s.kind === "container" ? [[s.container, s.id] as [string, ServerLogSourceId]] : [])),
);

export type JournalResult = { ok: true; lines: JournalLine[] } | { ok: false };

export interface ServerLogsDeps {
  docker: ProjectLogsDeps;
  /** null = fora da VPS real (desenvolvimento/teste): as fontes do host aparecem como indisponíveis. */
  journal: { read(source: JournalSource, lines: number, sinceEpoch: number | null, signal?: AbortSignal): Promise<JournalResult> } | null;
  /** Valores que o painel conhece e que nunca podem aparecer. Lança se não der para montar a lista. */
  secrets(): Promise<string[]>;
}

export interface ServerLogsQuery {
  source?: string;
  tail?: number;
  since?: ServerLogsSince;
}

export class ServerLogsService {
  private readonly containers: ProjectLogsService;
  private journalActive = 0;

  constructor(private readonly deps: ServerLogsDeps) {
    this.containers = new ProjectLogsService({
      ...deps.docker,
      // Só as três máquinas do painel, pelo NOME exato, e cada uma como "serviço" com o id da fonte.
      listContainers: async (timeoutMs, signal) =>
        (await deps.docker.listContainers(timeoutMs, signal))
          .filter((c) => SOURCE_BY_CONTAINER.has(c.name))
          .map((c): DockerContainerInfo => ({ ...c, managed: true, projectSlug: SERVER_SLUG, service: SOURCE_BY_CONTAINER.get(c.name)! })),
    });
  }

  async read(query: ServerLogsQuery, ctx: ReadContext = {}): Promise<ServerLogsResponse> {
    const source = query.source ?? null;
    if (source !== null && !(SERVER_LOG_SOURCE_IDS as readonly string[]).includes(source)) {
      throw httpError(400, "invalid_source", "Fonte de logs desconhecida.");
    }
    const tail = query.tail ?? PROJECT_LOGS_TAIL_DEFAULT;
    if (!Number.isInteger(tail) || tail < 1 || tail > PROJECT_LOGS_TAIL_MAX) {
      throw httpError(400, "invalid_log_query", `Escolha de 1 a ${PROJECT_LOGS_TAIL_MAX} linhas.`);
    }
    const since = query.since ?? null;
    if (since !== null && !PROJECT_LOGS_SINCE.includes(since)) throw httpError(400, "invalid_log_query", "Período inválido.");

    // Falha fechada: sem a lista de segredos não há como mascarar, então nenhum log sai.
    const secrets = await this.deps.secrets().catch(() => {
      throw httpError(503, "log_masking_unavailable", "Não foi possível proteger os segredos agora, então os logs não foram lidos. Tente de novo em instantes.");
    });
    const def = SERVER_LOG_SOURCES.find((s) => s.id === source);
    if (def?.kind === "journal") return this.readJournal(def.id as JournalSource, tail, since, secrets, ctx);
    try {
      return await this.containers.read({ slug: SERVER_SLUG }, { ...(source !== null ? { service: source } : {}), tail, ...(since ? { since } : {}) }, secrets, ctx);
    } catch (err) {
      if ((err as { code?: string }).code === "service_not_found") {
        throw httpError(404, "source_not_found", "Esse container não está rodando neste servidor.");
      }
      throw err;
    }
  }

  private async readJournal(
    source: JournalSource,
    tail: number,
    since: ServerLogsSince | null,
    secrets: string[],
    ctx: ReadContext,
  ): Promise<ServerLogsResponse> {
    // Cada leitura sobe um container descartável no host: no máximo duas ao mesmo tempo no painel inteiro, e uma
    // delas fica reservada à sessão humana.
    const human = ctx.human ?? true;
    if (this.journalActive >= 2 || (!human && this.journalActive >= 1)) {
      throw httpError(429, "logs_busy", "Há leituras de logs demais em andamento. Tente de novo em alguns segundos.");
    }
    this.journalActive++;
    try {
      const nowMs = this.deps.docker.now();
      const sinceEpoch = since === null ? null : Math.floor(nowMs / 1000) - SINCE_SECONDS[since];
      const info: ProjectLogService = {
        service: source,
        container: `journal:${source}`,
        state: "journal",
        status: "",
        health: null,
        restartCount: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        logsError: null,
      };
      const result = this.deps.journal ? await this.deps.journal.read(source, tail, sinceEpoch, ctx.signal).catch((): JournalResult => ({ ok: false })) : ({ ok: false } as const);
      const lines: ProjectLogLine[] = [];
      let truncated = false;
      if (!result.ok) {
        info.logsError = "unavailable";
      } else {
        const mask = buildLogMasker(secrets);
        const clock = this.deps.docker.clock ?? (() => performance.now());
        const start = clock();
        let budget = MAX_MASK_CHARS;
        const last = result.lines.slice(-tail);
        const out = new Array<ProjectLogLine>(last.length);
        for (let i = last.length - 1; i >= 0; i--) {
          const clean = stripLogControl(last[i]!.text);
          const cut = clean.length > RAW_LINE_MAX;
          let text: string;
          if (budget <= 0 || clock() - start > MASK_BUDGET_MS) {
            text = LOG_OMITTED;
            truncated = true;
          } else {
            budget -= Math.min(clean.length, RAW_LINE_MAX);
            text = cleanLogText(cut ? clean.slice(0, RAW_LINE_MAX) : clean, mask, cut);
          }
          out[i] = { time: last[i]!.time, service: source, container: info.container, stream: "stdout", text };
        }
        let chars = 0;
        let keepFrom = out.length;
        while (keepFrom > 0 && chars + out[keepFrom - 1]!.text.length <= MAX_RESPONSE_CHARS) {
          chars += out[keepFrom - 1]!.text.length;
          keepFrom--;
        }
        if (keepFrom > 0) truncated = true;
        lines.push(...out.slice(keepFrom));
      }
      return { service: source, tail, since, services: [info], lines, truncated, generatedAt: new Date(nowMs).toISOString() };
    } finally {
      this.journalActive--;
    }
  }
}
