import { describe, expect, it } from "vitest";
import { METRICS_MAX_POINTS, METRICS_RANGES, METRICS_RETENTION_DEFAULT } from "@paas/core";
import {
  DAY,
  HOUR,
  PROJECTION_MAX_DAYS,
  bucketize,
  cellPoint,
  chooseResolution,
  mergeAggregates,
  periodStart,
  projectDaysToFull,
  rollupSamples,
  samplePoint,
  type AggRecord,
  type Sample,
} from "../src/services/metrics-series.js";

const sample = (t: number, h: Record<string, number>, c: Record<string, Record<string, number>> = {}): Sample => ({ t, h, c });

describe("rollupSamples (minuto → hora)", () => {
  it("gauge vira [mín, média, máx, n]; evento vira [soma]", () => {
    const r = rollupSamples(
      [sample(0, { cpuBusy: 10, oom: 0 }), sample(60, { cpuBusy: 30, oom: 1 }), sample(120, { cpuBusy: 20, oom: 2 })],
      0,
    )!;
    expect(r.t).toBe(0);
    expect(r.n).toBe(3);
    expect(r.h.cpuBusy).toEqual([10, 20, 30, 3]);
    expect(r.h.oom).toEqual([3]);
  });

  it("métrica ausente em algumas amostras: a média e o n contam só as que existem (sem zero falso)", () => {
    const r = rollupSamples([sample(0, { cpuBusy: 10 }), sample(60, {}), sample(120, { cpuBusy: 30 })], 0)!;
    expect(r.h.cpuBusy).toEqual([10, 20, 30, 2]);
    expect(r.n).toBe(3);
  });

  it("containers entram por chave; chave sem nenhuma métrica válida some; métrica desconhecida e NaN são ignoradas", () => {
    const r = rollupSamples(
      [sample(0, { naoExiste: 5, cpuBusy: Number.NaN }, { "p/web": { cpu: 50, mem: 100, restarts: 1, lixo: 3 }, "p/vazio": { lixo: 1 } }), sample(60, {}, { "p/web": { cpu: 70, mem: 100, restarts: 0 } })],
      0,
    )!;
    expect(r.h).toEqual({});
    expect(Object.keys(r.c)).toEqual(["p/web"]);
    expect(r.c["p/web"]).toEqual({ cpu: [50, 60, 70, 2], mem: [100, 100, 100, 2], restarts: [1] });
  });

  it("sem amostras: null; métricas herdadas do Object (__proto__, constructor) não passam", () => {
    expect(rollupSamples([], 0)).toBeNull();
    const r = rollupSamples([sample(0, JSON.parse('{"constructor": 1, "toString": 2, "cpuBusy": 4}'))], 0)!;
    expect(Object.keys(r.h)).toEqual(["cpuBusy"]);
  });
});

describe("mergeAggregates (hora → dia)", () => {
  const hour = (t: number, n: number, cell: number[], ev?: number): AggRecord => ({
    t,
    n,
    h: { cpuBusy: cell, ...(ev === undefined ? {} : { oom: [ev] }) },
    c: { "p/web": { cpu: cell, restarts: [ev ?? 0] } },
  });

  it("mín dos mínimos, máx dos máximos, média ponderada por n, soma dos eventos", () => {
    const m = mergeAggregates([hour(0, 60, [10, 20, 40, 60], 1), hour(3600, 20, [5, 50, 90, 20], 2)], 0)!;
    expect(m.t).toBe(0);
    expect(m.n).toBe(80);
    expect(m.h.cpuBusy).toEqual([5, 27.5, 90, 80]);
    expect(m.h.oom).toEqual([3]);
    expect(m.c["p/web"]!.restarts).toEqual([3]);
  });

  it("sem registros: null; célula estragada (sem peso) é ignorada; só estragadas: a métrica some", () => {
    expect(mergeAggregates([], 0)).toBeNull();
    const ok = hour(0, 10, [1, 2, 3, 10]);
    const bad = hour(3600, 10, [1, 2, 3, 0]);
    expect(mergeAggregates([ok, bad], 0)!.h.cpuBusy).toEqual([1, 2, 3, 10]);
    expect(mergeAggregates([bad], 0)!.h).toEqual({});
    const short = hour(0, 1, [1, 2]);
    expect(mergeAggregates([short], 0)!.h).toEqual({});
    expect(mergeAggregates([{ t: 0, n: 1, h: { desconhecida: [1, 1, 1, 1] }, c: {} }], 0)!.h).toEqual({});
    expect(mergeAggregates([{ t: 0, n: 1, h: {}, c: { x: { desconhecida: [1, 1, 1, 1] } } }], 0)!.c).toEqual({});
  });
});

describe("pontos e baldes", () => {
  it("cellPoint: gauge usa média, pico e n; evento usa a soma; estragada é null", () => {
    expect(cellPoint(5, [1, 2, 3, 4], "gauge")).toEqual({ t: 5, v: 2, max: 3, w: 4 });
    expect(cellPoint(5, [7], "event")).toEqual({ t: 5, v: 7, max: 7, w: 1 });
    expect(cellPoint(5, undefined, "gauge")).toBeNull();
    expect(cellPoint(5, [1, 2, 3, 0], "gauge")).toBeNull();
    expect(cellPoint(5, [1, 2, 3], "gauge")).toBeNull();
    expect(cellPoint(5, [1, Number.NaN, 3, 1], "gauge")).toBeNull();
    expect(cellPoint(5, [], "event")).toBeNull();
    expect(cellPoint(5, ["x" as unknown as number], "event")).toBeNull();
    expect(cellPoint(5, "x" as unknown as number[], "gauge")).toBeNull();
  });

  it("bucketize gauge: média ponderada e pico por balde; lacunas ficam fora", () => {
    const pts = [samplePoint(0, 10), samplePoint(60, 30), { t: 300, v: 50, max: 90, w: 3 }, { t: 340, v: 10, max: 20, w: 1 }, samplePoint(1000, 5)];
    expect(bucketize(pts, "gauge", 0, 300)).toEqual([
      { t: 0, v: 20, max: 30 },
      { t: 300, v: 40, max: 90 },
      { t: 900, v: 5, max: 5 },
    ]);
  });

  it("bucketize evento: soma; pontos antes do início são descartados; baldes em ordem", () => {
    const pts = [samplePoint(700, 1), samplePoint(-5, 9), samplePoint(10, 2), samplePoint(20, 3)];
    expect(bucketize(pts, "event", 0, 600)).toEqual([
      { t: 0, v: 5, max: 5 },
      { t: 600, v: 1, max: 1 },
    ]);
    expect(bucketize([], "gauge", 0, 60)).toEqual([]);
  });
});

describe("chooseResolution", () => {
  const r = METRICS_RETENTION_DEFAULT;
  it("1 h, 6 h e 24 h usam o dado por minuto; 7 d, 30 d e 90 d, o por hora; 1 ano, o por dia", () => {
    expect(chooseResolution("1h", r).resolution).toBe("minute");
    expect(chooseResolution("6h", r).resolution).toBe("minute");
    expect(chooseResolution("24h", r).resolution).toBe("minute");
    expect(chooseResolution("7d", r).resolution).toBe("hour");
    expect(chooseResolution("30d", r).resolution).toBe("hour");
    expect(chooseResolution("90d", r).resolution).toBe("hour");
    expect(chooseResolution("1y", r).resolution).toBe("day");
  });

  it("retenção por minuto menor que a janela empurra para hora; por hora menor, para dia", () => {
    expect(chooseResolution("24h", { ...r, minuteHours: 24 }).resolution).toBe("minute");
    expect(chooseResolution("24h", { minuteHours: 24, hourDays: 7, dayDays: 90 }).resolution).toBe("minute");
    expect(chooseResolution("30d", { minuteHours: 24, hourDays: 7, dayDays: 90 }).resolution).toBe("day");
    expect(chooseResolution("7d", { minuteHours: 24, hourDays: 7, dayDays: 90 }).resolution).toBe("hour");
  });

  it("nunca passa do máximo de pontos e o passo é múltiplo do passo guardado", () => {
    for (const range of METRICS_RANGES) {
      const c = chooseResolution(range, r);
      expect(c.step % c.baseStep).toBe(0);
      expect(c.step).toBeGreaterThanOrEqual(c.baseStep);
      const secs = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "90d": 7776000, "1y": 31536000 }[range];
      expect(secs / c.step).toBeLessThanOrEqual(METRICS_MAX_POINTS);
    }
    expect(chooseResolution("1h", r)).toEqual({ resolution: "minute", baseStep: 60, step: 60 });
    expect(chooseResolution("24h", r).step).toBe(240);
    expect(chooseResolution("7d", r)).toEqual({ resolution: "hour", baseStep: 3600, step: 3600 });
  });
});

describe("projeção do disco", () => {
  /** Disco crescendo `slope` %/dia a partir de `start`, um ponto por hora. */
  function growing(days: number, start: number, slope: number, noise = 0): Array<{ t: number; pct: number }> {
    const out: Array<{ t: number; pct: number }> = [];
    for (let h = 0; h <= days * 24; h++) out.push({ t: h * HOUR, pct: start + (slope * h) / 24 + (h % 2 === 0 ? noise : -noise) });
    return out;
  }

  it("crescimento limpo de 1 %/dia a 60 %: encher em ~40 dias, faixa estreita", () => {
    const r = projectDaysToFull(growing(10, 50, 1))!;
    // último ponto = 60 %, faltam 40 %
    expect(r.low).toBe(40);
    expect(r.high).toBe(40);
  });

  it("com ruído a faixa abre: low ≤ ~40 ≤ high", () => {
    const r = projectDaysToFull(growing(14, 40, 1, 3))!;
    expect(r.low).toBeLessThanOrEqual(r.high);
    expect(r.low).toBeLessThan(r.high);
    expect(r.low).toBeGreaterThan(5);
    expect(r.high).toBeLessThanOrEqual(PROJECTION_MAX_DAYS);
  });

  it("menos de 7 dias de dados, poucos pontos ou disco estável/diminuindo: null", () => {
    expect(projectDaysToFull(growing(5, 50, 1))).toBeNull();
    expect(projectDaysToFull(growing(10, 50, 1).filter((_, i) => i % 24 === 0).slice(0, 8))).toBeNull(); // 8 pontos
    expect(projectDaysToFull(growing(10, 50, 0))).toBeNull();
    expect(projectDaysToFull(growing(10, 80, -1))).toBeNull();
    expect(projectDaysToFull(growing(10, 50, 0.005))).toBeNull();
    expect(projectDaysToFull([])).toBeNull();
  });

  it("crescimento lentíssimo (passaria de 10 anos): null", () => {
    expect(projectDaysToFull(growing(30, 10, 0.02))).toBeNull();
  });

  it("já em 100 %: 0 a 0; pontos inválidos são ignorados; todos no mesmo instante: null", () => {
    const full = growing(10, 90, 1).map((p) => ({ ...p, pct: Math.min(100, p.pct) }));
    expect(projectDaysToFull(full)).toEqual({ low: 0, high: 0 });
    const withJunk = [...growing(10, 50, 1), { t: Number.NaN, pct: 1 }, { t: 1, pct: Number.NaN }];
    expect(projectDaysToFull(withJunk)).not.toBeNull();
    expect(projectDaysToFull(Array.from({ length: 30 }, (_, i) => ({ t: 100, pct: i })))).toBeNull();
  });

  it("o último ponto é o de maior tempo, mesmo fora de ordem", () => {
    const pts = growing(10, 50, 1).reverse();
    expect(projectDaysToFull(pts)).toEqual({ low: 40, high: 40 });
  });
});

describe("periodStart", () => {
  it("alinha à hora e ao dia (UTC)", () => {
    expect(periodStart(3 * HOUR + 59, HOUR)).toBe(3 * HOUR);
    expect(periodStart(2 * DAY + 5, DAY)).toBe(2 * DAY);
  });
});
