/**
 * Tipos compartilhados da Fase 4 — Guardrails de deploy, baseline +
 * monitoramento contínuo, central de alertas e auditoria.
 * Spec: plano §5.4 e docs/security-research.md §6.6.
 */

// ---------------------------------------------------------------------------
// Guardrails de deploy (packages/deploy)
// ---------------------------------------------------------------------------

/** Nível da regra: block impede o deploy sem override explícito. */
export type GuardrailLevel = "block" | "warn" | "info";

export interface GuardrailFinding {
  /** Identificador estável da regra, ex.: "db-port-exposed". */
  rule: string;
  level: GuardrailLevel;
  /** Título amigável (pt-BR). */
  title: string;
  /** Evidência: arquivo:linha ou serviço do compose. */
  evidence: string;
  /** Sugestão de correção (pt-BR). */
  fix: string;
  /** Serviço do compose relacionado (quando aplicável). */
  service?: string;
}

export interface GuardrailReport {
  ranAt: string;
  /** Diretório analisado. */
  dir: string;
  findings: GuardrailFinding[];
  blockers: number;
  warnings: number;
  infos: number;
}

export interface GuardrailReportResponse {
  /** null quando o código-fonte ainda não está disponível localmente. */
  report: GuardrailReport | null;
  /** Nota explicativa (ex.: código ainda não ingerido no modo git). */
  note: string | null;
}

export interface DeployRequest {
  /** Confirmação explícita para prosseguir mesmo com findings "block". */
  guardrailOverride?: boolean;
}

// ---------------------------------------------------------------------------
// Central de alertas
// ---------------------------------------------------------------------------

export type AlertSeverity = "critical" | "warning" | "info";
/** Origem de um alerta. Toda origem aqui é de fato produzida em código. */
export type AlertSource = "guardrail" | "scan" | "blacklist";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
export const ALERT_SOURCES: readonly AlertSource[] = ["guardrail", "scan", "blacklist"];
export const ALERT_STATUSES: readonly AlertStatus[] = ["open", "acknowledged", "resolved"];

export interface Alert {
  id: string;
  severity: AlertSeverity;
  source: AlertSource;
  title: string;
  detail: string;
  status: AlertStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface AlertListResponse {
  alerts: Alert[];
  total: number;
  /** Alertas abertos no total (para o badge da navegação). */
  openCount: number;
  page: number;
  perPage: number;
}

export interface AlertResponse {
  alert: Alert;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  at: string;
  /** Quem executou (painel mono-usuário: "operador"). */
  actor: string;
  /** Ação sensível, ex.: "deploy.start", "guardrail.override". */
  action: string;
  /** Alvo da ação (slug do projeto, fase, domínio…). */
  target: string | null;
  /** Detalhe legível (pt-BR). Nunca conter segredos. */
  detail: string;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  perPage: number;
}

// ---------------------------------------------------------------------------
// Baseline de segurança (packages/security)
// ---------------------------------------------------------------------------

export interface BaselinePort {
  proto: "tcp" | "udp";
  port: number;
  /** Processo dono do socket (quando visível). */
  process: string | null;
}

export interface SecurityBaseline {
  id: string;
  createdAt: string;
  /** Alvo do snapshot: "host" ou "container:<nome>". */
  target: string;
  /** Pacotes instalados ("nome=versão"), ordenados. */
  packages: string[];
  /** Portas em listen (ss -tulpn). */
  ports: BaselinePort[];
  /** sha256 de arquivos críticos (caminho → hash; null = ausente). */
  files: Record<string, string | null>;
}

export interface BaselineResponse {
  baseline: SecurityBaseline | null;
}

// ---------------------------------------------------------------------------
// Scan recorrente (diff contra o baseline)
// ---------------------------------------------------------------------------

export interface BaselineDiff {
  newPackages: string[];
  removedPackages: string[];
  newPorts: BaselinePort[];
  closedPorts: BaselinePort[];
  /** Arquivos cujo hash mudou. */
  changedFiles: string[];
  /** Arquivos rastreados que sumiram. */
  removedFiles: string[];
  /** Arquivos novos em diretórios críticos. */
  addedFiles: string[];
}

export interface MonitorScanResult {
  id: string;
  ranAt: string;
  target: string;
  durationMs: number;
  baselineId: string | null;
  baselineAt: string | null;
  /** null quando não há baseline para comparar. */
  diff: BaselineDiff | null;
  alertsCreated: number;
  note: string | null;
}

export interface MonitorConfig {
  /** Intervalo do scan recorrente (ms). Default 6h. */
  intervalMs: number;
}

export interface MonitorStateResponse {
  config: MonitorConfig;
  schedulerRunning: boolean;
  lastRunAt: string | null;
  lastResult: MonitorScanResult | null;
  /** Resumo do baseline atual (sem as listas completas). */
  baseline: { id: string; createdAt: string; target: string } | null;
}

export interface MonitorRunResponse {
  result: MonitorScanResult;
}

/** Intervalo padrão do monitoramento: 6 horas. */
export const MONITOR_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Intervalo mínimo aceito pela API (evita busy-loop). */
export const MONITOR_MIN_INTERVAL_MS = 10 * 1000;
