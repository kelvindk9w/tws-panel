import { describe, expect, it } from "vitest";
import { MAIL_REFUSAL_KINDS, type MailHintCode } from "@paas/core";
import { setLocale } from "../src/i18n/core";
import { hintText, isRefusalKind, probeErrorText, probeFailureText, probeStepStates, refusalText } from "../src/lib/mail-diagnosis";

describe("lib/mail-diagnosis", () => {
  it("traduz todos os tipos de recusa em pt-BR e en, com sugestão", () => {
    for (const locale of ["pt-BR", "en"]) {
      setLocale(locale, { persist: false });
      const titles = new Set<string>();
      for (const kind of MAIL_REFUSAL_KINDS) {
        const text = refusalText(kind)!;
        expect(text.title.length).toBeGreaterThan(3);
        expect(text.hint.length).toBeGreaterThan(3);
        titles.add(text.title);
      }
      expect(titles.size).toBe(MAIL_REFUSAL_KINDS.length);
    }
    expect(refusalText("auth_failed")!.title).toBe("Wrong username or password");
  });

  it("tipo desconhecido não quebra", () => {
    expect(isRefusalKind("nope")).toBe(false);
    expect(isRefusalKind(3)).toBe(false);
    expect(refusalText("nope")).toBeNull();
  });

  it("textos dos itens de 'por que nada chegou' usam os parâmetros", () => {
    expect(hintText({ code: "mailer_not_smtp", severity: "problem", params: { mailer: "log" } })!.body).toContain("log");
    expect(hintText({ code: "mailer_not_smtp", severity: "problem" })!.body).toContain("MAIL_MAILER=smtp");
    expect(hintText({ code: "smtp_not_linked", severity: "problem", params: { names: "MAIL_HOST, MAIL_PORT" } })!.body).toContain("MAIL_HOST, MAIL_PORT");
    expect(hintText({ code: "smtp_not_linked", severity: "problem" })!.body).toContain("Ligar variáveis");
    expect(hintText({ code: "recent_refusals", severity: "info", params: { count: "3", kind: "auth_failed" } })!.body).toMatch(/3 tentativas.*Usuário ou senha errados/);
    expect(hintText({ code: "recent_refusals", severity: "info", params: { count: "3", kind: "novo_tipo" } })!.body).toContain("novo_tipo");
    expect(hintText({ code: "recent_refusals", severity: "info" })!.body).toContain("Tentativas recusadas");
    expect(hintText({ code: "nope" as MailHintCode, severity: "info" })).toBeNull();
  });

  it("etapas do teste: concluída, falha e não alcançada", () => {
    expect(probeStepStates({ passed: ["connect", "ehlo"], failedStep: "starttls" }).map((s) => s.state)).toEqual(["passed", "passed", "failed", "notReached", "notReached"]);
    expect(probeStepStates({ passed: ["connect", "ehlo", "starttls", "certificate", "auth"], failedStep: null }).every((s) => s.state === "passed")).toBe(true);
  });

  it("motivo da falha desconhecido vira 'inesperado'; erros da API do teste", () => {
    setLocale("pt-BR", { persist: false });
    expect(probeFailureText("dns")).toContain("SMTP_HOST");
    expect(probeFailureText("coisa")).toContain("inesperada");
    expect(probeFailureText(null)).toContain("inesperada");
    expect(probeErrorText("email_not_enabled", 409)).toContain("não está ativado");
    expect(probeErrorText("probe_running", 409)).toContain("em andamento");
    expect(probeErrorText("", 429)).toContain("Muitos testes");
    expect(probeErrorText("x", 500)).toContain("Não foi possível");
  });
});
