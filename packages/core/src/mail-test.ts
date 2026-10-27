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
  /** Variáveis de e-mail achadas no projeto (.env, compose, env_file, Dockerfile, Variáveis) que o painel NÃO redireciona. */
  uncontrolled: MailTestUncontrolled[];
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
 * Papel de cada nome de variável de SMTP que o painel entrega ao app enquanto a caixa está ligada (os
 * apps usam nomes diferentes para a mesma coisa). Só nomes conhecidos: o painel nunca adivinha o que
 * uma variável qualquer significa. TODOS são injetados SEMPRE, em todos os serviços, com precedência sobre
 * `environment:`/`env_file:`/.env versionado/ENV do Dockerfile: quem não define nada também fica protegido.
 *  - host/port/user/pass/secure: partes do servidor SMTP;
 *  - url: URL única (smtp://usuário:senha@host:porta), a forma de Symfony, Meteor, django-environ, NextAuth…;
 *  - mailer: nome do transporte, que tem de ser "smtp" (Laravel `MAIL_MAILER=log|ses|mailgun` ignoraria o host).
 */
export type MailTestRole = "host" | "port" | "user" | "pass" | "secure" | "url" | "mailer";

export const MAILTEST_VARIABLE_ROLES: Readonly<Record<string, MailTestRole>> = {
  SMTP_HOST: "host",
  SMTP_PORT: "port",
  SMTP_USER: "user",
  SMTP_PASS: "pass",
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "pass",
  SMTP_SERVER: "host",
  SMTP_ADDRESS: "host",
  SMTP_LOGIN: "user",
  SMTP_SERVER_HOST: "host",
  SMTP_SERVER_PORT: "port",
  SMTP_SECURE: "secure",
  SMTP_TLS: "secure",
  SMTP_SSL: "secure",
  SMTP_STARTTLS: "secure",
  SMTP_REQUIRE_TLS: "secure",
  SMTP_ENABLE_STARTTLS_AUTO: "secure",
  SMTP_URL: "url",
  MAIL_HOST: "host",
  MAIL_PORT: "port",
  MAIL_USERNAME: "user",
  MAIL_PASSWORD: "pass",
  MAIL_ENCRYPTION: "secure",
  MAIL_SERVER: "host",
  MAIL_URL: "url",
  MAIL_MAILER: "mailer",
  MAIL_DRIVER: "mailer",
  MAIL_SCHEME: "mailer",
  MAILER_DSN: "url",
  MAILER_URL: "url",
  EMAIL_HOST: "host",
  EMAIL_PORT: "port",
  EMAIL_HOST_USER: "user",
  EMAIL_HOST_PASSWORD: "pass",
  EMAIL_USE_TLS: "secure",
  EMAIL_USE_SSL: "secure",
  EMAIL_URL: "url",
  EMAIL_SERVER: "url",
  EMAIL_SERVER_HOST: "host",
  EMAIL_SERVER_PORT: "port",
  EMAIL_SERVER_USER: "user",
  EMAIL_SERVER_PASSWORD: "pass",
  EMAIL_SMTP_HOST: "host",
  EMAIL_SMTP_PORT: "port",
  SPRING_MAIL_HOST: "host",
  SPRING_MAIL_PORT: "port",
  SPRING_MAIL_USERNAME: "user",
  SPRING_MAIL_PASSWORD: "pass",
  GOTRUE_SMTP_HOST: "host",
  GOTRUE_SMTP_PORT: "port",
  GOTRUE_SMTP_USER: "user",
  GOTRUE_SMTP_PASS: "pass",
};

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
    case "mailer":
      return "smtp";
    case "url":
      return `smtp://${MAILTEST_SMTP_USER}:${encodeURIComponent(target.password)}@${target.host}:${MAILTEST_SMTP_PORT}`;
  }
}

function valueOf(name: string, role: MailTestRole, target: { host: string; password: string }): string {
  // Laravel lê "null" como "sem criptografia"; "false" não é um valor dele
  return name === "MAIL_ENCRYPTION" ? "null" : mailTestValue(role, target);
}

/**
 * TODAS as variáveis de SMTP que o app recebe enquanto a caixa de teste está ligada, apontando para o Mailpit
 * (nome → valor). O painel as injeta sempre, tenha o projeto definido ou não: um app que lê MAIL_HOST de um
 * .env versionado ou de um ENV do Dockerfile também é redirecionado.
 */
export function mailTestEnv(target: { host: string; password: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, role] of Object.entries(MAILTEST_VARIABLE_ROLES)) out[name] = valueOf(name, role, target);
  return out;
}

/**
 * Das variáveis que o projeto define (nomes), as que o painel redireciona: as de nome conhecido
 * (MAILTEST_VARIABLE_ROLES). Devolve nome → novo valor.
 */
export function mailTestUserOverrides(names: Iterable<string>, target: { host: string; password: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const role = MAILTEST_VARIABLE_ROLES[name];
    if (role !== undefined) out[name] = valueOf(name, role, target);
  }
  return out;
}

/** Versão do ambiente de e-mail quando a caixa está desligada (o e-mail normal). */
export const MAILTEST_VERSION_OFF = "off";

/** Nomes de variável de e-mail que o painel NÃO controla (achados no código do projeto), para a tela avisar. */
export interface MailTestUncontrolled {
  name: string;
  /** Onde o nome apareceu: arquivo do projeto ou "Variáveis do painel". */
  file: string;
  /** smtp: pode apontar para um servidor SMTP real; api: provedor por API HTTP (nunca capturado). */
  kind: "smtp" | "api";
}
