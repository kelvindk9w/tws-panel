/**
 * Testes de geração de credenciais (mailboxes.ts) e injeção SMTP
 * (smtp-inject.ts) — senhas fortes URL/YAML-safe e bloco completo de
 * credenciais para clientes de e-mail externos.
 */
import { describe, expect, it } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import { buildCredentials, generatePassword } from "../src/mailboxes.js";
import {
  buildSmtpEnv,
  maskEnv,
  projectMailboxAddress,
  STALWART_INTERNAL_SMTP_PORT,
  STALWART_NETWORK_ALIAS,
} from "../src/smtp-inject.js";

describe("generatePassword", () => {
  it("gera senha com entropia suficiente (18 bytes → 24 chars base64url)", () => {
    const password = generatePassword();
    expect(password).toHaveLength(24);
  });

  it("usa apenas charset base64url (segura para YAML, env e URLs)", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("não repete senhas", () => {
    const passwords = new Set(Array.from({ length: 100 }, () => generatePassword()));
    expect(passwords.size).toBe(100);
  });

  it("respeita o parâmetro de bytes", () => {
    expect(generatePassword(9)).toHaveLength(12);
  });
});

describe("buildCredentials", () => {
  it("monta o bloco completo: IMAP SSL primário, SMTP STARTTLS primário", () => {
    const creds = buildCredentials({
      email: "suporte@exemplo.com.br",
      host: "mail.exemplo.com.br",
      ports: MAIL_DEFAULT_PORTS,
    });
    // Pedido do dono do produto (02/10/2026): a senha nunca aparece na tela;
    // quem esqueceu troca. O bloco de configuração não carrega senha.
    expect(creds).not.toHaveProperty("password");
    expect(creds).toMatchObject({
      email: "suporte@exemplo.com.br",
      username: "suporte@exemplo.com.br",
      imap: { host: "mail.exemplo.com.br", port: 993, security: "ssl" },
      imapAlt: { host: "mail.exemplo.com.br", port: 143, security: "starttls" },
      smtp: { host: "mail.exemplo.com.br", port: 587, security: "starttls" },
      smtpAlt: { host: "mail.exemplo.com.br", port: 465, security: "ssl" },
    });
    expect(creds.notes.length).toBeGreaterThan(0);
    expect(creds.notes.join(" ")).toContain("endereço de e-mail completo");
  });
});

describe("smtp-inject", () => {
  // Validação real (01/10/2026): com SMTP_HOST=paas-stalwart, app que confere
  // o certificado (nodemailer com requireTLS) recusa — nenhum certificado
  // público tem esse nome. O host injetado é o nome do certificado,
  // mail.<domínio>, que o Stalwart também tem como alias na paas-net.
  it("SMTP_HOST é o nome do certificado (mail.<domínio>), não o alias interno", () => {
    const env = buildSmtpEnv({
      host: "mail.exemplo.com.br",
      mailbox: "loja@exemplo.com.br",
      password: "segredo",
      mailFrom: "loja@exemplo.com.br",
    });
    expect(env.SMTP_HOST).not.toBe(STALWART_NETWORK_ALIAS);
    expect(env).toEqual({
      SMTP_HOST: "mail.exemplo.com.br",
      SMTP_PORT: String(STALWART_INTERNAL_SMTP_PORT),
      SMTP_USER: "loja@exemplo.com.br",
      SMTP_PASS: "segredo",
      MAIL_FROM: "loja@exemplo.com.br",
    });
  });

  it("com nome de exibição: MAIL_FROM_NAME junto do MAIL_FROM (endereço puro, aceito por qualquer app)", () => {
    const env = buildSmtpEnv({
      host: "mail.exemplo.com.br",
      mailbox: "loja@exemplo.com.br",
      password: "segredo",
      mailFrom: "nao-responda@exemplo.com.br",
      mailFromName: "Loja Exemplo",
    });
    expect(env.MAIL_FROM).toBe("nao-responda@exemplo.com.br");
    expect(env.MAIL_FROM_NAME).toBe("Loja Exemplo");
    expect(env.SMTP_USER).toBe("loja@exemplo.com.br");
  });

  it("maskEnv esconde apenas a senha", () => {
    const env = buildSmtpEnv({ host: "mail.b.com", mailbox: "a@b.com", password: "segredo", mailFrom: "a@b.com" });
    const masked = maskEnv(env);
    expect(masked.SMTP_PASS).not.toContain("segredo");
    expect(masked.SMTP_USER).toBe("a@b.com");
    expect(masked.SMTP_HOST).toBe("mail.b.com");
  });

  it("endereço da caixa técnica usa o slug do projeto", () => {
    expect(projectMailboxAddress({ slug: "minha-loja" }, "exemplo.com.br")).toBe("minha-loja@exemplo.com.br");
  });
});
