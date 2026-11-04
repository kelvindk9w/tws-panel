import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n/core";
import { formatBytes, formatPercent, niceMax, seriesSummary, seriesTotal, sparkGeometry } from "@/lib/metrics";

beforeEach(() => setLocale("pt-BR"));

describe("formatBytes", () => {
  it("escolhe a unidade e usa a vírgula do idioma", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(8131364 * 1024)).toBe("7,8 GB");
    expect(formatBytes(150 * 1024 ** 3)).toBe("150 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3 TB");
    expect(formatBytes(5000 * 1024 ** 5)).toMatch(/PB$/);
  });
  it("em inglês usa o ponto", () => {
    setLocale("en");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
  it("ausente, negativo ou inválido: null (nunca '0 B' inventado)", () => {
    for (const bad of [null, undefined, -1, Number.NaN, Infinity]) expect(formatBytes(bad as never)).toBeNull();
  });
});

describe("formatPercent", () => {
  it("uma casa abaixo de 10, inteiro daí para cima", () => {
    expect(formatPercent(0)).toBe("0");
    expect(formatPercent(2.54)).toBe("2,5");
    expect(formatPercent(9.99)).toBe("10");
    expect(formatPercent(23.4)).toBe("23");
    expect(formatPercent(100)).toBe("100");
    expect(formatPercent(null)).toBeNull();
    expect(formatPercent(undefined)).toBeNull();
    expect(formatPercent(Number.NaN)).toBeNull();
  });
});

describe("seriesSummary / seriesTotal", () => {
  const pts = [
    { t: 0, v: 10, max: 15 },
    { t: 60, v: 20, max: 40 },
    { t: 120, v: 30, max: 35 },
  ];
  it("último, média e pico (o pico é o maior 'max', não o maior valor médio)", () => {
    expect(seriesSummary(pts)).toEqual({ last: 30, avg: 20, peak: 40 });
  });
  it("vazia ou ausente: null; total de eventos soma", () => {
    expect(seriesSummary([])).toBeNull();
    expect(seriesSummary(undefined)).toBeNull();
    expect(seriesTotal(pts)).toBe(60);
    expect(seriesTotal(undefined)).toBe(0);
  });
});

describe("niceMax", () => {
  it("arredonda para cima para 1, 2 ou 5 vezes uma potência de 10", () => {
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.1)).toBe(2);
    expect(niceMax(2.1)).toBe(5);
    expect(niceMax(5.1)).toBe(10);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(0.03)).toBeCloseTo(0.05, 10);
  });
  it("zero, negativo e inválido: 1", () => {
    for (const bad of [0, -5, Number.NaN, Infinity]) expect(niceMax(bad)).toBe(1);
  });
});

describe("sparkGeometry", () => {
  const o = { width: 100, height: 40, from: 0, to: 600, step: 60 };

  it("mapeia tempo para x e valor para y (0 embaixo, teto em cima), com teto fixo", () => {
    const g = sparkGeometry([{ t: 0, v: 0, max: 0 }, { t: 300, v: 50, max: 50 }, { t: 600, v: 100, max: 100 }], { ...o, step: 300, max: 100 });
    expect(g.line).toBe("M0 40 L50 20 L100 0");
    expect(g.area).toBe("M0 40 L0 40 L50 20 L100 0 L100 40 Z");
    expect(g.last).toEqual({ x: 100, y: 0 });
    expect(g.max).toBe(100);
  });

  it("sem teto fixo, usa o maior valor arredondado (o pico conta, não só a média)", () => {
    const g = sparkGeometry([{ t: 0, v: 10, max: 37 }], o);
    expect(g.max).toBe(50);
  });

  it("lacuna maior que 2,5 passos quebra a linha em trechos; 2,5 passos exatos ainda liga", () => {
    const sep = sparkGeometry([{ t: 0, v: 10, max: 10 }, { t: 60, v: 10, max: 10 }, { t: 300, v: 10, max: 10 }], { ...o, max: 20 });
    expect(sep.line.match(/M/g)).toHaveLength(2);
    const joined = sparkGeometry([{ t: 0, v: 10, max: 10 }, { t: 150, v: 10, max: 10 }], { ...o, max: 20 });
    expect(joined.line.match(/M/g)).toHaveLength(1);
    expect(sep.last).toEqual({ x: 50, y: 20 });
  });

  it("valores fora da escala são presos às bordas; valor inválido é ignorado; tempo fora da janela é preso", () => {
    const g = sparkGeometry([{ t: -100, v: -5, max: -5 }, { t: 60, v: Number.NaN, max: 1 }, { t: 9999, v: 500, max: 500 }], { ...o, max: 100 });
    expect(g.line).toBe("M0 40 M100 0");
  });

  it("série vazia: caminhos vazios, sem último ponto", () => {
    expect(sparkGeometry([], o)).toEqual({ line: "", area: "", last: null, max: 1 });
  });

  it("escala com mínimo diferente de zero", () => {
    const g = sparkGeometry([{ t: 0, v: 90, max: 90 }, { t: 600, v: 100, max: 100 }], { ...o, step: 600, min: 80, max: 100 });
    expect(g.line).toBe("M0 20 L100 0");
  });

  it("janela de tempo de duração zero não divide por zero", () => {
    const g = sparkGeometry([{ t: 5, v: 1, max: 1 }], { ...o, from: 5, to: 5, max: 2 });
    expect(g.line).toBe("M0 20");
  });
});
