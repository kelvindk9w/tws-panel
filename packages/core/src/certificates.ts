/**
 * certificates.ts — página Certificados: todos os nomes que o painel serve
 * por HTTPS (painel, domínios dos projetos e mail.<domínio>), o estado do
 * certificado de cada um e o modo (automático pelo Caddy ou manual).
 */

/** A quem o nome pertence. */
export type CertificateOwnerKind = "panel" | "project" | "mail";

export interface CertificateOwner {
  kind: CertificateOwnerKind;
  /** Projeto (só quando kind = "project"). */
  projectId: string | null;
  projectName: string | null;
}

/**
 * - automatic: o Caddy emite e renova sozinho (Let's Encrypt, ZeroSSL de reserva);
 * - manual: certificado enviado pela pessoa; NÃO renova sozinho.
 */
export type CertificateMode = "automatic" | "manual";

/**
 * Estado do certificado servido de verdade:
 * - valid: válido e longe do fim;
 * - issuing: ainda sem certificado, emissão em andamento (ou esperando a próxima tentativa sem erro conhecido);
 * - failed: sem certificado e a última tentativa do Caddy falhou;
 * - expiring: válido, mas perto do fim, proporcional à validade (ver certificateThresholds):
 *   manual a 1/3 da validade (no máximo 30 dias); automático que não renovou a 1/4 da validade;
 * - expired: o certificado servido já venceu;
 * - unknown: não foi possível conferir (proxy fora do ar);
 * - waiting: domínio dinâmico (emissão sob demanda) que ainda não recebeu o primeiro acesso: o certificado
 *   só sai quando o DNS aponta para a VPS e alguém abre o endereço. Não é falha.
 */
export type CertificateState = "valid" | "issuing" | "failed" | "expiring" | "expired" | "unknown" | "waiting";

/** Causa provável de uma falha de emissão, traduzida para leigo. */
export type CertificateErrorCause = "dns" | "cloudflare" | "firewall" | "rate_limit" | "caa" | "unknown";

export interface CertificateIssueError {
  cause: CertificateErrorCause;
  /** Explicação em pt-BR, com o que fazer. */
  message: string;
  /** Trecho da mensagem do Caddy (texto não confiável, já limitado e sem caracteres de controle). */
  detail: string | null;
  /** Quando aconteceu (ISO), se o log informa. */
  at: string | null;
  /** Limite do Let's Encrypt: a partir de quando dá para tentar de novo (ISO). */
  retryAfter: string | null;
}

// ---------------------------------------------------------------------------
// Janelas proporcionais à validade (alerta de renovação)
// ---------------------------------------------------------------------------

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
export const CERTIFICATE_DAY_MS = 24 * HOUR_MS;

/** Validade presumida quando o início não é conhecido (Let's Encrypt até fev/2027). */
export const DEFAULT_CERTIFICATE_VALIDITY_MS = 90 * CERTIFICATE_DAY_MS;
/** O Caddy (certmagic) renova quando falta 1/3 da validade. */
export const RENEWAL_WINDOW_FRACTION = 1 / 3;
/** Automático: avisa quando falta 1/4 da validade — 1/12 de folga depois de o Caddy começar a renovar. */
export const AUTO_WARN_FRACTION = 1 / 4;
/** Manual (não renova sozinho): avisa com 1/3 da validade restante... */
export const MANUAL_WARN_FRACTION = 1 / 3;
/** ...mas nunca com mais de 30 dias de antecedência. */
export const MAX_WARN_MS = 30 * CERTIFICATE_DAY_MS;
/**
 * Mínimo do aviso do certificado MANUAL: nunca menos de 12 h. O automático não tem
 * piso: o aviso dele fica 1/12 da validade depois de o Caddy começar a renovar,
 * e um piso de 12 h o acenderia ANTES da renovação em certificados de menos de 48 h.
 */
export const MIN_WARN_MS = 12 * HOUR_MS;
/** Crítico: 1/12 da validade, entre 6 h e 7 dias, e no máximo metade do aviso. */
export const CRITICAL_FRACTION = 1 / 12;
export const MIN_CRITICAL_MS = 6 * HOUR_MS;
export const MAX_CRITICAL_MS = 7 * CERTIFICATE_DAY_MS;

/** Falha de emissão só vira alerta com pelo menos 3 rodadas de tentativa... */
export const FAILURE_MIN_ROUNDS = 3;
/** ...durando pelo menos 1 h (domínio novo com o DNS ainda por apontar não é alerta)... */
export const FAILURE_MIN_DURATION_MS = HOUR_MS;
/** ...e é crítico quando dura 24 h ou mais. */
export const FAILURE_CRITICAL_MS = 24 * HOUR_MS;

export interface CertificateThresholds {
  /** Antecedência em que o Caddy começa a renovar (1/3 da validade). */
  renewBeforeMs: number;
  /** Falta isto ou menos: "vence em breve" (atenção). */
  warnMs: number;
  /** Falta isto ou menos: crítico. */
  criticalMs: number;
}

/**
 * Validade total do certificado em ms. Sem o início (ou com datas
 * incoerentes) presume 90 dias.
 */
export function certificateValidityMs(validFrom: string | null | undefined, validTo: string): number {
  const to = Date.parse(validTo);
  const from = validFrom ? Date.parse(validFrom) : NaN;
  const span = to - from;
  return Number.isFinite(span) && span > 0 ? span : DEFAULT_CERTIFICATE_VALIDITY_MS;
}

/**
 * Janelas de renovação e de alerta, proporcionais à validade total. Funciona
 * para 90, 64, 45 e 6 dias (calendário do Let's Encrypt até 2028) e para
 * certificados próprios de 1 ano.
 *
 *  - renovação do Caddy: 1/3 da validade (30 d em 90 d; 21,3 d em 64 d; 15 d em 45 d; 2 d em 6 d);
 *  - aviso automático: 1/4 (22,5 d; 16 d; 11,25 d; 36 h) — o Caddy já devia ter renovado;
 *  - aviso manual: 1/3, no máximo 30 dias (certificado próprio de 1 ano avisa com 30 dias);
 *  - todo aviso tem no máximo metade da validade; o manual, no mínimo 12 h (o automático
 *    nunca avisa antes de passar o ponto em que o Caddy renova: 1/4 < 1/3, mesmo com 12 h de validade);
 *  - crítico: 1/12 da validade entre 6 h e 7 dias, no máximo metade do aviso.
 */
export function certificateThresholds(validityMs: number, mode: CertificateMode): CertificateThresholds {
  const fraction = mode === "automatic" ? AUTO_WARN_FRACTION : MANUAL_WARN_FRACTION;
  const proportional = validityMs * fraction;
  const wanted = Math.min(mode === "automatic" ? proportional : Math.max(proportional, MIN_WARN_MS), MAX_WARN_MS);
  const warnMs = Math.min(wanted, validityMs / 2);
  const criticalMs = Math.min(Math.max(validityMs * CRITICAL_FRACTION, MIN_CRITICAL_MS), MAX_CRITICAL_MS, warnMs / 2);
  return { renewBeforeMs: validityMs * RENEWAL_WINDOW_FRACTION, warnMs, criticalMs };
}

/** Quando o Caddy deve renovar (ISO): fim da validade − 1/3 da validade total. */
export function expectedRenewalAt(validFrom: string | null | undefined, validTo: string): string {
  const { renewBeforeMs } = certificateThresholds(certificateValidityMs(validFrom, validTo), "automatic");
  return new Date(Date.parse(validTo) - renewBeforeMs).toISOString();
}

export type CertificateValidityTier = "ok" | "warning" | "critical" | "expired";

/** Em que faixa da validade o certificado está agora (fronteiras inclusivas: "falta ≤ janela"). */
export function certificateValidityTier(
  mode: CertificateMode,
  validFrom: string | null | undefined,
  validTo: string,
  nowMs: number,
): CertificateValidityTier {
  const left = Date.parse(validTo) - nowMs;
  if (left <= 0) return "expired";
  const t = certificateThresholds(certificateValidityMs(validFrom, validTo), mode);
  if (left <= t.criticalMs) return "critical";
  if (left <= t.warnMs) return "warning";
  return "ok";
}

export type CertificateAlertLevel = "none" | "warning" | "critical";

/**
 * - expired: o certificado servido venceu;
 * - expiring: certificado próprio perto do fim;
 * - renewal_late: automático que o Caddy devia ter renovado e não renovou;
 * - issuance_failing: o Caddy tenta emitir/renovar e falha repetidamente (log).
 */
export type CertificateAlertReason = "expired" | "expiring" | "renewal_late" | "issuance_failing";

export interface CertificateAlertAssessment {
  level: CertificateAlertLevel;
  reason: CertificateAlertReason | null;
}

/** Falha de emissão em curso, resumida do log do Caddy (rodadas de tentativa desde o último sucesso). */
export interface CertificateFailureSummary {
  rounds: number;
  /** Primeira falha desde o último sucesso (ISO). */
  firstAt: string | null;
  /** Falha mais recente (ISO). */
  lastAt: string | null;
}

/** A falha como a API mostra: o resumo do log e a causa traduzida da última tentativa. */
export interface CertificateItemFailure extends CertificateFailureSummary {
  error: CertificateIssueError | null;
}

/** A falha já é "repetida" o bastante para alertar (3 rodadas e 1 h). */
export function isFailureConfirmed(failure: CertificateFailureSummary | null | undefined): boolean {
  if (!failure || failure.rounds < FAILURE_MIN_ROUNDS) return false;
  return failureDurationMs(failure) >= FAILURE_MIN_DURATION_MS;
}

function failureDurationMs(failure: CertificateFailureSummary): number {
  const first = failure.firstAt ? Date.parse(failure.firstAt) : NaN;
  const last = failure.lastAt ? Date.parse(failure.lastAt) : NaN;
  return Number.isFinite(first) && Number.isFinite(last) ? last - first : 0;
}

export interface CertificateAlertInput {
  mode: CertificateMode;
  nowMs: number;
  /** Certificado servido (null = nenhum). */
  validFrom: string | null;
  validTo: string | null;
  /** O proxy serviu um certificado já vencido. */
  servedExpired?: boolean;
  failure?: CertificateFailureSummary | null;
}

/**
 * Avaliação única do alerta de um certificado (tela, alertas e notificações
 * usam a mesma). Não conhece Caddyfile nem projeto: serve a qualquer nome
 * (inclusive os de emissão sob demanda).
 */
export function assessCertificateAlert(input: CertificateAlertInput): CertificateAlertAssessment {
  if (input.servedExpired) return { level: "critical", reason: "expired" };
  if (input.validTo) {
    const tier = certificateValidityTier(input.mode, input.validFrom, input.validTo, input.nowMs);
    const reason: CertificateAlertReason = input.mode === "automatic" ? "renewal_late" : "expiring";
    if (tier === "expired") return { level: "critical", reason: "expired" };
    if (tier === "critical") return { level: "critical", reason };
    if (tier === "warning") return { level: "warning", reason };
  }
  if (input.mode === "automatic" && isFailureConfirmed(input.failure)) {
    const long = input.validTo === null && failureDurationMs(input.failure!) >= FAILURE_CRITICAL_MS;
    return { level: long ? "critical" : "warning", reason: "issuance_failing" };
  }
  return { level: "none", reason: null };
}

export interface ManualCertificateInfo {
  /** Emissor (organização ou nome) do certificado enviado. */
  issuer: string | null;
  validFrom: string;
  validTo: string;
  /** Nomes que o certificado cobre (ex.: "*.exemplo.com.br"). */
  names: string[];
  installedAt: string;
}

export interface CertificateItem {
  host: string;
  owner: CertificateOwner;
  mode: CertificateMode;
  /**
   * Modo manual herdado: o nome não tem certificado próprio, mas um
   * certificado manual de outro nome (wildcard) o cobre — o Caddy usa esse e
   * não emite um automático para este nome.
   */
  coveredBy: string | null;
  state: CertificateState;
  issuer: string | null;
  validTo: string | null;
  /** Automático: data aproximada da renovação (fim da validade − 1/3 da validade total). */
  renewsAround: string | null;
  /** Início da validade do certificado servido (ISO). Com validTo dá a validade total (90, 64, 45, 6 dias…). */
  validFrom: string | null;
  /** Alerta que esta tela e as notificações usam: a mesma avaliação (assessCertificateAlert). */
  alert: CertificateAlertAssessment;
  /** Emissão/renovação falhando de forma repetida segundo o log do Caddy (null = sem falha em curso). */
  failure: CertificateItemFailure | null;
  /**
   * false = o log do Caddy não pôde ser lido (ilegível ou vazio, ex.: container recriado):
   * "failure: null" não significa "sem falha". Ausente = conhecido.
   */
  failureKnown?: boolean;
  /** Último erro de emissão (só quando não há certificado válido). */
  lastError: CertificateIssueError | null;
  /** Certificado manual deste nome (nunca a chave). */
  manual: ManualCertificateInfo | null;
  /** Dá para pedir "Tentar emitir agora" (automático sem certificado válido). */
  canRetry: boolean;
}

export interface CertificateListResponse {
  checkedAt: string;
  /** O proxy central (Caddy) está rodando. */
  proxyRunning: boolean;
  items: CertificateItem[];
}

export interface CertificateRetryResponse {
  host: string;
  /** Mensagem para a pessoa (pt-BR). */
  message: string;
}

export interface InstallManualCertificateRequest {
  /** PEM do certificado, com a cadeia (intermediários). */
  certificate: string;
  /** PEM da chave privada. Nunca volta pela API. */
  privateKey: string;
}

export interface CertificateItemResponse {
  item: CertificateItem;
}

/**
 * Id do certificado de um host: nome dos arquivos .crt/.key (painel, Caddy e
 * Stalwart) e da seção [certificate.<id>] do Stalwart. Só letras minúsculas,
 * números, hífen e sublinhado (arquivo e chave TOML sem aspas).
 *
 * Sem colisão (achado 7 da revisão): ponto vira "-" e hífen vira "--". Num
 * hostname válido o hífen nunca encosta no ponto (o rótulo não começa nem
 * termina com hífen), então um "-" sozinho só pode ser ponto e uma sequência
 * par de hífens só pode ser hífen. Qualquer outro caractere (ex.: "*") vira
 * "_<hex>_". Um nome sem hífen fica com o mesmo id da regra antiga.
 */
export function certificateFileId(host: string): string {
  let out = "";
  for (const ch of host.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (ch === ".") out += "-";
    else if (ch === "-") out += "--";
    else out += `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  return out;
}

/**
 * Regra antiga (trocava qualquer sequência fora de letra/número por hífen e
 * colidia). Só para achar o que já está gravado com o nome antigo e migrar.
 */
export function legacyCertificateFileId(host: string): string {
  return host.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
