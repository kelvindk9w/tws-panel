/**
 * login-messages.test.ts — textos e números do aviso de tentativas restantes:
 * durações (arredondamento para cima, plural) e o que resta no IP (nível do lockout).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginLimiter } from "../src/services/login-limiter.js";
import { attemptsText, durationText } from "../src/services/login-messages.js";

afterEach(() => vi.useRealTimers());

describe("attemptsText / durationText", () => {
  it("singular e plural de tentativas", () => {
    expect(attemptsText(1)).toBe("Resta 1 tentativa");
    expect(attemptsText(4)).toBe("Restam 4 tentativas");
  });

  it.each([
    [60, "1 minuto"],
    [61, "2 minutos"],
    [90, "2 minutos"],
    [300, "5 minutos"],
    [1800, "30 minutos"],
    [3599, "60 minutos"],
    [4800, "2 horas"],
    [4801, "2 horas"],
    [7201, "3 horas"],
    [86400, "24 horas"],
  ])("durationText(%i) = %s", (sec, text) => {
    expect(durationText(sec)).toBe(text);
  });
});

describe("LoginLimiter.remaining", () => {
  it("IP sem histórico: 5 tentativas e 60 s", () => {
    expect(new LoginLimiter().remaining("203.0.113.1")).toEqual({ attemptsLeft: 5, nextLockSec: 60 });
  });

  it("conta as falhas da janela", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 3; i += 1) {
      l.check("203.0.113.2");
      l.onFailure("203.0.113.2");
    }
    expect(l.remaining("203.0.113.2").attemptsLeft).toBe(2);
    l.check("203.0.113.2");
    l.onFailure("203.0.113.2");
    expect(l.remaining("203.0.113.2").attemptsLeft).toBe(1);
  });

  it("o próximo bloqueio do IP dobra a cada reincidência e respeita o teto de 30 min", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const l = new LoginLimiter();
    const ip = "203.0.113.3";
    for (const next of [60, 120, 240, 480, 960, 1800, 1800]) {
      expect(l.remaining(ip).nextLockSec).toBe(next);
      for (let i = 0; i < 5; i += 1) {
        l.check(ip);
        l.onFailure(ip);
      }
      vi.advanceTimersByTime(next * 1000 + 1000);
    }
  });

  it("falhas fora da janela de 1 minuto não contam", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const l = new LoginLimiter();
    l.check("203.0.113.4");
    l.onFailure("203.0.113.4");
    vi.advanceTimersByTime(61_000);
    expect(l.remaining("203.0.113.4").attemptsLeft).toBe(5);
  });
});
