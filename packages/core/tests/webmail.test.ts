import { describe, expect, it } from "vitest";
import { PAAS_WEBMAIL_CONTAINER, WEBMAIL_INTERNAL_PORT, webmailUrl } from "../src/index";

describe("webmailUrl", () => {
  it("abre a raiz de mail.<domínio> por HTTPS", () => {
    expect(webmailUrl("mail.exemplo.com.br")).toBe("https://mail.exemplo.com.br/");
  });

  it("preenche só o usuário (nunca a senha) quando a caixa é informada", () => {
    expect(webmailUrl("mail.exemplo.com.br", "contato@exemplo.com.br")).toBe(
      "https://mail.exemplo.com.br/?_user=contato%40exemplo.com.br",
    );
  });

  it("escapa o que viesse a mais no endereço", () => {
    expect(webmailUrl("mail.exemplo.com", "a+b&_pass=x@exemplo.com")).toBe(
      "https://mail.exemplo.com/?_user=a%2Bb%26_pass%3Dx%40exemplo.com",
    );
  });

  it("container e porta interna do webmail", () => {
    expect(PAAS_WEBMAIL_CONTAINER).toBe("paas-webmail");
    expect(WEBMAIL_INTERNAL_PORT).toBe(8000);
  });
});
