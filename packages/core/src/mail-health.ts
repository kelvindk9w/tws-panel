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
 *  - info: bônus ou informação, nunca pesa no estado geral.
 */
export type MailHealthLevel = "ok" | "warn" | "critical" | "info";

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
}

export interface DeliveryHealthResponse {
  domain: string;
  checkedAt: string;
  /** Pior estado entre as verificações que pesam. */
  level: Exclude<MailHealthLevel, "info">;
  counts: { ok: number; warn: number; critical: number };
  checks: MailHealthCheck[];
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
