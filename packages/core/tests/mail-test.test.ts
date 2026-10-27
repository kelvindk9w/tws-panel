/**
 * mail-test.ts — nomes e variáveis da caixa de teste de e-mail (Mailpit).
 */
import { describe, expect, it } from "vitest";
import {
  MAILTEST_SMTP_PORT,
  MAILTEST_SMTP_USER,
  MAILTEST_VARIABLE_ROLES,
  PAAS_MAILTEST_ADMIN_NETWORK,
  mailTestContainerName,
  mailTestEnv,
  mailTestNetworkName,
  mailTestUserOverrides,
  mailTestValue,
  mailTestVolumeName,
} from "../src/index.js";

const target = { host: "paas-mailtest-loja", password: "senha-gerada" };

describe("nomes da caixa de teste", () => {
  it("ficam no espaço paas-* do painel e a rede de leitura não colide com nenhum slug", () => {
    expect(mailTestContainerName("loja")).toBe("paas-mailtest-loja");
    expect(mailTestNetworkName("loja")).toBe("paas-mailtest-loja");
    expect(mailTestVolumeName("loja")).toBe("paas-mailtest-loja-data");
    // nenhum slug produz "paas-mailtestadm": o prefixo de projeto tem hífen depois de "mailtest"
    expect(PAAS_MAILTEST_ADMIN_NETWORK.startsWith("paas-mailtest-")).toBe(false);
  });
});

describe("variáveis que o app recebe", () => {
  it("as quatro SMTP_* apontam para o Mailpit, sem TLS e com a senha gerada", () => {
    expect(mailTestEnv(target)).toEqual({
      SMTP_HOST: "paas-mailtest-loja",
      SMTP_PORT: String(MAILTEST_SMTP_PORT),
      SMTP_USER: MAILTEST_SMTP_USER,
      SMTP_PASS: "senha-gerada",
    });
  });

  it("cada papel tem o seu valor", () => {
    expect(mailTestValue("host", target)).toBe("paas-mailtest-loja");
    expect(mailTestValue("port", target)).toBe("1025");
    expect(mailTestValue("user", target)).toBe("mailtest");
    expect(mailTestValue("pass", target)).toBe("senha-gerada");
    expect(mailTestValue("secure", target)).toBe("false");
  });

  it("redireciona só os nomes conhecidos que o projeto definiu", () => {
    const out = mailTestUserOverrides(["MAIL_HOST", "MAIL_PORT", "MAIL_ENCRYPTION", "EMAIL_USE_TLS", "DATABASE_URL", "SMTP_HOST"], target);
    expect(out).toEqual({
      MAIL_HOST: "paas-mailtest-loja",
      MAIL_PORT: "1025",
      // Laravel entende "null" como sem criptografia
      MAIL_ENCRYPTION: "null",
      EMAIL_USE_TLS: "false",
      SMTP_HOST: "paas-mailtest-loja",
    });
    expect(out.DATABASE_URL).toBeUndefined();
  });

  it("nada definido, nada redirecionado", () => {
    expect(mailTestUserOverrides([], target)).toEqual({});
  });

  it("a tabela de nomes só usa papéis que existem", () => {
    for (const role of Object.values(MAILTEST_VARIABLE_ROLES)) expect(["host", "port", "user", "pass", "secure"]).toContain(role);
  });
});
