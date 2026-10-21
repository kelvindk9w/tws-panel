/**
 * mail-auth-error.test.ts — o 401/403 do Stalwart ("You have to authenticate
 * first") vira, em TODA tela que fala com o servidor de e-mail, a mesma
 * mensagem amigável (409 mail_auth_failed): E-mail (caixas, domínios, DKIM,
 * projetos), Envios (fila, tentar de novo, cancelar) e Webmail.
 */
import { StalwartApiError } from "@paas/mailer";
import { describe, expect, it } from "vitest";
import { MAIL_AUTH_FAILED_MESSAGE, mailAuthError, mailAuthRepairFailedError, mailAuthRepairIncompleteError } from "../src/services/mail-auth-error.js";

describe("mailAuthError", () => {
  it("401 e 403 do Stalwart viram 409 mail_auth_failed com a mensagem única", () => {
    for (const status of [401, 403]) {
      const e = mailAuthError(new StalwartApiError(status, "Stalwart: You have to authenticate first."));
      expect(e).toMatchObject({ statusCode: 409, code: "mail_auth_failed", message: MAIL_AUTH_FAILED_MESSAGE });
    }
    expect(MAIL_AUTH_FAILED_MESSAGE).toMatch(/não conseguiu autenticar no servidor de e-mail/);
    expect(MAIL_AUTH_FAILED_MESSAGE).not.toMatch(/You have to authenticate/);
  });

  it("qualquer outro erro não é tocado", () => {
    expect(mailAuthError(new StalwartApiError(500, "x"))).toBeNull();
    expect(mailAuthError(new StalwartApiError(0, "sem conexão"))).toBeNull();
    expect(mailAuthError(new Error("401"))).toBeNull();
    expect(mailAuthError("401")).toBeNull();
  });
});

describe("mailAuthRepairFailedError", () => {
  it("reparo que reiniciou e não resolveu: diz o que tentou e o próximo passo, sem pedir para reaplicar", () => {
    const e = mailAuthRepairFailedError("failed");
    expect(e).toMatchObject({ statusCode: 409, code: "mail_auth_repair_failed" });
    expect(e.message).toMatch(/tentou regravar a configuração e reiniciar/);
    expect(e.message).toMatch(/Próximo passo/);
    expect(e.message).not.toMatch(/Reaplique/);
  });
  it("senha confere mas a leitura foi recusada", () => {
    expect(mailAuthRepairFailedError("ok")).toMatchObject({ statusCode: 409, code: "mail_auth_still_refused" });
  });
  it("servidor sem resposta e servidor parado", () => {
    expect(mailAuthRepairFailedError("unreachable")).toMatchObject({ statusCode: 502, code: "mail_unreachable" });
    expect(mailAuthRepairFailedError("not_running")).toMatchObject({ statusCode: 409, code: "mail_server_stopped" });
  });
});

describe("mailAuthRepairIncompleteError", () => {
  it("tira o segredo, corta o motivo e mantém o próximo passo", () => {
    const e = mailAuthRepairIncompleteError(new Error("x ".repeat(200) + "SEGREDO"), "SEGREDO");
    expect(e).toMatchObject({ statusCode: 409, code: "mail_auth_repair_incomplete" });
    expect(e.message).not.toContain("SEGREDO");
    expect(e.message.length).toBeLessThan(900);
    expect(e.message).toMatch(/Próximo passo/);
  });
  it("erro que não é Error, ou sem segredo guardado", () => {
    expect(mailAuthRepairIncompleteError("texto", null).message).toMatch(/\(texto\)/);
    expect(mailAuthRepairIncompleteError(undefined, "").message).toMatch(/não terminou/);
  });
});
