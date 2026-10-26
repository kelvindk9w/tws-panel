import { describe, expect, it } from "vitest";
import {
  isMailHealthAcknowledgeable,
  MAIL_HEALTH_ACKNOWLEDGEABLE,
  MAIL_HEALTH_MIN_INTERVAL_MS,
  mailHealthCounts,
  mailHealthFingerprint,
  mailHealthScope,
  type MailHealthCheckId,
} from "../src/mail-health";

describe("mailHealthScope", () => {
  it("itens do servidor (valem para todos os projetos)", () => {
    for (const id of ["helo", "ptr", "port25", "tls", "dnsbl"] as MailHealthCheckId[]) {
      expect(mailHealthScope(id), id).toBe("server");
    }
  });

  it("itens do domínio, incluindo a fila (ela só olha mensagens enviadas por @domínio)", () => {
    for (const id of ["a", "mx", "spf", "dkim", "dmarc", "queue", "propagation", "mta_sts", "tls_rpt"] as MailHealthCheckId[]) {
      expect(mailHealthScope(id), id).toBe("domain");
    }
  });

  it("todo item tem exatamente um nível", () => {
    const all: MailHealthCheckId[] = ["a", "helo", "mx", "spf", "dkim", "dmarc", "ptr", "port25", "queue", "tls", "dnsbl", "propagation", "mta_sts", "tls_rpt"];
    const scopes = all.map((id) => mailHealthScope(id));
    expect(scopes.filter((s) => s === "server")).toHaveLength(5);
    expect(scopes.filter((s) => s === "domain")).toHaveLength(9);
  });
});

describe("MAIL_HEALTH_MIN_INTERVAL_MS", () => {
  it("são 15 segundos, em milissegundos inteiros de segundo (a interface conta em segundos)", () => {
    expect(MAIL_HEALTH_MIN_INTERVAL_MS).toBe(15_000);
    expect(MAIL_HEALTH_MIN_INTERVAL_MS % 1000).toBe(0);
  });
});

describe("itens que podem ser marcados como ciente", () => {
  it("só os que dependem do provedor da VPS: PTR e porta 25", () => {
    expect([...MAIL_HEALTH_ACKNOWLEDGEABLE]).toEqual(["ptr", "port25"]);
    expect(isMailHealthAcknowledgeable("ptr")).toBe(true);
    expect(isMailHealthAcknowledgeable("port25")).toBe(true);
    for (const id of ["spf", "dkim", "dmarc", "mx", "a", "mta_sts", "tls_rpt", "tls", "dnsbl", "queue"]) {
      expect(isMailHealthAcknowledgeable(id), id).toBe(false);
    }
    expect(isMailHealthAcknowledgeable("qualquer coisa")).toBe(false);
  });
});

describe("mailHealthFingerprint", () => {
  const base = { level: "warn" as const, code: "mismatch", expected: "mail.example.com", found: ["velho.example.com"] };

  it("é igual para o mesmo problema e muda quando o problema muda", () => {
    expect(mailHealthFingerprint(base)).toBe(mailHealthFingerprint({ ...base }));
    expect(mailHealthFingerprint({ ...base, found: ["outro.example.com"] })).not.toBe(mailHealthFingerprint(base));
    expect(mailHealthFingerprint({ ...base, level: "critical" })).not.toBe(mailHealthFingerprint(base));
    expect(mailHealthFingerprint({ ...base, code: "missing" })).not.toBe(mailHealthFingerprint(base));
    expect(mailHealthFingerprint({ ...base, expected: "mail.outro.example.com" })).not.toBe(mailHealthFingerprint(base));
  });

  it("aceita item sem esperado nem encontrado", () => {
    expect(mailHealthFingerprint({ level: "warn", code: "missing" })).toBe("warn|missing|");
  });
});

describe("mailHealthCounts", () => {
  const at = { reason: null, at: "2026-10-26T00:00:00.000Z", by: null };

  it("pesam ok, atenção e crítico; opcional, informativo e ciente ficam de fora", () => {
    expect(mailHealthCounts({ level: "ok" })).toBe(true);
    expect(mailHealthCounts({ level: "warn" })).toBe(true);
    expect(mailHealthCounts({ level: "critical" })).toBe(true);
    expect(mailHealthCounts({ level: "optional" })).toBe(false);
    expect(mailHealthCounts({ level: "info" })).toBe(false);
    expect(mailHealthCounts({ level: "warn", acknowledged: at })).toBe(false);
    expect(mailHealthCounts({ level: "critical", acknowledged: at })).toBe(false);
  });
});
