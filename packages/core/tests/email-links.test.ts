/**
 * Ligação dos valores do e-mail do projeto às variáveis do app (02/10/2026):
 * o app do projeto usa outros nomes (SMTP_SENHA, EMAIL_DE…). O painel guarda
 * só o mapeamento e entrega o valor atual no deploy — aqui, a regra de nome.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_EMAIL_VALUE_KEYS, envLinkNameProblem } from "../src/mail";

describe("valores do e-mail do projeto", () => {
  it("são os seis que o painel fornece, na ordem da tela", () => {
    expect(PROJECT_EMAIL_VALUE_KEYS).toEqual(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_FROM_NAME"]);
  });
});

describe("envLinkNameProblem", () => {
  it("aceita nome de variável comum", () => {
    expect(envLinkNameProblem("SMTP_SENHA")).toBeNull();
    expect(envLinkNameProblem("email_de")).toBeNull();
    expect(envLinkNameProblem("_X1")).toBeNull();
  });

  it("recusa nome fora do padrão das Variáveis (letras, números e _, sem começar com número)", () => {
    for (const bad of ["", "1ABC", "SMTP-SENHA", "A B", "x".repeat(129), "SENHA$"]) {
      expect(envLinkNameProblem(bad)).toMatch(/letras, números e _/);
    }
  });

  it("recusa os nomes que o próprio e-mail do projeto já entrega", () => {
    expect(envLinkNameProblem("SMTP_PASS")).toMatch(/já é um valor do e-mail do projeto/);
    expect(envLinkNameProblem("MAIL_FROM_NAME")).toMatch(/já é um valor do e-mail do projeto/);
  });

  it("recusa nomes que mudam o comportamento do compose, do Docker ou do sistema", () => {
    for (const reserved of ["COMPOSE_PROJECT_NAME", "compose_file", "DOCKER_HOST", "PATH", "HOME", "HOSTNAME"]) {
      expect(envLinkNameProblem(reserved)).toMatch(/reservado/);
    }
  });
});
