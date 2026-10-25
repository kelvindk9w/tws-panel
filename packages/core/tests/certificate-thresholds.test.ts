/**
 * Janelas de renovação e de alerta proporcionais à validade do certificado
 * (90, 64, 45 e 6 dias) e a avaliação única do alerta.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_WARN_FRACTION,
  CERTIFICATE_DAY_MS as DAY,
  DEFAULT_CERTIFICATE_VALIDITY_MS,
  FAILURE_CRITICAL_MS,
  FAILURE_MIN_DURATION_MS,
  FAILURE_MIN_ROUNDS,
  assessCertificateAlert,
  certificateThresholds,
  certificateValidityMs,
  certificateValidityTier,
  expectedRenewalAt,
  isFailureConfirmed,
  type CertificateFailureSummary,
} from "../src/certificates";

const HOUR = DAY / 24;
const T0 = Date.parse("2027-03-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("certificateValidityMs", () => {
  it("usa o início e o fim quando existem", () => {
    expect(certificateValidityMs(iso(T0), iso(T0 + 64 * DAY))).toBe(64 * DAY);
  });
  it("presume 90 dias sem início, com início ilegível ou datas invertidas/iguais", () => {
    expect(certificateValidityMs(null, iso(T0))).toBe(DEFAULT_CERTIFICATE_VALIDITY_MS);
    expect(certificateValidityMs(undefined, iso(T0))).toBe(90 * DAY);
    expect(certificateValidityMs("lixo", iso(T0))).toBe(90 * DAY);
    expect(certificateValidityMs(iso(T0 + DAY), iso(T0))).toBe(90 * DAY);
    expect(certificateValidityMs(iso(T0), iso(T0))).toBe(90 * DAY);
    expect(certificateValidityMs(iso(T0), "lixo")).toBe(90 * DAY);
  });
});

describe("certificateThresholds (automático)", () => {
  it.each([
    // validade, renovação (1/3), aviso (1/4), crítico
    [90, 30 * DAY, 22.5 * DAY, 7 * DAY],
    [64, (64 / 3) * DAY, 16 * DAY, (64 / 12) * DAY],
    [45, 15 * DAY, 11.25 * DAY, 3.75 * DAY],
    [6, 2 * DAY, 1.5 * DAY, 12 * HOUR],
  ])("%i dias", (days, renew, warn, critical) => {
    const t = certificateThresholds(days * DAY, "automatic");
    expect(t.renewBeforeMs).toBeCloseTo(renew, 0);
    expect(t.warnMs).toBeCloseTo(warn, 0);
    expect(t.criticalMs).toBeCloseTo(critical, 0);
  });

  it("o aviso vem depois da renovação do Caddy (folga de 1/12 da validade)", () => {
    for (const d of [90, 64, 45, 6]) {
      const t = certificateThresholds(d * DAY, "automatic");
      expect(t.warnMs).toBeLessThan(t.renewBeforeMs);
      expect(t.renewBeforeMs - t.warnMs).toBeCloseTo((d * DAY) / 12, 0);
      expect(t.criticalMs).toBeLessThanOrEqual(t.warnMs / 2);
    }
  });

  it("a fração do aviso automático é 1/4", () => {
    expect(AUTO_WARN_FRACTION).toBe(0.25);
  });

  it("validade curtíssima: aviso mínimo de 12 h, mas nunca mais que metade da validade", () => {
    const t = certificateThresholds(20 * HOUR, "automatic");
    expect(t.warnMs).toBe(10 * HOUR);
    expect(t.criticalMs).toBe(5 * HOUR);
    expect(certificateThresholds(30 * HOUR, "automatic").warnMs).toBe(12 * HOUR);
  });
});

describe("certificateThresholds (manual)", () => {
  it("90 dias: 30 dias de aviso e 7 de crítico (o que já existia)", () => {
    const t = certificateThresholds(90 * DAY, "manual");
    expect(t.warnMs).toBe(30 * DAY);
    expect(t.criticalMs).toBe(7 * DAY);
  });
  it("1 ano: o aviso não passa de 30 dias", () => {
    expect(certificateThresholds(398 * DAY, "manual").warnMs).toBe(30 * DAY);
  });
  it("64, 45 e 6 dias: 1/3 da validade", () => {
    expect(certificateThresholds(45 * DAY, "manual").warnMs).toBe(15 * DAY);
    expect(certificateThresholds(6 * DAY, "manual").warnMs).toBe(2 * DAY);
    expect(certificateThresholds(64 * DAY, "manual").warnMs).toBeCloseTo((64 / 3) * DAY, 0);
  });
});

describe("expectedRenewalAt", () => {
  it("fim − 1/3 da validade, para cada validade", () => {
    for (const d of [90, 64, 45, 6]) {
      const to = T0 + d * DAY;
      expect(Math.abs(Date.parse(expectedRenewalAt(iso(T0), iso(to))) - (to - (d * DAY) / 3))).toBeLessThan(1000);
    }
  });
  it("sem início presume 90 dias (30 dias antes do fim)", () => {
    expect(expectedRenewalAt(null, iso(T0 + 90 * DAY))).toBe(iso(T0 + 60 * DAY));
  });
});

describe("certificateValidityTier: fronteiras", () => {
  const to = T0 + 90 * DAY;
  const tier = (mode: "automatic" | "manual", left: number, days = 90) =>
    certificateValidityTier(mode, iso(to - days * DAY), iso(to), to - left);

  it("automático de 90 dias", () => {
    expect(tier("automatic", 22.5 * DAY + 1)).toBe("ok");
    expect(tier("automatic", 22.5 * DAY)).toBe("warning");
    expect(tier("automatic", 7 * DAY + 1)).toBe("warning");
    expect(tier("automatic", 7 * DAY)).toBe("critical");
    expect(tier("automatic", 1)).toBe("critical");
    expect(tier("automatic", 0)).toBe("expired");
    expect(tier("automatic", -DAY)).toBe("expired");
  });
  it("automático de 6 dias", () => {
    const t6 = (left: number) => certificateValidityTier("automatic", iso(to - 6 * DAY), iso(to), to - left);
    expect(t6(1.5 * DAY + 1)).toBe("ok");
    expect(t6(1.5 * DAY)).toBe("warning");
    expect(t6(12 * HOUR + 1)).toBe("warning");
    expect(t6(12 * HOUR)).toBe("critical");
  });
  it("automático de 64 e 45 dias", () => {
    const at = (days: number, left: number) => certificateValidityTier("automatic", iso(to - days * DAY), iso(to), to - left);
    expect(at(64, 16 * DAY + 1)).toBe("ok");
    expect(at(64, 16 * DAY)).toBe("warning");
    expect(at(45, 11.25 * DAY + 1)).toBe("ok");
    expect(at(45, 11.25 * DAY)).toBe("warning");
  });
  it("manual de 90 dias: 30 e 7 dias", () => {
    expect(tier("manual", 30 * DAY + 1)).toBe("ok");
    expect(tier("manual", 30 * DAY)).toBe("warning");
    expect(tier("manual", 7 * DAY)).toBe("critical");
  });
});

describe("isFailureConfirmed", () => {
  const fail = (rounds: number, spanMs: number): CertificateFailureSummary => ({
    rounds,
    firstAt: iso(T0),
    lastAt: iso(T0 + spanMs),
  });
  it("exige 3 rodadas E 1 hora", () => {
    expect(FAILURE_MIN_ROUNDS).toBe(3);
    expect(isFailureConfirmed(fail(3, FAILURE_MIN_DURATION_MS))).toBe(true);
    expect(isFailureConfirmed(fail(2, 5 * HOUR))).toBe(false);
    expect(isFailureConfirmed(fail(10, FAILURE_MIN_DURATION_MS - 1))).toBe(false);
  });
  it("a hora é exatamente 3.600.000 ms (valores literais, não a constante)", () => {
    expect(isFailureConfirmed({ rounds: 3, firstAt: iso(T0), lastAt: iso(T0 + 3_600_000) })).toBe(true);
    expect(isFailureConfirmed({ rounds: 3, firstAt: iso(T0), lastAt: iso(T0 + 3_599_999) })).toBe(false);
  });
  it("sem falha, ou sem datas legíveis, não confirma", () => {
    expect(isFailureConfirmed(null)).toBe(false);
    expect(isFailureConfirmed(undefined)).toBe(false);
    expect(isFailureConfirmed({ rounds: 9, firstAt: null, lastAt: iso(T0) })).toBe(false);
    expect(isFailureConfirmed({ rounds: 9, firstAt: iso(T0), lastAt: null })).toBe(false);
    expect(isFailureConfirmed({ rounds: 9, firstAt: "x", lastAt: "y" })).toBe(false);
  });
});

describe("assessCertificateAlert", () => {
  const to = T0 + 90 * DAY;
  const base = { nowMs: T0, validFrom: iso(to - 90 * DAY), validTo: iso(to) };
  const failing = (spanMs: number): CertificateFailureSummary => ({ rounds: 5, firstAt: iso(T0 - spanMs), lastAt: iso(T0) });

  it("certificado longe do fim, sem falha: nada", () => {
    expect(assessCertificateAlert({ ...base, nowMs: T0, mode: "automatic" })).toEqual({ level: "none", reason: null });
  });
  it("vencido servido: crítico expired, nos dois modos", () => {
    expect(assessCertificateAlert({ mode: "automatic", nowMs: T0, validFrom: null, validTo: null, servedExpired: true })).toEqual({
      level: "critical",
      reason: "expired",
    });
    expect(assessCertificateAlert({ ...base, mode: "manual", servedExpired: true }).reason).toBe("expired");
  });
  it("validTo no passado: crítico expired", () => {
    expect(assessCertificateAlert({ mode: "manual", nowMs: to + 1, validFrom: base.validFrom, validTo: base.validTo })).toEqual({
      level: "critical",
      reason: "expired",
    });
  });
  it("automático que não renovou: warning e depois crítico (renewal_late)", () => {
    expect(assessCertificateAlert({ ...base, mode: "automatic", nowMs: to - 22 * DAY })).toEqual({ level: "warning", reason: "renewal_late" });
    expect(assessCertificateAlert({ ...base, mode: "automatic", nowMs: to - 5 * DAY })).toEqual({ level: "critical", reason: "renewal_late" });
  });
  it("manual perto do fim: expiring", () => {
    expect(assessCertificateAlert({ ...base, mode: "manual", nowMs: to - 20 * DAY })).toEqual({ level: "warning", reason: "expiring" });
    expect(assessCertificateAlert({ ...base, mode: "manual", nowMs: to - 3 * DAY })).toEqual({ level: "critical", reason: "expiring" });
  });
  it("renovação falhando com certificado ainda longe do fim: warning issuance_failing", () => {
    expect(assessCertificateAlert({ ...base, mode: "automatic", failure: failing(2 * HOUR) })).toEqual({
      level: "warning",
      reason: "issuance_failing",
    });
  });
  it("falha ainda curta ou pouco repetida não alerta", () => {
    expect(assessCertificateAlert({ ...base, mode: "automatic", failure: failing(30 * 60_000) }).level).toBe("none");
    expect(assessCertificateAlert({ ...base, mode: "automatic", failure: { rounds: 2, firstAt: iso(T0 - 9 * HOUR), lastAt: iso(T0) } }).level).toBe("none");
  });
  it("sem nenhum certificado: warning, e crítico quando a falha dura 24 h", () => {
    const none = { mode: "automatic" as const, nowMs: T0, validFrom: null, validTo: null };
    expect(assessCertificateAlert({ ...none, failure: failing(FAILURE_CRITICAL_MS - 1) })).toEqual({ level: "warning", reason: "issuance_failing" });
    expect(assessCertificateAlert({ ...none, failure: failing(FAILURE_CRITICAL_MS) })).toEqual({ level: "critical", reason: "issuance_failing" });
  });
  it("com certificado válido a falha longa continua só warning", () => {
    expect(assessCertificateAlert({ ...base, mode: "automatic", failure: failing(3 * DAY) }).level).toBe("warning");
  });
  it("renovação atrasada tem prioridade sobre a falha", () => {
    expect(assessCertificateAlert({ ...base, mode: "automatic", nowMs: to - 5 * DAY, failure: failing(3 * DAY) })).toEqual({
      level: "critical",
      reason: "renewal_late",
    });
  });
  it("manual ignora o log do Caddy", () => {
    expect(assessCertificateAlert({ ...base, mode: "manual", failure: failing(3 * DAY) })).toEqual({ level: "none", reason: null });
  });
  it("funciona para nomes de qualquer origem (sem Caddyfile): só entram datas e modo", () => {
    expect(
      assessCertificateAlert({ mode: "automatic", nowMs: T0, validFrom: iso(T0 - 5 * DAY), validTo: iso(T0 + DAY) }).reason,
    ).toBe("renewal_late");
  });
});
