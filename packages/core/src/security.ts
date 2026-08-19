/**
 * Tipos compartilhados do módulo de segurança (Fase 1 — Hardening).
 * Spec: docs/security-research.md (checklist de 6 fases/30 passos).
 */

// ---------------------------------------------------------------------------
// Fases de hardening (uma por script em scripts/hardening/)
// ---------------------------------------------------------------------------

export const SECURITY_PHASES = [
  { id: "00", key: "update", title: "Atualizações do sistema", script: "00-update.sh" },
  { id: "01", key: "user", title: "Usuário não-root", script: "01-user.sh" },
  { id: "02", key: "ssh", title: "Hardening de SSH", script: "02-ssh.sh" },
  { id: "03", key: "firewall", title: "Firewall (UFW)", script: "03-firewall.sh" },
  { id: "04", key: "intrusion", title: "Prevenção de intrusão", script: "04-intrusion.sh" },
  { id: "05", key: "minimal", title: "Minimização de pacotes", script: "05-minimal.sh" },
  { id: "06", key: "audit", title: "Auditoria e detecção", script: "06-audit.sh" },
] as const;

export type SecurityPhaseId = (typeof SECURITY_PHASES)[number]["id"];
export type SecurityPhaseKey = (typeof SECURITY_PHASES)[number]["key"];

/** Fases cujas mudanças podem derrubar o acesso do operador (SSH/firewall). */
export const RISKY_PHASES: readonly SecurityPhaseId[] = ["02", "03"];

// ---------------------------------------------------------------------------
// Scan (somente leitura)
// ---------------------------------------------------------------------------

export type CheckSeverity = "critical" | "warning" | "info";
export type CheckStatus = "pass" | "fail" | "unknown";

export interface SecurityCheckResult {
  /** Identificador estável, ex.: "ssh.password-auth". */
  id: string;
  /** Fase de hardening que remedia o check ("00".."06"). */
  phase: SecurityPhaseId;
  title: string;
  severity: CheckSeverity;
  status: CheckStatus;
  description: string;
  /** Remediação sugerida (texto amigável, pt-BR). */
  remediation: string;
  /** Evidência bruta capturada (opcional, ex.: saída de comando). */
  detail?: string;
}

export interface SecurityScanSummary {
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  critical: number;
  warning: number;
}

export interface SecurityScanReport {
  id: string;
  scannedAt: string;
  durationMs: number;
  /** Alvo do scan: "host" ou nome do container. */
  target: string;
  /** Hardening Index 0-100 (fonte: lynis ou cálculo interno). */
  hardeningIndex: number | null;
  hardeningIndexSource: "lynis" | "internal";
  lynisAvailable: boolean;
  checks: SecurityCheckResult[];
  summary: SecurityScanSummary;
}

// ---------------------------------------------------------------------------
// Plano de correção
// ---------------------------------------------------------------------------

export interface SecurityPlanAction {
  /** Identificador estável, ex.: "apply-02-ssh". */
  id: string;
  phase: SecurityPhaseId;
  phaseKey: SecurityPhaseKey;
  title: string;
  script: string;
  description: string;
  /** Checks do scan que esta ação corrige. */
  fixesCheckIds: string[];
  requiresConfirmation: boolean;
  hasRollback: boolean;
  /** Impacto potencial para o operador (null = sem impacto relevante). */
  impact: string | null;
  /** Pré-marcado na UI (fases com findings críticos). */
  preselected: boolean;
  /** Já está OK (nenhum check falhando) — aplicar seria no-op idempotente. */
  alreadySatisfied: boolean;
}

export interface SecurityPlan {
  id: string;
  createdAt: string;
  basedOnScanId: string;
  hardeningIndex: number | null;
  actions: SecurityPlanAction[];
}

// ---------------------------------------------------------------------------
// Jobs de aplicação (execução de uma fase)
// ---------------------------------------------------------------------------

export type SecurityJobStatus =
  | "queued"
  | "running"
  /** SSH/firewall aplicados; aguardando confirmação de acesso antes do rollback agendado. */
  | "awaiting_confirmation"
  | "success"
  | "failed"
  | "rolled_back";

export interface SecurityJobStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
}

export interface SecurityJob {
  id: string;
  phase: SecurityPhaseId;
  phaseKey: SecurityPhaseKey;
  title: string;
  dryRun: boolean;
  status: SecurityJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: SecurityJobStep[];
  /** Log bruto do script (stdout+stderr). */
  log: string;
  /** Rollback automático agendado no alvo (fases de risco). */
  rollbackScheduled: boolean;
  rollbackDeadline: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface SecurityScanResponse {
  report: SecurityScanReport;
  /** true se veio do cache de 60s. */
  cached: boolean;
}

export interface SecurityPlanRequest {
  /** Fases escolhidas pelo usuário (opcional; default = pré-selecionadas). */
  phases?: SecurityPhaseId[];
}

export interface SecurityApplyRequest {
  phase: SecurityPhaseId;
  dryRun: boolean;
}

export interface SecurityApplyResponse {
  job: SecurityJob;
}

export interface SecurityJobResponse {
  job: SecurityJob;
}

export interface SecurityConfirmAccessResponse {
  confirmed: boolean;
  job: SecurityJob | null;
}

export interface SecurityHistoryEntry {
  id: string;
  at: string;
  kind: "scan" | "job";
  /** Para scans: índice; para jobs: fase + status. */
  hardeningIndex?: number | null;
  phase?: SecurityPhaseId;
  dryRun?: boolean;
  status?: SecurityJobStatus;
}

export interface SecurityHistoryResponse {
  entries: SecurityHistoryEntry[];
  firstIndex: number | null;
  latestIndex: number | null;
}

/** Tempo de cache do scan (ms). */
export const SECURITY_SCAN_CACHE_MS = 60_000;

/** Janela de rollback automático agendado (ms) — alinhado a `at now +5 minutes`. */
export const SECURITY_ROLLBACK_WINDOW_MS = 5 * 60_000;
