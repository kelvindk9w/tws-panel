/**
 * Recusas antes da fila (refusal-log.ts), lidas do registro do Stalwart. Linhas no formato real do registro
 * (hora, nível, descrição, evento entre parênteses, campos). Os CAMPOS exatos de cada evento não foram conferidos
 * num Stalwart real: o parser aceita vários nomes de campo para o login e só vale se parecer e-mail.
 */
import { describe, expect, it } from "vitest";
import { REFUSAL_EVENTS, isRefusalLogLine, parseRefusalLine } from "../src/refusal-log.js";

const AT = "2026-10-30T12:00:00Z";
const line = (event: string, fields: string, description = "Evento") => `${AT} INFO ${description} (${event}) ${fields}`;

describe("isRefusalLogLine", () => {
  it("reconhece só os eventos de recusa conhecidos", () => {
    expect(isRefusalLogLine(line("auth.failed", 'listenerId = "submission"'))).toBe(true);
    expect(isRefusalLogLine(line("tls.handshake-error", 'listenerId = "submission"'))).toBe(true);
    expect(isRefusalLogLine(line("delivery.dsn-success", "queueId = 1"))).toBe(false);
    expect(isRefusalLogLine("texto qualquer")).toBe(false);
    expect(isRefusalLogLine(line("constructor.prototype", ""))).toBe(false);
  });
});

describe("parseRefusalLine", () => {
  it("senha errada: tipo, hora e login (campo id)", () => {
    const r = parseRefusalLine(line("auth.failed", 'listenerId = "submission", localPort = 587, remoteIp = 203.0.113.7, id = "Meu-App@Example.com"', "Authentication failed"));
    expect(r).toEqual({ at: "2026-10-30T12:00:00.000Z", kind: "auth_failed", login: "meu-app@example.com" });
  });

  it("não devolve o IP nem texto livre", () => {
    const r = parseRefusalLine(line("auth.failed", 'remoteIp = 203.0.113.7, id = "a@example.com"'));
    expect(JSON.stringify(r)).not.toContain("203.0.113.7");
  });

  it("login em outros campos (accountName, details)", () => {
    expect(parseRefusalLine(line("auth.failed", 'accountName = "x@example.com"'))!.login).toBe("x@example.com");
    expect(parseRefusalLine(line("smtp.mail-from-unauthorized", 'details = "x@example.com"'))!.login).toBe("x@example.com");
  });

  it("login que não parece e-mail fica null (nome de usuário solto, lixo, injeção)", () => {
    for (const bad of ["admin", "a b@example.com", "<x>@example.com", "a@@b", ""]) {
      expect(parseRefusalLine(line("auth.failed", `id = "${bad}"`))!.login).toBeNull();
    }
    expect(parseRefusalLine(line("auth.failed", 'listenerId = "submission"'))!.login).toBeNull();
  });

  it("evento aninhado em campo: usa o texto legível", () => {
    const r = parseRefusalLine(line("auth.failed", 'id = SMTP error (smtp.error) { details = "a@example.com" }'));
    expect(r!.login).toBe("a@example.com");
  });

  it.each(Object.entries(REFUSAL_EVENTS))("%s -> %s", (event, kind) => {
    expect(parseRefusalLine(line(event, 'id = "a@example.com"'))!.kind).toBe(kind);
  });

  it("linha que não é do formato ou não é recusa", () => {
    expect(parseRefusalLine("lixo (auth.failed)")).toBeNull();
    expect(parseRefusalLine(line("delivery.dsn-success", "queueId = 1"))).toBeNull();
  });
});
