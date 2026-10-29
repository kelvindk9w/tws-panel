/**
 * mail-test.ts — nomes e variáveis da caixa de teste de e-mail (Mailpit).
 */
import { describe, expect, it } from "vitest";
import {
  MAILTEST_SMTP_PORT,
  MAILTEST_SMTP_USER,
  MAILTEST_VARIABLE_ROLES,
  MAILTEST_DISK_BUDGET_BYTES,
  MAILTEST_MAX_MESSAGES_RANGE,
  MAILTEST_MESSAGE_MB_CEILING,
  MAILTEST_MESSAGE_MB_FLOOR,
  PAAS_MAILTEST_ADMIN_NETWORK,
  mailTestAdminNetworkName,
  mailTestMaxMessageBytes,
  mailTestMaxMessageMb,
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
  it("o conjunto completo vai para o Mailpit, sem TLS e com a senha gerada", () => {
    const env = mailTestEnv(target);
    expect(env).toMatchObject({
      SMTP_HOST: "paas-mailtest-loja",
      SMTP_PORT: String(MAILTEST_SMTP_PORT),
      SMTP_USER: MAILTEST_SMTP_USER,
      SMTP_PASS: "senha-gerada",
      SMTP_ADDRESS: "paas-mailtest-loja",
      MAIL_HOST: "paas-mailtest-loja",
      MAIL_MAILER: "smtp",
      MAIL_DRIVER: "smtp",
      MAIL_SCHEME: "smtp",
      MAIL_ENCRYPTION: "null",
      SPRING_MAIL_HOST: "paas-mailtest-loja",
      GOTRUE_SMTP_HOST: "paas-mailtest-loja",
    });
    // a senha real nunca aparece e nenhum valor aponta para fora
    for (const value of Object.values(env)) expect(value).not.toMatch(/smtp\.|mailgun|gmail/i);
  });

  it("as formas de URL única levam usuário, senha (codificada) e a porta do Mailpit", () => {
    const env = mailTestEnv({ host: "paas-mailtest-loja", password: "a/b+c" });
    for (const name of ["SMTP_URL", "MAIL_URL", "MAILER_DSN", "MAILER_URL", "EMAIL_URL", "EMAIL_SERVER"]) {
      expect(env[name]).toBe("smtp://mailtest:a%2Fb%2Bc@paas-mailtest-loja:1025");
    }
  });

  it("cada papel tem o seu valor", () => {
    expect(mailTestValue("host", target)).toBe("paas-mailtest-loja");
    expect(mailTestValue("port", target)).toBe("1025");
    expect(mailTestValue("user", target)).toBe("mailtest");
    expect(mailTestValue("pass", target)).toBe("senha-gerada");
    expect(mailTestValue("secure", target)).toBe("false");
    expect(mailTestValue("mailer", target)).toBe("smtp");
    expect(mailTestValue("url", target)).toBe("smtp://mailtest:senha-gerada@paas-mailtest-loja:1025");
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
    for (const role of Object.values(MAILTEST_VARIABLE_ROLES)) expect(["host", "port", "user", "pass", "secure", "url", "mailer"]).toContain(role);
  });
});

// REGRESSÃO (revisão): nomes comuns de variável de e-mail que continuavam apontando para o SMTP real
describe("nomes comuns de outros frameworks", () => {
  it.each([
    "SMTP_URL", "MAIL_URL", "MAILER_DSN", "MAILER_URL", "EMAIL_URL", "EMAIL_SERVER", "EMAIL_SERVER_HOST", "SMTP_ADDRESS",
    "SMTP_LOGIN", "SMTP_HOSTNAME", "SMTP_HOST_NAME", "SMTPHOST", "MAILHOST", "MAIL_HOSTNAME", "RELAY_HOST", "MAIL_MAILER", "MAIL_DRIVER", "MAIL_SCHEME", "SPRING_MAIL_HOST", "GOTRUE_SMTP_HOST", "SMTP_SERVER_HOST", "EMAIL_SMTP_HOST",
  ])("%s é redirecionada", (name) => {
    expect(Object.keys(mailTestUserOverrides([name], target))).toContain(name);
    expect(Object.keys(mailTestEnv(target))).toContain(name);
  });
});

describe("M4: limite de tamanho por mensagem e rede de leitura por projeto", () => {
  it("A1: o teto é em MEGABYTES INTEIROS (unidade do MP_MAX_MESSAGE_SIZE do Mailpit), de 1 a 10, e o total fica dentro de ~2 GiB", () => {
    expect(mailTestMaxMessageMb(10)).toBe(10);
    expect(mailTestMaxMessageMb(204)).toBe(10);
    expect(mailTestMaxMessageMb(500)).toBe(4);
    expect(mailTestMaxMessageMb(1000)).toBe(2);
    expect(mailTestMaxMessageMb(2000)).toBe(1);
    expect(mailTestMaxMessageMb(0)).toBe(10);
    for (const n of [10, 100, 500, 1000, MAILTEST_MAX_MESSAGES_RANGE.max]) {
      const mb = mailTestMaxMessageMb(n);
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThanOrEqual(MAILTEST_MESSAGE_MB_FLOOR);
      expect(mb).toBeLessThanOrEqual(MAILTEST_MESSAGE_MB_CEILING);
      expect(mailTestMaxMessageBytes(n)).toBe(mb * 1024 * 1024);
      // o máximo aceito de mensagens vezes o teto nunca passa do orçamento (~2 GiB)
      expect(mailTestMaxMessageBytes(n) * n).toBeLessThanOrEqual(MAILTEST_DISK_BUDGET_BYTES);
    }
    expect(MAILTEST_DISK_BUDGET_BYTES).toBe(2 * 1024 ** 3);
  });

  it("a rede de leitura é uma por projeto e nunca coincide com a rede de um projeto", () => {
    expect(mailTestAdminNetworkName("loja")).toBe(`${PAAS_MAILTEST_ADMIN_NETWORK}-loja`);
    expect(mailTestAdminNetworkName("loja")).not.toBe(mailTestNetworkName("adm-loja"));
    expect(mailTestAdminNetworkName("adm-x").startsWith("paas-mailtestadm")).toBe(true);
  });
});

describe("slug nos nomes de container, rede e volume", () => {
  it("só aceita [a-z0-9-]: nada de espaço, aspas, $, ;, / ou .. chega a um nome", () => {
    for (const bad of ["", "Loja", "a b", "a;rm -rf /", "$(id)", "a`b`", "a/b", "../x", "a'b", 'a"b', "a\nb", "x".repeat(64)]) {
      for (const fn of [mailTestContainerName, mailTestNetworkName, mailTestVolumeName, mailTestAdminNetworkName]) {
        expect(() => fn(bad)).toThrow(/slug inválido/);
      }
    }
    expect(mailTestContainerName("loja-2")).toBe("paas-mailtest-loja-2");
    expect(mailTestVolumeName("a")).toBe("paas-mailtest-a-data");
  });
});
