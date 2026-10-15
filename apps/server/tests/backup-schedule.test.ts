/**
 * backup-schedule.test.ts — quando o backup roda, quando o externo está
 * atrasado e quando lembrar da senha. Funções puras (relógio passado como
 * número): nada de disco nem de relógio falso.
 */
import { describe, expect, it } from "vitest";
import {
  currentSlot,
  isReminderDue,
  isRemoteStale,
  nextSlot,
  remoteStaleThresholdMs,
  timezoneLabel,
} from "../src/services/backup-schedule.js";

const H = 3_600_000;
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("horários do backup (03:00 no fuso da VPS)", () => {
  it("a cada 24 h: um horário por dia, às 03:00", () => {
    expect(currentSlot(local(2026, 10, 14, 10), 24, 3)).toBe(local(2026, 10, 14, 3));
    expect(currentSlot(local(2026, 10, 14, 2, 59), 24, 3)).toBe(local(2026, 10, 13, 3));
    expect(nextSlot(local(2026, 10, 14, 2, 59), 24, 3)).toBe(local(2026, 10, 14, 3));
    expect(nextSlot(local(2026, 10, 14, 3), 24, 3)).toBe(local(2026, 10, 15, 3));
  });

  it("a cada 12 h: 03:00 e 15:00", () => {
    expect(currentSlot(local(2026, 10, 14, 16), 12, 3)).toBe(local(2026, 10, 14, 15));
    expect(currentSlot(local(2026, 10, 14, 1), 12, 3)).toBe(local(2026, 10, 13, 15));
    expect(nextSlot(local(2026, 10, 14, 4), 12, 3)).toBe(local(2026, 10, 14, 15));
  });

  it("a cada 6 h: 03, 09, 15 e 21", () => {
    expect(currentSlot(local(2026, 10, 14, 22), 6, 3)).toBe(local(2026, 10, 14, 21));
    expect(currentSlot(local(2026, 10, 14, 8, 59), 6, 3)).toBe(local(2026, 10, 14, 3));
    expect(nextSlot(local(2026, 10, 14, 0), 6, 3)).toBe(local(2026, 10, 14, 3));
  });
});

describe("backup externo atrasado", () => {
  it("o limite é 2 dias ou o dobro da frequência, o que for maior", () => {
    expect(remoteStaleThresholdMs(24)).toBe(48 * H);
    expect(remoteStaleThresholdMs(6)).toBe(48 * H);
    expect(remoteStaleThresholdMs(36)).toBe(72 * H);
  });

  it("conta desde o último conferido, ou desde que ficou ligado", () => {
    const now = local(2026, 10, 14, 12);
    expect(isRemoteStale({ lastVerifiedAt: now - 47 * H, since: now - 100 * H, now, frequencyHours: 24 })).toBe(false);
    expect(isRemoteStale({ lastVerifiedAt: now - 49 * H, since: now - 100 * H, now, frequencyHours: 24 })).toBe(true);
    expect(isRemoteStale({ lastVerifiedAt: null, since: now - 10 * H, now, frequencyHours: 24 })).toBe(false);
    expect(isRemoteStale({ lastVerifiedAt: null, since: now - 49 * H, now, frequencyHours: 24 })).toBe(true);
  });
});

describe("lembrete da senha (a cada 3 meses)", () => {
  const day = 24 * H;
  const now = local(2026, 10, 14, 12);
  it("conta desde a senha definida, o último teste certo ou o último lembrete", () => {
    expect(isReminderDue({ passwordSetAt: null, lastTestOkAt: null, lastReminderAt: null, now })).toBe(false);
    expect(isReminderDue({ passwordSetAt: now - 89 * day, lastTestOkAt: null, lastReminderAt: null, now })).toBe(false);
    expect(isReminderDue({ passwordSetAt: now - 91 * day, lastTestOkAt: null, lastReminderAt: null, now })).toBe(true);
    expect(isReminderDue({ passwordSetAt: now - 200 * day, lastTestOkAt: now - 10 * day, lastReminderAt: null, now })).toBe(false);
    expect(isReminderDue({ passwordSetAt: now - 200 * day, lastTestOkAt: null, lastReminderAt: now - 5 * day, now })).toBe(false);
  });
});

describe("fuso da VPS", () => {
  it("escreve o deslocamento como UTC±HH:MM", () => {
    expect(timezoneLabel(-180)).toBe("UTC-03:00");
    expect(timezoneLabel(0)).toBe("UTC+00:00");
    expect(timezoneLabel(330)).toBe("UTC+05:30");
  });
});
