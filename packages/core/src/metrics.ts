/**
 * metrics.ts — monitoramento de recursos da VPS e dos projetos (Fase 1).
 *
 * Contrato entre o coletor (servidor) e as telas. O coletor lê arquivos do
 * kernel a cada 60 s, guarda uma série temporal em três resoluções (minuto,
 * hora, dia) e responde aos gráficos. Regras que valem em toda a Fase:
 *  - "sem dados" é AUSÊNCIA: uma métrica que não foi medida não existe na
 *    amostra (nunca vira 0);
 *  - um ponto de série é `{ t, v, max }`: `t` em segundos desde a época (UTC),
 *    `v` a média do período (soma, nas métricas de evento) e `max` o pico.
 */
import type { HealthLevel } from "./index";

/** Intervalo da coleta. */
export const METRICS_INTERVAL_SECONDS = 60;

/**
 * Pastas dentro de data/. O dado por minuto fica numa pasta própria, de fora do
 * backup do painel (é volátil e grande perto do resto); hora e dia entram no backup.
 */
export const METRICS_MINUTE_DIRNAME = "metrics-min";
export const METRICS_DIRNAME = "metrics";

/** Retenção: horas do dado por minuto, dias do dado por hora e dias do dado por dia. */
export interface MetricsRetention {
  minuteHours: number;
  hourDays: number;
  dayDays: number;
}

/** Padrão: 48 h por minuto, 90 dias por hora, 2 anos por dia. */
export const METRICS_RETENTION_DEFAULT: Readonly<MetricsRetention> = { minuteHours: 48, hourDays: 90, dayDays: 730 };

/** Limites que a pessoa pode escolher (inclusive). */
export const METRICS_RETENTION_LIMITS: Readonly<Record<keyof MetricsRetention, { min: number; max: number }>> = {
  minuteHours: { min: 24, max: 168 },
  hourDays: { min: 7, max: 365 },
  dayDays: { min: 90, max: 1825 },
};

export type MetricsRetentionError = "invalid_retention" | "retention_order";

/**
 * Confere a retenção escolhida: três inteiros dentro dos limites, e o dado por
 * dia nunca guardado por MENOS tempo que o dado por hora (a visão longa não
 * pode ser mais curta que a média).
 */
export function validateMetricsRetention(
  input: unknown,
): { ok: true; value: MetricsRetention } | { ok: false; error: MetricsRetentionError } {
  const o = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = {} as MetricsRetention;
  for (const key of ["minuteHours", "hourDays", "dayDays"] as const) {
    const v = o[key];
    const { min, max } = METRICS_RETENTION_LIMITS[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return { ok: false, error: "invalid_retention" };
    out[key] = v;
  }
  if (out.dayDays < out.hourDays) return { ok: false, error: "retention_order" };
  return { ok: true, value: out };
}

/** Janelas que as telas pedem. */
export const METRICS_RANGES = ["1h", "6h", "24h", "7d", "30d", "90d", "1y"] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];
export const METRICS_RANGE_SECONDS: Readonly<Record<MetricsRange, number>> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
  "90d": 90 * 86400,
  "1y": 365 * 86400,
};
/** Máximo de pontos por série numa resposta (o gráfico não precisa de mais). */
export const METRICS_MAX_POINTS = 360;

/** "gauge": valor num instante (média/pico); "event": contagem no período (soma). */
export type MetricKind = "gauge" | "event";

/** Métricas do host. Unidades: % (0–100), bytes, bytes/s, segundos, contagem. */
export const HOST_METRIC_KINDS = {
  cpuBusy: "gauge", // % do total (usuário + sistema)
  cpuUser: "gauge",
  cpuSystem: "gauge",
  cpuIowait: "gauge",
  cpuSteal: "gauge",
  load1: "gauge",
  load5: "gauge",
  load15: "gauge",
  cores: "gauge",
  memTotal: "gauge",
  memAvail: "gauge",
  memUsedPct: "gauge", // (total − disponível) / total
  swapTotal: "gauge",
  swapUsed: "gauge",
  swapIn: "gauge", // páginas/s
  swapOut: "gauge",
  oom: "event", // processos mortos por falta de memória no período
  psiCpu: "gauge", // % do tempo com atraso (some, média de 60 s)
  psiMem: "gauge",
  psiIo: "gauge",
  diskTotal: "gauge",
  diskFree: "gauge",
  diskPct: "gauge",
  inodePct: "gauge",
  ioRead: "gauge", // bytes/s
  ioWrite: "gauge",
  ioBusy: "gauge", // % do tempo com o disco ocupado
  netRx: "gauge", // bytes/s
  netTx: "gauge",
  uptime: "gauge", // segundos desde o boot
} as const satisfies Record<string, MetricKind>;
export type HostMetricId = keyof typeof HOST_METRIC_KINDS;

/** Métricas por container e por projeto (soma dos containers dele). */
export const CONTAINER_METRIC_KINDS = {
  cpu: "gauge", // % de UM núcleo (100 = um núcleo inteiro)
  mem: "gauge", // bytes em uso de verdade (sem o cache de arquivo reaproveitável)
  memLimit: "gauge", // bytes; ausente = sem limite
  ioRead: "gauge", // bytes/s
  ioWrite: "gauge",
  netRx: "gauge",
  netTx: "gauge",
  oom: "event",
  restarts: "event", // reinícios no período
  up: "gauge", // 1 = rodando, 0 = parado (média = fração do tempo no ar)
} as const satisfies Record<string, MetricKind>;
export type ContainerMetricId = keyof typeof CONTAINER_METRIC_KINDS;

/** Um ponto de série: média (soma, em evento) e pico do período. */
export interface MetricPoint {
  t: number;
  v: number;
  max: number;
}

export type MetricResolution = "minute" | "hour" | "day";

/** Estado do coletor, mostrado nas telas. */
export interface MetricsCollectorStatus {
  /**
   * full: leu /proc e os cgroups do host (montagens do compose);
   * reduced: sem a montagem; host só pelo que o container enxerga e containers pela API do Docker;
   * unavailable: nada foi lido ainda ou nada pôde ser lido.
   */
  mode: "full" | "reduced" | "unavailable";
  hostSource: "mounted" | "container" | "none";
  containerSource: "cgroup" | "api" | "none";
  /** Última coleta concluída (ISO); null = ainda não coletou. */
  lastTickAt: string | null;
  /** Motivo curto da última falha de coleta (sem caminhos nem dados sensíveis); null = sem falha. */
  lastError: string | null;
  /** A retenção em uso. */
  retention: MetricsRetention;
}

export interface HostMetricsResponse {
  range: MetricsRange;
  resolution: MetricResolution;
  /** Distância entre pontos, em segundos. */
  stepSeconds: number;
  from: number;
  to: number;
  /** A série pedida começa depois do início da janela (a coleta é mais nova que a janela, ou a retenção é menor). */
  partial: boolean;
  series: Partial<Record<HostMetricId, MetricPoint[]>>;
  /** Última amostra (valores de agora). */
  latest: { t: number; values: Partial<Record<HostMetricId, number>> } | null;
  collector: MetricsCollectorStatus;
}

export interface ProjectServiceMetrics {
  service: string;
  series: Partial<Record<ContainerMetricId, MetricPoint[]>>;
  latest: Partial<Record<ContainerMetricId, number>>;
}

export interface ProjectMetricsResponse {
  range: MetricsRange;
  resolution: MetricResolution;
  stepSeconds: number;
  from: number;
  to: number;
  partial: boolean;
  /** Soma dos serviços do projeto. */
  total: ProjectServiceMetrics | null;
  services: ProjectServiceMetrics[];
  /** Reinícios e mortes por falta de memória, com o horário (do mais novo para o mais velho). */
  events: Array<{ t: number; service: string | null; kind: "restart" | "oom"; count: number }>;
  collector: MetricsCollectorStatus;
}

/** Um indicador do semáforo do painel. */
export interface MetricsIndicator {
  level: HealthLevel;
  /** Sparkline das últimas 24 h (média por período); vazio = sem dados. */
  spark: MetricPoint[];
}

export interface MetricsSummaryResponse {
  generatedAt: string;
  collector: MetricsCollectorStatus;
  cpu: MetricsIndicator & { busyPct: number | null; stealPct: number | null; psi: number | null; cores: number | null };
  memory: MetricsIndicator & {
    usedPct: number | null;
    availBytes: number | null;
    totalBytes: number | null;
    swapUsedBytes: number | null;
    psi: number | null;
    oomKills24h: number;
  };
  disk: MetricsIndicator & {
    usedPct: number | null;
    freeBytes: number | null;
    inodePct: number | null;
    /** Estimativa de dias até encher (faixa); null = sem dados suficientes ou não está crescendo. */
    daysToFull: { low: number; high: number } | null;
  };
  network: MetricsIndicator & { rxBytesPerSecond: number | null; txBytesPerSecond: number | null };
  projects: MetricsIndicator & {
    running: number;
    total: number;
    problems: Array<{ slug: string; services: string[]; reasons: ProjectProblemReason[] }>;
    problemCount: number;
  };
  protections: {
    level: HealthLevel;
    certificates: { total: number; problems: number } | null;
    backups: { destinationConnected: boolean; lastFailure: boolean } | null;
  };
}

export type ProjectProblemReason = "restarting" | "unhealthy" | "dead" | "restart_loop" | "oom" | "exited_with_error";

export interface MetricsSettingsResponse {
  retention: MetricsRetention;
  defaults: MetricsRetention;
  limits: typeof METRICS_RETENTION_LIMITS;
  /** Espaço que os dados de métricas ocupam agora (bytes), por resolução. */
  usage: { minuteBytes: number; hourBytes: number; dayBytes: number };
  collector: MetricsCollectorStatus;
}

export interface UpdateMetricsSettingsRequest {
  retention: MetricsRetention;
}
