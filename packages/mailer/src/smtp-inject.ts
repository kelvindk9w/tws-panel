/**
 * smtp-inject.ts — env vars SMTP injetadas nos projetos com e-mail habilitado
 * (plano §5.3: SMTP_HOST/PORT/USER/PASS/MAIL_FROM — trader/cachetaGrok quebram
 * sem isso).
 *
 * O host injetado é mail.<domínio> (porta 587, STARTTLS) — o NOME DO
 * CERTIFICADO que o Caddy central emite e o painel instala no Stalwart (ver
 * tls-certificates.ts). O container do Stalwart tem esse nome como alias na
 * paas-net, então o projeto conecta por dentro da rede Docker, sem sair pela
 * internet, e a verificação padrão do certificado passa.
 *
 * Antes era o alias `paas-stalwart`. Validação real (01/10/2026): app que
 * confere o certificado (nodemailer com requireTLS e verificação padrão, caso
 * do cassino) recusava — nenhum certificado público tem esse nome. Projetos
 * com e-mail ativo recebem o valor novo no próximo deploy.
 */
import type { Project } from "@paas/core";

/** Alias de rede histórico do container Stalwart na paas-net (continua existindo). */
export const STALWART_NETWORK_ALIAS = "paas-stalwart";

/** Porta de submission usada na comunicação interna (rede Docker). */
export const STALWART_INTERNAL_SMTP_PORT = 587;

export interface SmtpEnvInput {
  /** Hostname do servidor de e-mail do domínio da caixa (mail.<domínio>). */
  host: string;
  mailbox: string;
  password: string;
  /** Endereço From (a caixa técnica ou um endereço de envio escolhido, alias dela). */
  mailFrom: string;
  /** Nome de exibição do remetente (vira MAIL_FROM_NAME). */
  mailFromName?: string;
}

/** Monta o mapa de env vars para injeção no deploy do projeto. */
export function buildSmtpEnv(input: SmtpEnvInput): Record<string, string> {
  return {
    SMTP_HOST: input.host,
    SMTP_PORT: String(STALWART_INTERNAL_SMTP_PORT),
    SMTP_USER: input.mailbox,
    SMTP_PASS: input.password,
    MAIL_FROM: input.mailFrom,
    // MAIL_FROM continua sendo o endereço puro (qualquer app aceita); o nome
    // vai separado para o app montar "Nome <endereço>" se quiser.
    ...(input.mailFromName ? { MAIL_FROM_NAME: input.mailFromName } : {}),
  };
}

/** Endereço da caixa técnica de um projeto (slug sanitizado → local-part). */
export function projectMailboxAddress(project: Pick<Project, "slug">, domain: string): string {
  return `${project.slug}@${domain}`;
}

/** Mascara valores sensíveis para exibição na UI (mantém host/porta/From). */
export function maskEnv(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    masked[key] = key === "SMTP_PASS" ? "••••••••••••" : value;
  }
  return masked;
}
