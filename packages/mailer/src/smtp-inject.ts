/**
 * smtp-inject.ts — env vars SMTP injetadas nos projetos com e-mail habilitado
 * (plano §5.3: SMTP_HOST/PORT/USER/PASS/MAIL_FROM — trader/cachetaGrok quebram
 * sem isso).
 *
 * O host injetado é o alias do container Stalwart na rede paas-net
 * (paas-stalwart:587, STARTTLS), pois os projetos rodam na mesma rede Docker.
 * Em dev o certificado é autoassinado — aplicações devem desativar a verificação
 * estrita do cert (ex.: nodemailer `tls: { rejectUnauthorized: false }`); em
 * produção, com certificado ACME, a verificação funciona normalmente.
 */
import type { Project } from "@paas/core";

/** Alias de rede do container Stalwart dentro da paas-net. */
export const STALWART_NETWORK_ALIAS = "paas-stalwart";

/** Porta de submission usada na comunicação interna (rede Docker). */
export const STALWART_INTERNAL_SMTP_PORT = 587;

export interface SmtpEnvInput {
  mailbox: string;
  password: string;
  /** Endereço From padrão (geralmente igual à caixa técnica). */
  mailFrom: string;
}

/** Monta o mapa de env vars para injeção no deploy do projeto. */
export function buildSmtpEnv(input: SmtpEnvInput): Record<string, string> {
  return {
    SMTP_HOST: STALWART_NETWORK_ALIAS,
    SMTP_PORT: String(STALWART_INTERNAL_SMTP_PORT),
    SMTP_USER: input.mailbox,
    SMTP_PASS: input.password,
    MAIL_FROM: input.mailFrom,
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
