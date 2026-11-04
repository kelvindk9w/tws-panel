/**
 * project-logs.ts — aba "Logs" do projeto: o que os containers do projeto
 * escrevem enquanto rodam (GET /api/projects/:id/logs).
 *
 * Contrato só de leitura. O texto vem dos containers (não confiável): o
 * servidor tira cores/caracteres de controle, limita o tamanho e mascara, em
 * melhor esforço, os valores das variáveis do projeto e padrões óbvios de
 * segredo antes de devolver.
 */

/** Linhas devolvidas quando o pedido não diz quantas. */
export const PROJECT_LOGS_TAIL_DEFAULT = 200;
/** Máximo de linhas por pedido. */
export const PROJECT_LOGS_TAIL_MAX = 2000;
/** Períodos aceitos ("desde"): 15 minutos, 1 hora, 24 horas. */
export const PROJECT_LOGS_SINCE = ["15m", "1h", "24h"] as const;
export type ProjectLogsSince = (typeof PROJECT_LOGS_SINCE)[number];

export type ProjectLogStream = "stdout" | "stderr";

export interface ProjectLogLine {
  /** Horário da linha (ISO 8601, como o Docker gravou); null se o Docker não informou. */
  time: string | null;
  /** Serviço do compose (ou nome do container, fora do compose). */
  service: string;
  container: string;
  /** Container com TTY não separa os dois: tudo vem como stdout. */
  stream: ProjectLogStream;
  /** Já sem cores e com segredos mascarados. */
  text: string;
}

/** Por que o log de um serviço não veio: não deu para ler, ou era grande demais para o limite. */
export type ProjectLogsError = "unavailable" | "too_large";

export interface ProjectLogService {
  service: string;
  container: string;
  /** running, exited, restarting, paused, created, dead; "unknown" se não deu para consultar. */
  state: string;
  /** Texto do Docker ("Up 3 minutes (healthy)"). */
  status: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  restartCount: number | null;
  /** Último início do container (ISO). */
  startedAt: string | null;
  /** Última parada (ISO); null se está rodando ou nunca parou. */
  finishedAt: string | null;
  exitCode: number | null;
  logsError: ProjectLogsError | null;
}

export interface ProjectLogsResponse {
  /** Serviço pedido; null = todos. */
  service: string | null;
  tail: number;
  since: ProjectLogsSince | null;
  /** Estado de TODOS os serviços do projeto (mesmo com um serviço escolhido). */
  services: ProjectLogService[];
  /** Mais antigas primeiro. */
  lines: ProjectLogLine[];
  /** Linhas ficaram de fora pelo limite de tamanho da resposta. */
  truncated: boolean;
  generatedAt: string;
}
