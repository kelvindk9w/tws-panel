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

/**
 * Perfil do alvo do scan/hardening:
 *  - "host": VPS real (via host bridge nsenter) — todos os checks se aplicam;
 *  - "container": container Docker descartável (dev/teste) — checks de host
 *    (ufw, sshd, fail2ban, snapd, etc.) são pulados para não gerar
 *    falsos-positivos de contexto.
 */
export type SecurityTargetProfile = "host" | "container";

/** Check pulado por não se aplicar ao perfil do alvo (documentado no relatório). */
export interface SecuritySkippedCheck {
  id: string;
  title: string;
  /** Motivo (pt-BR) pelo qual o check não se aplica ao perfil do alvo. */
  reason: string;
}

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
  /** Perfil do alvo: "host" (VPS real) ou "container" (dev/teste). */
  profile: SecurityTargetProfile;
  /** Checks pulados por não se aplicarem ao perfil (ex.: ufw em container). */
  skippedChecks: SecuritySkippedCheck[];
  /** Nota de contexto do perfil (pt-BR) exibida no relatório; null no perfil host. */
  profileNote: string | null;
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
  /** Fase 01: usuário não-root criado (para a UI instruir o teste de login). */
  sshUser?: string;
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
  /** Fase 01: nome do usuário não-root a criar (default "deploy"). */
  sshUser?: string;
  /** Fase 01: chave pública SSH do operador (instalada no novo usuário). */
  sshPublicKey?: string;
}

// ---------------------------------------------------------------------------
// Validação de chave SSH / usuário (Fase 01) — usada no servidor e na UI
// ---------------------------------------------------------------------------

/**
 * Formato de authorized_keys: "<tipo> <base64> [comentário]".
 * O comentário nunca pode conter aspas/quebras de linha (a chave é injetada
 * em comando shell single-quoted pelo executor).
 */
const SSH_PUBKEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]{40,}={0,2})( [^\r\n'"\\]{0,120})?$/;

export function isValidSshPublicKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 50 || trimmed.length > 2048) return false;
  return SSH_PUBKEY_RE.test(trimmed);
}

/** Nome de usuário Linux seguro (minúsculas, começa com letra/_, nunca root). */
export function isValidSshUsername(name: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(name) && name !== "root";
}

// ---------------------------------------------------------------------------
// Modo manual por fase (o operador executa os comandos por conta própria)
// ---------------------------------------------------------------------------

export interface SecurityManualCommandsResponse {
  phase: SecurityPhaseId;
  phaseKey: SecurityPhaseKey;
  title: string;
  script: string;
  /** Comandos exatos (copiáveis) para executar a fase manualmente no alvo. */
  commands: string[];
  /** Conteúdo do script da fase (para conferência/cópia). */
  scriptContent: string;
  /** Observações de contexto (pt-BR). */
  notes: string[];
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
