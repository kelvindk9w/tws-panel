/**
 * Saúde de entregabilidade do domínio de e-mail: tipos compartilhados entre o
 * servidor (packages/mailer + apps/server) e a interface.
 *
 * Nada aqui promete caixa de entrada: provedor nenhum publica a fórmula. O
 * painel mede o que dá para medir e diz se o remetente está conforme o que
 * Gmail, Yahoo e Microsoft pedem.
 */

/**
 * Estado de uma verificação:
 *  - ok: conforme o que os grandes provedores pedem de quem envia;
 *  - warn: atenção, pode atrasar a entrega ou mandar para o spam;
 *  - critical: provavelmente impede ou prejudica muito a entrega;
 *  - info: bônus ou informação, nunca pesa no estado geral;
 *  - optional: item opcional (MTA-STS, TLS-RPT) ainda não configurado ou
 *    incompleto. Aparece com o "O que fazer", mas não conta em "atenção" e não
 *    muda o selo do domínio nem o geral.
 */
export type MailHealthLevel = "ok" | "warn" | "critical" | "info" | "optional";

export type MailHealthCheckId =
  | "a"
  | "helo"
  | "mx"
  | "spf"
  | "dkim"
  | "dmarc"
  | "ptr"
  | "port25"
  | "queue"
  | "tls"
  | "dnsbl"
  | "propagation"
  | "mta_sts"
  | "tls_rpt";

export interface MailHealthCheck {
  id: MailHealthCheckId;
  level: MailHealthLevel;
  /** Afeta direto a chegada à caixa de entrada (entra no aviso de topo quando não está ok). */
  inbox: boolean;
  /** Código estável da mensagem; a interface traduz (mail.health.msg.<id>.<code>). */
  code: string;
  /** Valores para o texto da mensagem. */
  params: Record<string, string | number>;
  expected?: string;
  found?: string[];
  /**
   * "Marcado como ciente" por um admin (só itens que dependem do provedor, como o PTR):
   * continua visível e com o seu nível, mas não conta em "atenção" nem no aviso do topo.
   * Some sozinho quando o problema muda (ver mailHealthFingerprint).
   */
  acknowledged?: MailHealthAcknowledgement;
}

/** Marcação "ciente" aplicada a um item. */
export interface MailHealthAcknowledgement {
  /** Motivo escrito por quem marcou (opcional). */
  reason: string | null;
  at: string;
  by: string | null;
}

/**
 * Itens que dependem do provedor da VPS e podem ser marcados como "ciente":
 * o nome reverso do IP (PTR) e a porta 25 de saída. Os demais dependem só do
 * painel e do DNS do domínio: a pessoa resolve, não marca.
 */
export const MAIL_HEALTH_ACKNOWLEDGEABLE: readonly MailHealthCheckId[] = ["ptr", "port25"];

export function isMailHealthAcknowledgeable(id: string): id is MailHealthCheckId {
  return (MAIL_HEALTH_ACKNOWLEDGEABLE as readonly string[]).includes(id);
}

/** Tamanho máximo do motivo guardado junto da marcação. */
export const MAIL_HEALTH_ACK_REASON_MAX = 300;

/**
 * Impressão do problema no momento em que a pessoa marcou "ciente": nível, código
 * da mensagem, valor esperado e o que foi encontrado. Se qualquer um mudar (o PTR
 * passou a apontar para outro nome, o item virou crítico), a marcação deixa de
 * valer e o item volta a contar.
 */
export function mailHealthFingerprint(check: Pick<MailHealthCheck, "level" | "code" | "expected" | "found">): string {
  return [check.level, check.code, check.expected ?? "", ...(check.found ?? [])].join("|");
}

/** O item pesa no resumo e no aviso do topo? (nem opcional, nem informativo, nem "ciente") */
export function mailHealthCounts(check: Pick<MailHealthCheck, "level" | "acknowledged">): boolean {
  return (check.level === "ok" || check.level === "warn" || check.level === "critical") && !check.acknowledged;
}

/**
 * Onde a verificação vale:
 *  - server: é do servidor/IP e vale para TODOS os projetos e domínios
 *    (nome reverso do IP, porta 25 de saída, certificado, listas de bloqueio);
 *  - domain: é do domínio (A do servidor de e-mail, MX, SPF, DKIM, DMARC,
 *    propagação, MTA-STS, TLS-RPT e a fila: ela só olha as mensagens enviadas
 *    por endereços @domínio, então uma falha de autenticação ali é do domínio).
 */
export type MailHealthScope = "server" | "domain";

const SERVER_SCOPE_IDS: ReadonlySet<MailHealthCheckId> = new Set<MailHealthCheckId>([
  "helo",
  "ptr",
  "port25",
  "tls",
  "dnsbl",
]);

export function mailHealthScope(id: MailHealthCheckId): MailHealthScope {
  return SERVER_SCOPE_IDS.has(id) ? "server" : "domain";
}

/** Resumo de um dos dois níveis (servidor ou domínio). */
export type MailHealthCounts = {
  ok: number;
  warn: number;
  critical: number;
  /** Itens opcionais incompletos ou não configurados (não pesam). */
  optional: number;
  /** Itens marcados como "ciente" (não pesam). */
  acknowledged: number;
};

export interface MailHealthScopeSummary {
  level: "ok" | "warn" | "critical";
  counts: MailHealthCounts;
}

export interface DeliveryHealthResponse {
  domain: string;
  checkedAt: string;
  /** Pior estado entre as verificações que pesam. */
  level: "ok" | "warn" | "critical";
  counts: MailHealthCounts;
  checks: MailHealthCheck[];
  /** Mesmo resumo, separado por nível: o que é do servidor e o que é deste domínio. */
  scopes: Record<MailHealthScope, MailHealthScopeSummary>;
  /** Verificações que afetam a caixa de entrada e não estão ok. */
  inboxIssues: MailHealthCheckId[];
}

export type DnsPlanNeed = "required" | "recommended" | "optional";

/** Um registro a criar no provedor de DNS do domínio, na ordem sugerida. */
export interface DnsPlanRecord {
  id: string;
  order: number;
  type: "A" | "AAAA" | "MX" | "TXT";
  /** Nome completo do registro. */
  name: string;
  value: string;
  priority?: number;
  need: DnsPlanNeed;
  /** Chave da frase que explica para que serve (mail.health.plan.<id>.purpose). */
  purpose: string;
  /** Sempre "somente DNS" (nuvem cinza do Cloudflare): registro de e-mail nunca passa pelo proxy. */
  proxied: false;
}

export interface DnsPlanResponse {
  domain: string;
  serverHostname: string;
  records: DnsPlanRecord[];
  /** Conteúdo do arquivo da política MTA-STS (opcional, avançado). */
  mtaStsPolicy: string;
  /** Nome reverso (PTR) esperado: configurado no painel do provedor da VPS, não no DNS do domínio. */
  ptr: { ip: string; expected: string };
}

export interface DeliveryHealthStateResponse {
  plan: DnsPlanResponse;
  /** Última verificação (null = ainda não rodou desde que o painel subiu). */
  report: DeliveryHealthResponse | null;
}

/** Intervalo mínimo entre duas verificações do mesmo domínio (botão "Verificar agora"); a interface espera o mesmo tempo. */
export const MAIL_HEALTH_MIN_INTERVAL_MS = 15_000;
