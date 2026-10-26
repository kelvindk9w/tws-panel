import { describe, expect, it } from "vitest";
import {
  isMailHealthAcknowledgeable,
  isMtaStsActive,
  MTA_STS_ID_GRACE_MS,
  mtaStsProgress,
  mtaStsStateOfCheck,
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

describe("MTA-STS: o que já está pronto e o que falta", () => {
  it("só o código dos estados ativos conta como política ativa (testing, enforce e id antigo ainda aceito)", () => {
    for (const code of ["testing", "enforce", "id_grace"]) expect(isMtaStsActive({ id: "mta_sts", code }), code).toBe(true);
    for (const code of ["absent", "missing_a", "id_outdated", "mx_mismatch", "cert_pending"]) expect(isMtaStsActive({ id: "mta_sts", code }), code).toBe(false);
    expect(isMtaStsActive({ id: "tls_rpt", code: "testing" })).toBe(false);
  });

  it("o estado da lista de domínios sai do código do item da saúde (uma só regra)", () => {
    const cases: Array<[string, string]> = [
      ["testing", "active"],
      ["enforce", "active"],
      ["id_grace", "active"],
      ["publish_unavailable", "unavailable"],
      ["absent", "waiting_dns"],
      ["missing_a", "waiting_dns"],
      ["a_mismatch", "waiting_dns"],
      ["a_proxied", "waiting_dns"],
      ["missing_txt", "missing_txt"],
      ["cert_pending", "issuing"],
      ["cert_failed", "issuing"],
      ["unreachable", "issuing"],
      ["txt_unavailable", "unverified"],
      ["mx_unverified", "unverified"],
      ["id_outdated", "attention"],
      ["invalid", "attention"],
      ["mx_mismatch", "attention"],
      ["mx_external", "attention"],
      ["enforce_lapsed", "attention"],
    ];
    for (const [code, state] of cases) expect(mtaStsStateOfCheck({ code }), code).toBe(state);
    // só "ativo" coincide com isMtaStsActive: nenhum outro código vira ativo
    for (const [code, state] of cases) expect(state === "active", code).toBe(isMtaStsActive({ id: "mta_sts", code }));
  });

  it("nada feito: A, TXT e política faltam", () => {
    expect(mtaStsProgress("absent")).toEqual({ a: false, txt: false, policy: false });
  });

  it("A existe e falta o TXT; TXT existe e falta o A (ou ele aponta errado ou está atrás do proxy)", () => {
    expect(mtaStsProgress("missing_txt")).toEqual({ a: true, txt: false, policy: false });
    for (const code of ["missing_a", "a_mismatch", "a_proxied"]) expect(mtaStsProgress(code), code).toEqual({ a: false, txt: true, policy: false });
  });

  it("DNS completo mas a política não abre: falta só o certificado", () => {
    for (const code of ["cert_pending", "cert_failed", "unreachable", "enforce_lapsed"]) {
      expect(mtaStsProgress(code), code).toEqual({ a: true, txt: true, policy: false });
    }
  });

  it("política que abre com TXT de id antigo: só o TXT falta", () => {
    expect(mtaStsProgress("id_outdated")).toEqual({ a: true, txt: false, policy: true });
  });

  it("política que abre: tudo pronto, mesmo com algo a acertar no conteúdo", () => {
    for (const code of ["testing", "enforce", "id_grace", "mx_external", "mx_mismatch", "invalid", "mx_unverified"]) {
      expect(mtaStsProgress(code), code).toEqual({ a: true, txt: true, policy: true });
    }
  });

  it("sem como dizer (consulta falhou, publicação indisponível): tudo desconhecido", () => {
    for (const code of ["txt_unavailable", "publish_unavailable", "qualquer"]) expect(mtaStsProgress(code), code).toEqual({ a: null, txt: null, policy: null });
  });

  it("o id antigo vale por um dia (o max_age que o painel publica)", () => {
    expect(MTA_STS_ID_GRACE_MS).toBe(86_400_000);
  });
});
