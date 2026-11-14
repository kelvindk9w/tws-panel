/**
 * Falha da troca segura do webmail (imagem, limite do log ou ajuste do PHP): o servidor manda um código estável e a
 * mensagem com o motivo real (pt-BR). Em pt-BR a tela mostra a mensagem do servidor; nos outros idiomas, o texto do
 * código — por isso os dois códigos precisam existir nos dois dicionários.
 */
import { describe, expect, it } from "vitest";
import en from "../src/locales/en/errors";
import ptBR from "../src/locales/pt-BR/errors";

// os mesmos de WEBMAIL_RECREATE_FAILED e WEBMAIL_RECREATE_UNRESTORED (packages/mailer/src/webmail.ts; o web não depende do mailer)
const WEBMAIL_RECREATE_FAILED = "webmail_recreate_failed";
const WEBMAIL_RECREATE_UNRESTORED = "webmail_recreate_unrestored";
const CODES = [WEBMAIL_RECREATE_FAILED, WEBMAIL_RECREATE_UNRESTORED];

describe("códigos de erro da troca segura do webmail", () => {
  it.each(CODES)("%s tem texto em pt-BR e em en", (code) => {
    expect((ptBR as Record<string, string>)[`code.${code}`]).toBeTruthy();
    expect((en as Record<string, string>)[`code.${code}`]).toBeTruthy();
  });

  it("o texto de 'não voltou' manda ativar de novo; o de 'ficou como estava' não", () => {
    expect((en as Record<string, string>)[`code.${WEBMAIL_RECREATE_UNRESTORED}`]).toMatch(/turn webmail on again/i);
    expect((ptBR as Record<string, string>)[`code.${WEBMAIL_RECREATE_UNRESTORED}`]).toMatch(/ative o webmail de novo/i);
    expect((en as Record<string, string>)[`code.${WEBMAIL_RECREATE_FAILED}`]).not.toMatch(/turn webmail on again/i);
  });
});
