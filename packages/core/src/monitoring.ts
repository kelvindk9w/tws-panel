/**
 * Tipos compartilhados da Fase 4 — Guardrails de deploy, baseline +
 * monitoramento contínuo, central de alertas e auditoria.
 * Spec: plano §5.4 e docs/internal/security-research.md §6.6.
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
  /**
   * Variável ou alvo do achado, quando há um (nome da variável, porta do container, ferramenta, imagem sem a tag,
   * arquivo): a identidade mais estável dele, usada pelas dispensas "não procede". Ausente = vale a evidência.
   */
  target?: string;
}

export interface GuardrailReport {
  ranAt: string;
  /** Diretório analisado. */
  dir: string;
  findings: GuardrailFinding[];
  blockers: number;
  warnings: number;
  infos: number;
  /** Achados que a pessoa marcou como "não procede" neste projeto (já fora de `findings` e das contagens). */
  dismissed?: number;
}

export interface GuardrailReportResponse {
  /** null quando o código-fonte ainda não está disponível localmente. */
  report: GuardrailReport | null;
  /** Nota explicativa (ex.: código ainda não ingerido no modo git). */
  note: string | null;
}

/** Chave estável de um bloqueio (regra + serviço + evidência): é o que a pessoa vê e aceita na tela. */
export function guardrailBlockKey(f: Pick<GuardrailFinding, "rule" | "service" | "evidence">): string {
  return `${f.rule}|${f.service ?? ""}|${f.evidence}`;
}

/** Bloqueios da checagem de agora que NÃO estão na lista aceita (a lista aceita pela pessoa na tela). */
export function unacceptedBlocks<T extends Pick<GuardrailFinding, "rule" | "service" | "evidence"> & { level?: string }>(
  findings: readonly T[],
  accepted: readonly string[],
): T[] {
  const ok = new Set(accepted);
  return findings.filter((f) => (f.level === undefined || f.level === "block") && !ok.has(guardrailBlockKey(f)));
}

// ---------------------------------------------------------------------------
// Dispensas "não procede" dos achados dos guardrails (por projeto)
// ---------------------------------------------------------------------------

/**
 * Regras que NENHUMA dispensa alcança: as de isolamento do painel (HARD_RULES de packages/deploy, sem override em
 * lugar nenhum), a 80/443 com proxy próprio (a tela não oferece override: o deploy falharia de qualquer jeito), as
 * que dão root na VPS (privileged, cap_add, devices, docker.sock por regra própria, namespaces e rede do host) e
 * o compose que nem abre. Um teste em packages/deploy garante que toda regra de HARD_RULES está aqui.
 */
export const GUARDRAIL_UNDISMISSABLE_RULES: readonly string[] = [
  "panel-image",
  "network-hijack",
  "reserved-name",
  "panel-resource",
  "proxy-port-conflict",
  "privileged-container",
  "host-namespace",
  "invalid-compose",
];

/** A regra aceita a marcação "não procede"? */
export function isGuardrailDismissible(rule: string): boolean {
  return !GUARDRAIL_UNDISMISSABLE_RULES.includes(rule);
}

/**
 * Regras que só avisam (warn/info no catálogo de packages/deploy; um teste lá confere). Dispensar um achado delas
 * pede só a sessão; as demais são de bloqueio e pedem a mesma prova do override (senha + 2FA).
 */
export const GUARDRAIL_NOTICE_RULES: readonly string[] = ["dev-service-in-prod", "secret-in-code", "latest-tag", "public-port-published"];

/** Dispensar este achado pede reautenticação? (regra de bloqueio: sim) */
export function guardrailDismissNeedsProof(rule: string): boolean {
  return !GUARDRAIL_NOTICE_RULES.includes(rule);
}

/** Abrangência de uma dispensa: só no serviço do achado ou em todos os serviços do projeto. */
export type GuardrailDismissalScope = "service" | "project";

export const GUARDRAIL_DISMISSAL_REASON_MAX = 500;
/** Teto de dispensas por projeto (o arquivo de projetos não cresce sem limite). */
export const GUARDRAIL_DISMISSALS_MAX = 200;

/** Um achado marcado como "não procede" num projeto. */
export interface GuardrailDismissal {
  id: string;
  rule: string;
  /** Serviço do compose; null = todos os serviços do projeto. */
  service: string | null;
  /** "target": vale a variável/alvo do achado; "evidence": vale a evidência normalizada (achado sem alvo). */
  match: "target" | "evidence";
  value: string;
  /** Título do achado quando foi dispensado (só para a tela). */
  title: string;
  /** Motivo escrito pela pessoa (opcional). */
  reason: string | null;
  /** Quem dispensou e quando. */
  by: string;
  at: string;
}

/** GET /api/projects/:id/guardrails/dismissals */
export interface GuardrailDismissalListResponse {
  dismissals: GuardrailDismissal[];
}

/** O achado, como a tela o recebeu (relatório do deploy ou aviso da detecção). */
export interface GuardrailDismissFinding {
  rule: string;
  title: string;
  evidence?: string;
  service?: string;
  target?: string;
}

/** POST /api/projects/:id/guardrails/dismissals */
export interface GuardrailDismissRequest {
  finding: GuardrailDismissFinding;
  scope: GuardrailDismissalScope;
  reason?: string;
  /** Reautenticação: obrigatória quando a regra é de bloqueio (a mesma prova do override do deploy). */
  currentPassword?: string;
  code?: string;
  emailCode?: string;
}

export interface GuardrailDismissResponse {
  dismissal: GuardrailDismissal;
  /** O alerta por e-mail ao dono não saiu (bloqueio dispensado): o motivo, para a tela. */
  alertWarning?: string;
}

/**
 * Evidência sem o que muda à toa: espaços repetidos e o nome do serviço no `serviço "<nome>"` da evidência (que
 * vira `serviço "*"`, para a mesma evidência valer em todos os serviços quando a dispensa é do projeto inteiro).
 * Só esse trecho é trocado: o mesmo nome entre aspas noutro ponto (volume, rede, imagem) é outro alvo e fica como
 * está. Nada mais é cortado (um `:80` no fim é parte do alvo, não número de linha): evidência diferente = achado
 * diferente.
 */
export function normalizeGuardrailEvidence(evidence: string, service?: string | null): string {
  const text = evidence.replace(/\s+/g, " ").trim();
  return service ? text.split(`serviço "${service}"`).join('serviço "*"') : text;
}

/** A identidade de um achado para as dispensas: o alvo, quando há; senão a evidência normalizada. */
export function guardrailFindingIdentity(f: Pick<GuardrailDismissFinding, "evidence" | "service" | "target">): {
  match: GuardrailDismissal["match"];
  value: string;
} {
  if (f.target) return { match: "target", value: f.target };
  return { match: "evidence", value: normalizeGuardrailEvidence(f.evidence ?? "", f.service) };
}

/** A dispensa que cobre este achado, ou null. Regra inegociável nunca é coberta, haja o que houver no arquivo. */
export function guardrailDismissalFor(
  f: Pick<GuardrailDismissFinding, "rule" | "evidence" | "service" | "target">,
  dismissals: readonly GuardrailDismissal[],
): GuardrailDismissal | null {
  if (!isGuardrailDismissible(f.rule)) return null;
  const id = guardrailFindingIdentity(f);
  return (
    dismissals.find(
      (d) => d.rule === f.rule && d.match === id.match && d.value === id.value && (d.service === null || d.service === (f.service ?? "")),
    ) ?? null
  );
}

/** Tira do relatório os achados dispensados e refaz as contagens (`dismissed` soma os que saíram). */
export function applyGuardrailDismissals(report: GuardrailReport, dismissals: readonly GuardrailDismissal[]): GuardrailReport {
  const findings = report.findings.filter((f) => !guardrailDismissalFor(f, dismissals));
  const removed = report.findings.length - findings.length;
  return {
    ...report,
    findings,
    blockers: findings.filter((f) => f.level === "block").length,
    warnings: findings.filter((f) => f.level === "warn").length,
    infos: findings.filter((f) => f.level === "info").length,
    ...(removed > 0 || report.dismissed ? { dismissed: (report.dismissed ?? 0) + removed } : {}),
  };
}

/** Entradas válidas de uma lista lida do disco (o resto é ignorado: um item estragado não derruba o deploy). */
export function validGuardrailDismissals(raw: unknown): GuardrailDismissal[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  return raw.filter((v): v is GuardrailDismissal => {
    if (!v || typeof v !== "object") return false;
    const d = v as Record<string, unknown>;
    return (
      str(d.id) &&
      str(d.rule) &&
      (d.service === null || str(d.service)) &&
      (d.match === "target" || d.match === "evidence") &&
      str(d.value) &&
      typeof d.title === "string" &&
      (d.reason === null || typeof d.reason === "string") &&
      typeof d.by === "string" &&
      str(d.at)
    );
  });
}

export interface DeployRequest {
  /** Confirmação explícita para prosseguir mesmo com findings "block". */
  guardrailOverride?: boolean;
  /** Reautenticação, obrigatória com `guardrailOverride: true` (mesma prova de habilitar o terminal). */
  currentPassword?: string;
  code?: string;
  emailCode?: string;
  /**
   * Obrigatória com `guardrailOverride: true`: as chaves (guardrailBlockKey) dos bloqueios que a pessoa viu e
   * aceitou. Se a checagem do deploy achar qualquer bloqueio fora da lista, o deploy é recusado (guardrail_changed).
   */
  acceptedBlocks?: string[];
}

// ---------------------------------------------------------------------------
// Central de alertas
// ---------------------------------------------------------------------------

export type AlertSeverity = "critical" | "warning" | "info";
/** Origem de um alerta. Toda origem aqui é de fato produzida em código. */
export type AlertSource = "guardrail" | "scan" | "blacklist" | "certificate" | "login" | "resources";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
export const ALERT_SOURCES: readonly AlertSource[] = ["guardrail", "scan", "blacklist", "certificate", "login", "resources"];
export const ALERT_STATUSES: readonly AlertStatus[] = ["open", "acknowledged", "resolved"];

export interface Alert {
  id: string;
  severity: AlertSeverity;
  source: AlertSource;
  title: string;
  detail: string;
  /** Projeto do painel a que o alerta se refere (alertas de serviço/container); ausente/null = alerta geral. */
  projectSlug?: string | null;
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
/**
 * Intervalo máximo aceito: 168 h (uma semana), o mesmo teto da tela de
 * Notificações. Precisa ficar abaixo de 2^31-1 ms (~24,8 dias): acima disso o
 * Node troca o atraso do setInterval por 1 ms e o scan passa a rodar sem parar.
 */
export const MONITOR_MAX_INTERVAL_MS = 168 * 60 * 60 * 1000;
