/** Todo código de erro do reparo da senha de administração do e-mail tem texto em inglês (em pt-BR vale a mensagem do servidor). */
import { describe, expect, it } from "vitest";
import en from "../src/locales/en/errors";

const CODES = [
  "mail_auth_failed",
  "mail_auth_repair_failed",
  "mail_auth_repair_incomplete",
  "mail_auth_still_refused",
  "mail_unreachable",
  "mail_server_stopped",
];

describe("códigos de erro do reparo da senha de administração", () => {
  it.each(CODES)("%s tem texto em en", (code) => {
    expect((en as Record<string, string>)[`code.${code}`]).toBeTruthy();
  });
});
