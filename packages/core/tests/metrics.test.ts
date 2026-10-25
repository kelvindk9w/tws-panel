import { describe, expect, it } from "vitest";
import {
  CONTAINER_METRIC_KINDS,
  HOST_METRIC_KINDS,
  METRICS_MAX_POINTS,
  METRICS_RANGES,
  METRICS_RANGE_SECONDS,
  METRICS_RETENTION_DEFAULT,
  METRICS_RETENTION_LIMITS,
  validateMetricsRetention,
} from "../src/index";

describe("retenção das métricas", () => {
  it("o padrão é 48 h por minuto, 90 dias por hora e 2 anos por dia, e é válido", () => {
    expect(METRICS_RETENTION_DEFAULT).toEqual({ minuteHours: 48, hourDays: 90, dayDays: 730 });
    expect(validateMetricsRetention(METRICS_RETENTION_DEFAULT)).toEqual({ ok: true, value: METRICS_RETENTION_DEFAULT });
  });

  it("aceita os extremos de cada limite e recusa um passo além", () => {
    const base = { minuteHours: 48, hourDays: 90, dayDays: 730 };
    for (const key of ["minuteHours", "hourDays", "dayDays"] as const) {
      const { min, max } = METRICS_RETENTION_LIMITS[key];
      // o mínimo de dayDays (90) cabe com hourDays 90; o máximo de hourDays (365) não cabe com dayDays 730? cabe.
      expect(validateMetricsRetention({ ...base, [key]: min }).ok).toBe(true);
      expect(validateMetricsRetention({ ...base, [key]: max }).ok).toBe(true);
      expect(validateMetricsRetention({ ...base, [key]: min - 1 })).toEqual({ ok: false, error: "invalid_retention" });
      expect(validateMetricsRetention({ ...base, [key]: max + 1 })).toEqual({ ok: false, error: "invalid_retention" });
    }
  });

  it("o dado por dia não pode ser guardado por menos tempo que o dado por hora", () => {
    expect(validateMetricsRetention({ minuteHours: 24, hourDays: 90, dayDays: 90 }).ok).toBe(true);
    expect(validateMetricsRetention({ minuteHours: 24, hourDays: 91, dayDays: 90 })).toEqual({ ok: false, error: "retention_order" });
  });

  it("recusa o que não é inteiro, texto, nulo, ausente e objeto inexistente", () => {
    const ok = METRICS_RETENTION_DEFAULT;
    for (const bad of [1.5, "48", null, undefined, Number.NaN, Infinity]) {
      expect(validateMetricsRetention({ ...ok, minuteHours: bad })).toEqual({ ok: false, error: "invalid_retention" });
    }
    expect(validateMetricsRetention({ minuteHours: 48, hourDays: 90 })).toEqual({ ok: false, error: "invalid_retention" });
    expect(validateMetricsRetention(null)).toEqual({ ok: false, error: "invalid_retention" });
    expect(validateMetricsRetention("x")).toEqual({ ok: false, error: "invalid_retention" });
  });

  it("devolve só os três campos (campo a mais não passa adiante)", () => {
    const r = validateMetricsRetention({ ...METRICS_RETENTION_DEFAULT, extra: 1 });
    expect(r).toEqual({ ok: true, value: METRICS_RETENTION_DEFAULT });
  });
});

describe("catálogo de métricas", () => {
  it("toda janela tem duração, em ordem crescente", () => {
    const secs = METRICS_RANGES.map((r) => METRICS_RANGE_SECONDS[r]);
    expect([...secs].sort((a, b) => a - b)).toEqual(secs);
    expect(METRICS_MAX_POINTS).toBeGreaterThan(100);
  });

  it("eventos são só os contadores de acontecimento", () => {
    const hostEvents = Object.entries(HOST_METRIC_KINDS).filter(([, k]) => k === "event").map(([n]) => n);
    const containerEvents = Object.entries(CONTAINER_METRIC_KINDS).filter(([, k]) => k === "event").map(([n]) => n);
    expect(hostEvents).toEqual(["oom"]);
    expect(containerEvents.sort()).toEqual(["oom", "restarts"]);
  });
});
