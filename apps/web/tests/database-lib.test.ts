import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { dbErrorText, jobErrorText, tableId, tableLabel, toRef } from "@/lib/database";

describe("tabelas", () => {
  it("chave, rótulo e referência de pedido", () => {
    expect(tableId({ schema: "public", name: "users" })).not.toBe(tableId({ schema: null, name: "users" }));
    expect(tableLabel({ schema: "public", name: "users" })).toBe("users");
    expect(tableLabel({ schema: null, name: "users" })).toBe("users");
    expect(tableLabel({ schema: "audit", name: "log" })).toBe("audit.log");
    expect(toRef({ schema: "audit", name: "log", rows: null, sizeBytes: null })).toEqual({ schema: "audit", name: "log" });
    expect(toRef({ schema: null, name: "users", rows: null, sizeBytes: null })).toEqual({ name: "users" });
  });
});

describe("textos de erro", () => {
  it("código conhecido: frase traduzida, com o motivo à parte quando o servidor manda", () => {
    const err = new ApiRequestError(400, "query_failed", "texto do servidor", { detail: "syntax error" });
    expect(dbErrorText(err)).toBe("O banco recusou o comando. Motivo: syntax error");
    expect(dbErrorText(new ApiRequestError(409, "database_busy", "x"))).toBe("Já há uma ação no banco deste projeto em andamento. Espere terminar.");
    // detail que não é texto é ignorado
    expect(dbErrorText(new ApiRequestError(400, "query_failed", "x", { detail: 3 }))).toBe("O banco recusou o comando.");
    setLocale("en", { persist: false });
    expect(dbErrorText(err)).toBe("The database refused the command. Reason: syntax error");
  });

  it("código de outra área (senha, 2FA) segue o tratamento geral; erro qualquer cai no texto padrão", () => {
    expect(dbErrorText(new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta."))).toBe("A senha atual está incorreta.");
    expect(dbErrorText(new Error("rede"))).toBe("rede");
    expect(dbErrorText("x")).toBe("Não foi possível concluir agora. Tente de novo em instantes.");
    expect(dbErrorText("x", "database.loadError")).toBe("Não foi possível carregar a aba Banco. Tente de novo.");
  });

  it("erro de um trabalho: traduzido pelo código, ou a mensagem do servidor quando o código é desconhecido", () => {
    expect(jobErrorText({ code: "backup_failed", message: "x", detail: "sem espaço" })).toBe("O backup antes da ação não terminou bem. Nada foi alterado. Motivo: sem espaço");
    expect(jobErrorText({ code: "novo_codigo", message: "Mensagem do servidor", detail: null })).toBe("Mensagem do servidor");
  });
});
