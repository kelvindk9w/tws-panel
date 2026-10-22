import { describe, expect, it } from "vitest";
import type { ComposeVariable, ProjectEmailConfig, ProjectEmailValueKey } from "@paas/core";
import { classifyEmailVariable, emailAdvice } from "@/lib/email-env-advice";

const req = (name: string): ComposeVariable => ({ name, required: true, defaultValue: null });
const ON = {
  enabled: true,
  domain: "example.com",
  mailbox: "a@example.com",
  mailFrom: "a@example.com",
  env: { SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "x", MAIL_FROM: "a@example.com" },
} as ProjectEmailConfig;

describe("classifyEmailVariable", () => {
  it("separa nome padrão, apelido e manual", () => {
    expect(classifyEmailVariable("SMTP_HOST")).toEqual({ kind: "direct", source: "SMTP_HOST" });
    expect(classifyEmailVariable("MAIL_PASSWORD")).toEqual({ kind: "alias", source: "SMTP_PASS" });
    expect(classifyEmailVariable("SMTP_SECURE")).toEqual({ kind: "manual", value: "false" });
    expect(classifyEmailVariable("SMTP_REQUIRE_TLS")).toEqual({ kind: "manual" });
    expect(classifyEmailVariable("DATABASE_URL")).toBeNull();
  });
});

describe("emailAdvice", () => {
  it("não sugere quando as ligações não cabem no limite", () => {
    const links: Record<string, ProjectEmailValueKey> = {};
    for (let i = 0; i < 30; i++) links[`X_${i}`] = "SMTP_USER";
    const a = emailAdvice([req("SMTP_PASSWORD")], new Set(), new Set(), ON, links);
    expect(a.overLimit).toBe(true);
    expect(a.suggestions).toEqual([]);
  });

  it("alternativa preenchida dispensa a obrigatória; opcional é ignorada", () => {
    const cv = { ...req("SMTP_FROM"), alternatives: ["EMAIL_DE"] };
    expect(emailAdvice([cv], new Set(["EMAIL_DE"]), new Set(), ON, {}).items).toEqual([]);
    expect(emailAdvice([{ ...req("SMTP_FROM"), required: false }], new Set(), new Set(), ON, {}).show).toBe(false);
  });

  it("valor do e-mail que não existe (MAIL_FROM_NAME) não vira sugestão", () => {
    const a = emailAdvice([req("SMTP_FROM_NAME")], new Set(), new Set(), ON, {});
    expect(a.items[0]!.state).toBe("unavailable");
    expect(a.suggestions).toEqual([]);
  });

  it("tudo fornecido ou preenchido: não mostra", () => {
    const a = emailAdvice(
      [req("SMTP_HOST"), req("SMTP_PASSWORD"), req("SMTP_SECURE")],
      new Set(["SMTP_SECURE"]),
      new Set(["SMTP_HOST", "SMTP_PASSWORD"]),
      ON,
      { SMTP_PASSWORD: "SMTP_PASS" },
    );
    expect(a.show).toBe(false);
  });
});
