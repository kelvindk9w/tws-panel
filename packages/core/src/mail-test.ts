/**
 * mail-test.ts — caixa de teste de e-mail do projeto (Mailpit).
 *
 * Com a opção ligada, o SMTP do projeto aponta para um Mailpit dedicado (rede
 * interna, sem saída para a internet, sem relay): nada chega a destinatário
 * real e o dono lê as mensagens dentro do painel.
 * Ver comoFuncionaSistema/email/caixa-de-teste.json.
 */

/** Porta SMTP do Mailpit (sem TLS) e porta da API/interface (nunca publicada). */
export const MAILTEST_SMTP_PORT = 1025;
export const MAILTEST_HTTP_PORT = 8025;

/**
 * Rede interna (sem saída) onde o painel e todos os Mailpit se encontram. O nome NÃO tem o
 * hífen depois de "mailtest": nenhum slug de projeto o forma (a rede de cada projeto é
 * `paas-mailtest-<slug>`).
 */
export const PAAS_MAILTEST_ADMIN_NETWORK = "paas-mailtestadm";

/** Retenção padrão e limites aceitos (configuráveis por projeto). */
export const MAILTEST_DEFAULT_MAX_MESSAGES = 500;
export const MAILTEST_DEFAULT_MAX_AGE_DAYS = 7;
export const MAILTEST_MAX_MESSAGES_RANGE = { min: 10, max: 5000 } as const;
export const MAILTEST_MAX_AGE_DAYS_RANGE = { min: 1, max: 30 } as const;

/** Nome do container, da rede do projeto e do volume de dados da caixa de teste de um projeto. */
export const mailTestContainerName = (slug: string): string => `paas-mailtest-${slug}`;
export const mailTestNetworkName = (slug: string): string => `paas-mailtest-${slug}`;
export const mailTestVolumeName = (slug: string): string => `paas-mailtest-${slug}-data`;

/** Usuário fixo que o app recebe em SMTP_USER (o Mailpit aceita qualquer um; a senha é gerada por projeto). */
export const MAILTEST_SMTP_USER = "mailtest";

export interface MailTestSettings {
  enabled: boolean;
  maxMessages: number;
  maxAgeDays: number;
}

/** Quem está falando com o Mailpit e como o app o alcança (nunca a senha). */
export interface MailTestView {
  enabled: boolean;
  settings: MailTestSettings;
  /** Situação do container: running, stopped, missing (ligada, mas o container não existe) ou off. */
  container: "running" | "stopped" | "missing" | "off";
  /** Host que o app recebe em SMTP_HOST enquanto a caixa está ligada. */
  smtpHost: string;
  smtpPort: number;
  /** Nomes de variáveis do projeto que o painel redireciona (as SMTP_* e as ligadas ao e-mail). */
  redirectedVariables: string[];
  /** O projeto já foi publicado e os containers ainda usam o SMTP de antes da última mudança. */
  needsRestart: boolean;
  /** Mensagens guardadas agora (null = não deu para ler). */
  messages: number | null;
  unread: number | null;
  /** Erro ao ler o Mailpit, em português (a tela mostra no lugar da lista). */
  problem: string | null;
}

export interface MailTestAddress {
  name: string;
  address: string;
}

export interface MailTestMessageSummary {
  id: string;
  subject: string;
  from: MailTestAddress | null;
  to: MailTestAddress[];
  /** ISO 8601. */
  created: string;
  read: boolean;
  size: number;
  attachments: number;
  snippet: string;
}

export interface MailTestListResponse {
  total: number;
  unread: number;
  start: number;
  messages: MailTestMessageSummary[];
}

export interface MailTestAttachment {
  partId: string;
  fileName: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface MailTestMessage extends MailTestMessageSummary {
  cc: MailTestAddress[];
  bcc: MailTestAddress[];
  replyTo: MailTestAddress[];
  /** Texto simples da mensagem (vazio se só há HTML). */
  text: string;
  hasHtml: boolean;
  /** Cabeçalhos brutos, na ordem em que o Mailpit os devolve. */
  headers: Array<{ name: string; value: string }>;
  attachmentList: MailTestAttachment[];
  /** Endereços http(s) que aparecem no corpo (o HTML não os deixa clicar na tela). */
  links: string[];
}

export interface MailTestUpdateRequest {
  enabled: boolean;
  maxMessages?: number;
  maxAgeDays?: number;
  /** Obrigatório ao desligar: apagar também as mensagens guardadas? */
  deleteMessages?: boolean;
}

/**
 * Papel de cada nome de variável de SMTP que o painel redireciona quando o projeto as define nas
 * Variáveis (os apps usam nomes diferentes para a mesma coisa). Só nomes conhecidos: o painel
 * nunca adivinha o que uma variável qualquer significa.
 */
export type MailTestRole = "host" | "port" | "user" | "pass" | "secure";

export const MAILTEST_VARIABLE_ROLES: Readonly<Record<string, MailTestRole>> = {
  SMTP_HOST: "host",
  SMTP_PORT: "port",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "pass",
  SMTP_SERVER: "host",
  SMTP_SECURE: "secure",
  SMTP_TLS: "secure",
  SMTP_SSL: "secure",
  SMTP_STARTTLS: "secure",
  SMTP_REQUIRE_TLS: "secure",
  MAIL_HOST: "host",
  MAIL_PORT: "port",
  MAIL_USERNAME: "user",
  MAIL_PASSWORD: "pass",
  MAIL_ENCRYPTION: "secure",
  MAIL_SERVER: "host",
  EMAIL_HOST: "host",
  EMAIL_PORT: "port",
  EMAIL_HOST_USER: "user",
  EMAIL_HOST_PASSWORD: "pass",
  EMAIL_USE_TLS: "secure",
  EMAIL_USE_SSL: "secure",
};

/** As quatro que o painel entrega sozinho quando a caixa está ligada (mesmos nomes do e-mail do projeto). */
const BASE_ROLES = { SMTP_HOST: "host", SMTP_PORT: "port", SMTP_USER: "user", SMTP_PASS: "pass" } as const;

/** Valor de cada papel para um Mailpit (sem TLS: o app tem de falar SMTP simples). */
export function mailTestValue(role: MailTestRole, target: { host: string; password: string }): string {
  switch (role) {
    case "host":
      return target.host;
    case "port":
      return String(MAILTEST_SMTP_PORT);
    case "user":
      return MAILTEST_SMTP_USER;
    case "pass":
      return target.password;
    case "secure":
      return "false";
  }
}

/** As SMTP_HOST/PORT/USER/PASS que o app recebe enquanto a caixa de teste está ligada. */
export function mailTestEnv(target: { host: string; password: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, role] of Object.entries(BASE_ROLES)) out[name] = mailTestValue(role, target);
  return out;
}

/**
 * Das variáveis que o projeto define (nomes), as que o painel redireciona: as de nome conhecido
 * (MAILTEST_VARIABLE_ROLES). Devolve nome → novo valor. As quatro SMTP_* base não entram: já vêm de mailTestEnv.
 */
export function mailTestUserOverrides(names: Iterable<string>, target: { host: string; password: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const role = MAILTEST_VARIABLE_ROLES[name];
    if (role === undefined) continue;
    // Laravel lê "null" como "sem criptografia"; "false" não é um valor dele
    out[name] = name === "MAIL_ENCRYPTION" ? "null" : mailTestValue(role, target);
  }
  return out;
}
