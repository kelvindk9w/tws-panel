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
      password: "senha-forte-123",
      host: "mail.exemplo.com.br",
      ports: MAIL_DEFAULT_PORTS,
    });
    expect(creds).toMatchObject({
      email: "suporte@exemplo.com.br",
      username: "suporte@exemplo.com.br",
      password: "senha-forte-123",
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
  it("env vars apontam para o alias interno do Stalwart na paas-net", () => {
    const env = buildSmtpEnv({
      mailbox: "loja@exemplo.com.br",
      password: "segredo",
      mailFrom: "loja@exemplo.com.br",
    });
    expect(env).toEqual({
      SMTP_HOST: STALWART_NETWORK_ALIAS,
      SMTP_PORT: String(STALWART_INTERNAL_SMTP_PORT),
      SMTP_USER: "loja@exemplo.com.br",
      SMTP_PASS: "segredo",
      MAIL_FROM: "loja@exemplo.com.br",
    });
  });

  it("maskEnv esconde apenas a senha", () => {
    const env = buildSmtpEnv({ mailbox: "a@b.com", password: "segredo", mailFrom: "a@b.com" });
    const masked = maskEnv(env);
    expect(masked.SMTP_PASS).not.toContain("segredo");
    expect(masked.SMTP_USER).toBe("a@b.com");
    expect(masked.SMTP_HOST).toBe(STALWART_NETWORK_ALIAS);
  });

  it("endereço da caixa técnica usa o slug do projeto", () => {
    expect(projectMailboxAddress({ slug: "minha-loja" }, "exemplo.com.br")).toBe("minha-loja@exemplo.com.br");
  });
});
