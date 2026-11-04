import { describe, expect, it } from "vitest";
import { explainSendFailure, failureState } from "../src/send-errors.js";

const kind = (detail: string | null, code: number | null = null) => explainSendFailure({ code, detail }).kind;

describe("explainSendFailure", () => {
  it.each([
    ["550 5.1.1 The email account that you tried to reach does not exist", "no_such_user"],
    ["550 5.1.1 <x@y.com>: Recipient address rejected: User unknown", "no_such_user"],
    ["552 5.2.2 Over quota", "mailbox_full"],
    ["452 4.2.2 The email account is over quota", "mailbox_full"],
    ["552 5.3.4 Message size exceeds fixed limit", "message_too_large"],
    ["552 5.2.3 message too big", "message_too_large"],
    ["550 5.7.1 Service unavailable; Client host [203.0.113.10] blocked using zen.spamhaus.org", "blocklisted"],
    ["550 5.7.1 Message rejected due to S3150 banned sending IP", "blocklisted"],
    ["550 5.7.511 Access denied, banned sender", "blocklisted"],
    ["550 5.7.1 Message looks like spam", "spam_content"],
    ["550 5.7.26 This message does not pass authentication checks (SPF and DKIM both do not pass)", "sender_auth"],
    ["550 5.7.1 DMARC policy violation", "sender_auth"],
    ["451 4.7.1 Greylisted, please try again later", "greylisted"],
    ["421 4.7.28 Our system has detected an unusual rate of unsolicited mail", "rate_limited"],
    ["451 4.7.0 Too many connections from your IP", "rate_limited"],
    ["550 5.7.1 Relay access denied by policy", "policy_rejected"],
    ['SMTP error occurred (smtp.error) { details = Connection Error, reason = "record not found for MX" }', "no_mx"],
    ["No MX records were found, attempting implicit MX.", "no_mx"],
    ["Connection to 'x.example.org' failed: record not found", "dns_failure"],
    ["Temporary failure in name resolution", "dns_failure"],
    ["TLS handshake failed: invalid certificate", "tls_failure"],
    ["MTA-STS policy requires TLS", "tls_failure"],
    ["Connection timed out", "timeout"],
    ["operation timeout", "timeout"],
    ["Connection refused (os error 111)", "connection_failed"],
    ["Network is unreachable", "connection_failed"],
    ["Queue rate limit exceeded", "expired"],
    ["Delivery time exceeded, giving up", "expired"],
  ])("%s -> %s", (detail, expected) => {
    expect(kind(detail)).toBe(expected);
  });

  it("usa o código quando o texto não ajuda", () => {
    expect(kind("nope", 554)).toBe("rejected_other");
    expect(kind("nope", 451)).toBe("temporary");
    expect(kind("5.0.0 nope")).toBe("rejected_other");
    expect(kind("4.0.0 nope")).toBe("temporary");
    expect(kind("nope")).toBe("unknown");
    expect(kind(null)).toBe("unknown");
  });

  it("separa código e código estendido, e limpa o texto técnico", () => {
    const f = explainSendFailure({ code: null, detail: "550 5.1.1 user\u0007 unknown\n" });
    expect(f).toEqual({ kind: "no_such_user", code: 550, enhanced: "5.1.1", technical: "550 5.1.1 user unknown" });
    expect(explainSendFailure({ code: 421, detail: "x" }).code).toBe(421);
  });
});

describe("failureState", () => {
  it("recusa definitiva do destino é rejected; falha de transporte é failed", () => {
    expect(failureState(explainSendFailure({ code: 550, detail: "550 5.1.1 user unknown" }))).toBe("rejected");
    expect(failureState(explainSendFailure({ code: null, detail: "record not found for MX" }))).toBe("failed");
    expect(failureState(explainSendFailure({ code: null, detail: "Queue rate limit exceeded" }))).toBe("failed");
    expect(failureState(explainSendFailure({ code: 554, detail: "554 5.7.1 spam" }))).toBe("rejected");
    expect(failureState(explainSendFailure({ code: null, detail: "5.7.1 policy" }))).toBe("rejected");
    expect(failureState(explainSendFailure({ code: 451, detail: "gave up" }))).toBe("failed");
  });
});
