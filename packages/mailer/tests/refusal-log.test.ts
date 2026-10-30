/**
 * Recusas antes da fila (refusal-log.ts), lidas do registro do Stalwart. Linhas no formato real do registro
 * (hora, nível, descrição, evento entre parênteses, campos). Os CAMPOS exatos de cada evento não foram conferidos
 * num Stalwart real: o parser aceita vários nomes de campo para o login e só vale se parecer e-mail.
 */
import { describe, expect, it } from "vitest";
import { REFUSAL_EVENTS, SUBMISSION_LISTENERS, isInternalAddress, isRefusalLogLine, parseRefusalLine } from "../src/refusal-log.js";

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
    expect(r).toEqual({ at: "2026-10-30T12:00:00.000Z", kind: "auth_failed", origin: "external", login: "meu-app@example.com" });
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

describe("origem e ouvido da recusa", () => {
  const f = (listener: string, ip: string) => `listenerId = "${listener}", remoteIp = ${ip}, id = "app@example.com"`;

  it("rede interna (Docker) = internal; internet = external; sem endereço = unknown", () => {
    expect(parseRefusalLine(line("auth.failed", f("submission", "172.18.0.9")))!.origin).toBe("internal");
    expect(parseRefusalLine(line("auth.failed", f("submission", "203.0.113.7")))!.origin).toBe("external");
    expect(parseRefusalLine(line("auth.failed", 'listenerId = "submission", id = "app@example.com"'))!.origin).toBe("unknown");
  });

  it("só ouvidos de envio contam; IMAP, webmail e administração são ignorados", () => {
    for (const l of SUBMISSION_LISTENERS) expect(parseRefusalLine(line("auth.failed", f(l, "172.18.0.9")))).not.toBeNull();
    for (const l of ["imap", "imaptls", "https", "http", "managesieve"]) expect(parseRefusalLine(line("auth.failed", f(l, "172.18.0.9")))).toBeNull();
  });

  it("sem ouvido no registro: não filtra", () => {
    expect(parseRefusalLine(line("auth.failed", 'remoteIp = 172.18.0.9, id = "app@example.com"'))).not.toBeNull();
  });
});

describe("isInternalAddress", () => {
  it.each(["10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "127.0.0.1", "169.254.1.1", "::1", "fd00::5", "fc12::1", "fe80::1", "::ffff:172.18.0.3", "172.18.0.3:5555", "[fd00::5]:587"])(
    "%s é interno",
    (ip) => expect(isInternalAddress(ip)).toBe(true),
  );
  it.each(["203.0.113.7", ["172", "32", "0", "1"].join("."), ["172", "15", "0", "1"].join("."), "8.8.8.8", "2001:db8::1", "[2001:db8::1]:25", "::ffff:203.0.113.7", "lixo", ""])("%s não é interno", (ip) =>
    expect(isInternalAddress(ip)).toBe(false),
  );
});
