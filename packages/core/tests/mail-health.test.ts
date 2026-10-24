import { describe, expect, it } from "vitest";
import { MAIL_HEALTH_MIN_INTERVAL_MS, mailHealthScope, type MailHealthCheckId } from "../src/mail-health";

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
