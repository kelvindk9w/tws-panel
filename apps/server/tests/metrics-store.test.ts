import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT, type MetricsRetention } from "@paas/core";
import { MAX_FILE_BYTES, MAX_FILE_LINES, MetricsStore, dayName, monthName, parseAggLine, parseSampleLine } from "../src/services/metrics-store.js";
import type { Sample } from "../src/services/metrics-series.js";

let dir: string;
let retention: MetricsRetention;
let logs: string[];
let store: MetricsStore;

/** 2026-10-20 00:00:00 UTC. */
const D0 = Date.UTC(2026, 9, 20) / 1000;
const HOUR = 3600;
const DAY = 86400;

const sample = (t: number, cpu: number, extra: Partial<Sample> = {}): Sample => ({ t, h: { cpuBusy: cpu, oom: 0 }, c: { "p/web": { cpu: cpu * 2 } }, ...extra });
const make = () => new MetricsStore({ dataDir: dir, retention: () => retention, log: (m) => logs.push(m) });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-metrics-store-"));
  retention = { ...METRICS_RETENTION_DEFAULT };
  logs = [];
  store = make();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fillMinutes(from: number, minutes: number, cpu = 10): Promise<void> {
  for (let i = 0; i < minutes; i++) await store.appendSample(sample(from + i * 60, cpu + (i % 5)));
}

describe("nomes de período", () => {
  it("dia e mês em UTC", () => {
    expect(dayName(D0 + 23 * HOUR + 3599)).toBe("2026-10-20");
    expect(dayName(D0 - 1)).toBe("2026-10-19");
    expect(monthName(D0)).toBe("2026-10");
  });
});

describe("leitura das linhas (forma esperada, entrada hostil)", () => {
  it("amostra válida; lixo, JSON de outro tipo, t inválido, métrica não numérica", () => {
    expect(parseSampleLine('{"t":100,"h":{"cpuBusy":5,"x":"a","y":null},"c":{"p/web":{"cpu":1,"bad":"z"},"vazio":5}}')).toEqual({ t: 100, h: { cpuBusy: 5 }, c: { "p/web": { cpu: 1 } } });
    expect(parseSampleLine("não é json")).toBeNull();
    expect(parseSampleLine("[1,2]")).toBeNull();
    expect(parseSampleLine("null")).toBeNull();
    expect(parseSampleLine('{"t":-1,"h":{}}')).toBeNull();
    expect(parseSampleLine('{"t":1.5,"h":{}}')).toBeNull();
    expect(parseSampleLine('{"t":"1","h":{}}')).toBeNull();
    expect(parseSampleLine('{"t":1,"h":[1]}')).toBeNull();
    expect(parseSampleLine('{"t":1,"h":{},"c":[1]}')).toBeNull();
    expect(parseSampleLine('{"t":1}')).toEqual({ t: 1, h: {}, c: {} });
  });

  it("__proto__ e chaves enormes não entram; limites de métricas por chave e de chaves por linha", () => {
    const s = parseSampleLine('{"t":1,"h":{"__proto__":5,"cpuBusy":1},"c":{"__proto__":{"cpu":1},"' + "k".repeat(200) + '":{"cpu":1},"ok":{"cpu":2}}}')!;
    expect(Object.keys(s.h)).toEqual(["cpuBusy"]);
    expect(Object.keys(s.c)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).cpu).toBeUndefined();
    // "__proto__" com objeto dentro trocaria o protótipo do mapa e faria métricas 'aparecerem' sem existir
    expect(Object.getPrototypeOf(s.c)).toBe(Object.prototype);
    expect((s.c as Record<string, unknown>).cpu).toBeUndefined();
    const agg = parseAggLine('{"t":1,"n":1,"h":{},"c":{"__proto__":{"cpu":[1]},"ok":{"cpu":[1]}}}')!;
    expect(Object.getPrototypeOf(agg.c)).toBe(Object.prototype);
    expect((agg.c as Record<string, unknown>).cpu).toBeUndefined();
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, i]));
    expect(Object.keys(parseSampleLine(JSON.stringify({ t: 1, h: many, c: {} }))!.h)).toHaveLength(64);
    const keys = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`k${i}`, { cpu: 1 }]));
    expect(Object.keys(parseSampleLine(JSON.stringify({ t: 1, h: {}, c: keys }))!.c)).toHaveLength(600);
  });

  it("agregado válido; células estragadas somem; formas erradas viram null", () => {
    expect(parseAggLine('{"t":3600,"n":60,"h":{"cpuBusy":[1,2,3,60],"oom":[2],"ruim":[1,"a"],"longa":[1,2,3,4,5],"vazia":[]},"c":{"p":{"cpu":[1,2,3,4],"x":"y"},"q":5}}')).toEqual({
      t: 3600,
      n: 60,
      h: { cpuBusy: [1, 2, 3, 60], oom: [2] },
      c: { p: { cpu: [1, 2, 3, 4] } },
    });
    expect(parseAggLine("x")).toBeNull();
    expect(parseAggLine('{"t":1,"n":-1}')).toBeNull();
    expect(parseAggLine('{"t":1}')).toBeNull();
    expect(parseAggLine('{"t":1,"n":1,"h":5}')).toBeNull();
    expect(parseAggLine('{"t":1,"n":1,"c":[]}')).toBeNull();
    expect(parseAggLine('{"t":1.2,"n":1}')).toBeNull();
    expect(parseAggLine('{"t":1,"n":1,"h":{"__proto__":[1]},"c":{"__proto__":{"cpu":[1]}}}')).toEqual({ t: 1, n: 1, h: {}, c: {} });
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, [i]]));
    expect(Object.keys(parseAggLine(JSON.stringify({ t: 1, n: 1, h: many, c: {} }))!.h)).toHaveLength(64);
    const keys = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`k${i}`, { cpu: [1] }]));
    expect(Object.keys(parseAggLine(JSON.stringify({ t: 1, n: 1, h: {}, c: keys }))!.c)).toHaveLength(600);
  });
});

describe("leitura barata de faixas e do host", () => {
  it("lineTime lê o instante do começo da linha sem analisar o JSON; formato diferente = null", async () => {
    const { lineTime } = await import("../src/services/metrics-store.js");
    expect(lineTime('{"t":1760000000,"h":{},"c":{}}')).toBe(1760000000);
    expect(lineTime('{"t":5}')).toBe(5);
    expect(lineTime('{"t":}')).toBeNull();
    expect(lineTime('{"t":x}')).toBeNull();
    expect(lineTime(' {"t":5}')).toBeNull();
    expect(lineTime('{"h":{},"t":5}')).toBeNull();
    expect(lineTime('{"t":')).toBeNull();
    expect(lineTime('{"t":' + "9".repeat(30) + "}")).toBe(999999999999999); // lê no máximo 15 dígitos: fora de qualquer faixa real
    expect(lineTime("")).toBeNull();
  });

  it("host só: devolve instante e host, sem as séries de containers; linha fora do formato do gravador cai na análise completa", () => {
    const line = JSON.stringify({ t: 100, h: { cpuBusy: 5 }, c: { "p/web": { cpu: 1 } } });
    expect(parseSampleLine(line, true)).toEqual({ t: 100, h: { cpuBusy: 5 }, c: {} });
    expect(parseSampleLine(line, false)).toEqual({ t: 100, h: { cpuBusy: 5 }, c: { "p/web": { cpu: 1 } } });
    // sem a parte dos containers: a análise completa vale
    expect(parseSampleLine('{"t":100,"h":{"cpuBusy":5}}', true)).toEqual({ t: 100, h: { cpuBusy: 5 }, c: {} });
    // ',"c":' dentro de um texto estranho: o corte quebra, e a análise completa decide
    expect(parseSampleLine('{"t":100,"h":{"a":1},"x":",\\"c\\":","c":{}}', true)).toEqual({ t: 100, h: { a: 1 }, c: {} });
    // rasgada (queda de energia) já depois do host: o host inteiro ainda vale; rasgada dentro do host não vale
    expect(parseSampleLine('{"t":100,"h":{"cpuBusy":5},"c":{"p/w', true)).toEqual({ t: 100, h: { cpuBusy: 5 }, c: {} });
    expect(parseSampleLine('{"t":100,"h":{"cpuBu', true)).toBeNull();
  });

  it("readSamples pula, sem analisar, as linhas fora da faixa; hostOnly corta os containers", async () => {
    for (let i = 0; i < 100; i++) await store.appendSample(sample(D0 + i * 60, i));
    const parse = vi.spyOn(JSON, "parse");
    const got = await store.readSamples(D0 + 10 * 60, D0 + 12 * 60);
    expect(got.map((s) => s.h.cpuBusy)).toEqual([10, 11, 12]);
    expect(parse.mock.calls.length).toBeLessThan(10);
    parse.mockRestore();
    const hostOnly = await store.readSamples(D0, D0 + 60, true);
    expect(hostOnly.every((s) => Object.keys(s.c).length === 0)).toBe(true);
    expect(hostOnly).toHaveLength(2);
  });
});

describe("gravar e ler os minutos", () => {
  it("grava uma linha por amostra no arquivo do dia (UTC) e lê em ordem, só dentro da janela", async () => {
    await store.appendSample(sample(D0 + 120, 3));
    await store.appendSample(sample(D0 + 60, 2));
    await store.appendSample(sample(D0 + DAY + 60, 9)); // outro dia
    expect((await readdir(path.join(dir, "metrics-min"))).sort()).toEqual(["2026-10-20.jsonl", "2026-10-21.jsonl"]);
    expect((await store.readSamples(D0, D0 + DAY - 1)).map((s) => s.t)).toEqual([D0 + 60, D0 + 120]);
    expect((await store.readSamples(D0 + 100, D0 + DAY + 100)).map((s) => s.t)).toEqual([D0 + 120, D0 + DAY + 60]);
    expect(await store.readSamples(D0 + 5 * DAY, D0 + 6 * DAY)).toEqual([]);
  });

  it("arquivo 0600 numa pasta 0700", async () => {
    await store.appendSample(sample(D0, 1));
    const { stat } = await import("node:fs/promises");
    expect((await stat(path.join(dir, "metrics-min", "2026-10-20.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "metrics-min"))).mode & 0o777).toBe(0o700);
  });

  it("o mesmo instante gravado duas vezes conta uma vez (vale a última)", async () => {
    await store.appendSample(sample(D0, 1));
    await store.appendSample(sample(D0, 7));
    const got = await store.readSamples(D0, D0);
    expect(got).toHaveLength(1);
    expect(got[0]!.h.cpuBusy).toBe(7);
  });

  it("linha rasgada por queda de energia: some, as outras ficam, e a gravação seguinte começa em linha nova", async () => {
    await store.appendSample(sample(D0, 1));
    const file = path.join(dir, "metrics-min", "2026-10-20.jsonl");
    await appendFile(file, '{"t":' + String(D0 + 60) + ',"h":{"cpuBu'); // sem quebra de linha
    const fresh = make(); // processo novo depois da queda
    await fresh.appendSample(sample(D0 + 120, 3));
    expect((await fresh.readSamples(D0, D0 + 1000)).map((s) => s.t)).toEqual([D0, D0 + 120]);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("gravações simultâneas não se misturam", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.appendSample(sample(D0 + i * 60, i))));
    expect(await store.readSamples(D0, D0 + 3600)).toHaveLength(50);
  });

  it("arquivo grande demais: o dia não some, lê-se o fim (o mais recente) e o motivo vai ao log; pasta ausente lê como vazio", async () => {
    const small = new MetricsStore({ dataDir: dir, retention: () => retention, log: (m) => logs.push(m), maxFileBytes: 4000 });
    for (let i = 0; i < 120; i++) await small.appendSample(sample(D0 + i * 60, i));
    const got = await small.readSamples(D0, D0 + DAY - 1);
    expect(got.length).toBeGreaterThan(5);
    expect(got.length).toBeLessThan(120);
    expect(got.at(-1)!.t).toBe(D0 + 119 * 60); // o fim está lá
    expect(got.every((x) => x.h.cpuBusy === (x.t - D0) / 60)).toBe(true); // nenhuma linha cortada ao meio entrou
    expect(logs.join("\n")).toContain("2026-10-20.jsonl");
    expect(await make().readSamples(D0 + 9 * DAY, D0 + 9 * DAY + 10)).toEqual([]);
    expect(MAX_FILE_BYTES).toBeGreaterThan(0);
  });

  it("arquivo vazio de fato (esparso) e maior que o teto não derruba a leitura", async () => {
    await mkdir(path.join(dir, "metrics-min"), { recursive: true });
    const file = path.join(dir, "metrics-min", "2026-10-20.jsonl");
    await writeFile(file, "");
    await truncate(file, 10_000);
    const small = new MetricsStore({ dataDir: dir, retention: () => retention, maxFileBytes: 4000 });
    expect(await small.readSamples(D0, D0 + 100)).toEqual([]);
  });

  it("faixa recente de um dia grande: lê só o fim do arquivo, com o mesmo resultado de ler tudo", async () => {
    // ~40 mil bytes de linhas, bem mais que um bloco de leitura de trás para frente? usa muitos containers por linha
    const wide = (t: number, v: number): Sample => ({ t, h: { cpuBusy: v }, c: Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`p/s${k}`, { cpu: v, mem: 1000 + k }])) });
    for (let i = 0; i < 600; i++) await store.appendSample(wide(D0 + i * 60, i));
    const file = path.join(dir, "metrics-min", "2026-10-20.jsonl");
    expect((await readFile(file)).length).toBeGreaterThan(600 * 1024); // mais de dois blocos de 256 KiB
    const from = D0 + 590 * 60;
    const tail = await store.readSamples(from, D0 + DAY - 1, true);
    expect(tail.map((x) => x.t)).toEqual(Array.from({ length: 10 }, (_, k) => from + k * 60));
    expect(tail[0]!.h.cpuBusy).toBe(590);
    const mid = await store.readSamples(D0 + 150 * 60, D0 + 170 * 60);
    expect(mid).toHaveLength(21);
    expect(mid[0]!.c["p/s3"]!.mem).toBe(1003);
    // faixa que começa depois do último dado: vazio
    expect(await store.readSamples(D0 + 700 * 60, D0 + 800 * 60, true)).toEqual([]);
    // dia inteiro continua igual
    expect(await store.readSamples(D0, D0 + DAY - 1, true)).toHaveLength(600);
  });

  it("faixa recente: a linha rasgada no fim e o início cortado do bloco não entram", async () => {
    for (let i = 0; i < 30; i++) await store.appendSample(sample(D0 + i * 60, i));
    const file = path.join(dir, "metrics-min", "2026-10-20.jsonl");
    await appendFile(file, '{"t":' + String(D0 + 99 * 60) + ',"h":{"cpuBu');
    const got = await make().readSamples(D0 + 25 * 60, D0 + DAY - 1);
    expect(got.map((x) => x.t)).toEqual([25, 26, 27, 28, 29].map((i) => D0 + i * 60));
  });

  it("faixa recente num arquivo de uma linha só sem quebra: nada a ler", async () => {
    await mkdir(path.join(dir, "metrics-min"), { recursive: true });
    await writeFile(path.join(dir, "metrics-min", "2026-10-20.jsonl"), "x".repeat(300 * 1024));
    expect(await store.readSamples(D0 + 3600, D0 + DAY - 1)).toEqual([]);
  });

  it("arquivo com mais linhas que o teto só tem as primeiras analisadas", async () => {
    await mkdir(path.join(dir, "metrics-min"), { recursive: true });
    const lines = Array.from({ length: MAX_FILE_LINES + 500 }, (_, i) => JSON.stringify({ t: D0 + i, h: {}, c: {} }));
    await writeFile(path.join(dir, "metrics-min", "2026-10-20.jsonl"), lines.join("\n") + "\n\n\n");
    const got = await store.readSamples(D0, D0 + MAX_FILE_LINES + 1000);
    expect(got).toHaveLength(MAX_FILE_LINES);
  });

  it("caminho que é pasta no lugar do arquivo não derruba a leitura", async () => {
    await mkdir(path.join(dir, "metrics-min", "2026-10-20.jsonl"), { recursive: true });
    expect(await store.readSamples(D0, D0 + 100)).toEqual([]);
  });
});

describe("rollup: minuto → hora → dia", () => {
  it("a hora só fecha 1 minuto depois de terminar; o agregado tem min/média/máx/n e os containers", async () => {
    await fillMinutes(D0, 60, 10); // 00:00–00:59
    await store.rollup(D0 + HOUR + 30); // 30 s depois do fim: ainda não
    expect(await store.readAggregates("hour", D0, D0 + DAY)).toEqual([]);
    await store.rollup(D0 + HOUR + 60);
    const hours = await store.readAggregates("hour", D0, D0 + DAY);
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ t: D0, n: 60 });
    expect(hours[0]!.h.cpuBusy).toEqual([10, 12, 14, 60]);
    expect(hours[0]!.c["p/web"]!.cpu).toEqual([20, 24, 28, 60]);
    expect(hours[0]!.h.oom).toEqual([0]);
  });

  it("repetir o rollup (e reiniciar o processo) não grava a hora de novo", async () => {
    await fillMinutes(D0, 120);
    await store.rollup(D0 + 2 * HOUR + 120);
    await store.rollup(D0 + 2 * HOUR + 180);
    await make().rollup(D0 + 2 * HOUR + 240);
    const lines = (await readFile(path.join(dir, "metrics", "hour", "2026-10-20.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("hora sem nenhuma amostra (lacuna) não gera registro e não é relida a cada minuto", async () => {
    await fillMinutes(D0, 60); // hora 0
    await fillMinutes(D0 + 3 * HOUR, 60); // hora 3; horas 1 e 2 sem nada
    await store.rollup(D0 + 4 * HOUR + 120);
    expect((await store.readAggregates("hour", D0, D0 + DAY)).map((r) => r.t)).toEqual([D0, D0 + 3 * HOUR]);
    const before = await readFile(path.join(dir, "metrics", "hour", "2026-10-20.jsonl"), "utf8");
    await store.rollup(D0 + 4 * HOUR + 180);
    expect(await readFile(path.join(dir, "metrics", "hour", "2026-10-20.jsonl"), "utf8")).toBe(before);
  });

  it("sem nenhuma amostra gravada: nada acontece e nada é criado", async () => {
    await store.rollup(D0 + DAY);
    expect(await readdir(dir)).toEqual([]);
  });

  it("depois de uma parada longa, termina aos poucos (maxPeriods) e continua na chamada seguinte", async () => {
    await fillMinutes(D0, 5 * 60);
    await store.rollup(D0 + 6 * HOUR, 2);
    expect((await store.readAggregates("hour", D0, D0 + DAY)).map((r) => r.t)).toEqual([D0, D0 + HOUR]);
    await store.rollup(D0 + 6 * HOUR, 10);
    expect(await store.readAggregates("hour", D0, D0 + DAY)).toHaveLength(5);
  });

  it("o dia fecha depois das 24 horas: junta as horas (média ponderada, soma dos eventos)", async () => {
    for (let h = 0; h < 24; h++) {
      await store.appendSample({ t: D0 + h * HOUR, h: { cpuBusy: h < 12 ? 10 : 30, oom: h === 5 ? 2 : 0 }, c: { "p/web": { restarts: h === 7 ? 1 : 0 } } });
    }
    await store.rollup(D0 + DAY + 30); // as horas fecham, o dia ainda não (folga)
    expect(await store.readAggregates("day", D0, D0 + DAY)).toEqual([]);
    await store.rollup(D0 + DAY + 60);
    const days = await store.readAggregates("day", D0, D0 + DAY);
    expect(days).toHaveLength(1);
    expect(days[0]!.t).toBe(D0);
    expect(days[0]!.n).toBe(24);
    expect(days[0]!.h.cpuBusy).toEqual([10, 20, 30, 24]);
    expect(days[0]!.h.oom).toEqual([2]);
    expect(days[0]!.c["p/web"]!.restarts).toEqual([1]);
    expect((await readdir(path.join(dir, "metrics", "day")))).toEqual(["2026-10.jsonl"]);
  });

  it("o dia não fecha enquanto as horas dele ainda estão sendo fechadas (maxPeriods baixo)", async () => {
    for (let h = 0; h < 24; h++) await store.appendSample({ t: D0 + h * HOUR, h: { cpuBusy: 10 }, c: {} });
    await store.rollup(D0 + DAY + 3600, 10);
    expect(await store.readAggregates("day", D0, D0 + DAY)).toEqual([]);
    await store.rollup(D0 + DAY + 3600, 100);
    expect(await store.readAggregates("day", D0, D0 + DAY)).toHaveLength(1);
  });

  it("o dia lê o disco: um processo novo continua de onde parou, sem repetir", async () => {
    for (let h = 0; h < 24; h++) await store.appendSample({ t: D0 + h * HOUR, h: { cpuBusy: 10 }, c: {} });
    await store.rollup(D0 + DAY + 120);
    await make().rollup(D0 + DAY + 180);
    expect((await readFile(path.join(dir, "metrics", "day", "2026-10.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("só há horas no disco (por exemplo, voltaram de um backup): os dias são fechados a partir delas", async () => {
    const hourFile = path.join(dir, "metrics", "hour", "2026-10-18.jsonl");
    await mkdir(path.dirname(hourFile), { recursive: true });
    const lines = Array.from({ length: 24 }, (_, h) => JSON.stringify({ t: D0 - 2 * DAY + h * HOUR, n: 60, h: { cpuBusy: [10, 20, 30, 60] }, c: {} }));
    await writeFile(hourFile, lines.join("\n") + "\n");
    await store.rollup(D0 + 12 * HOUR);
    const days = await store.readAggregates("day", D0 - 3 * DAY, D0 + DAY);
    expect(days.map((d) => d.t)).toEqual([D0 - 2 * DAY]); // o dia seguinte não tem hora nenhuma: não gera registro
    expect(days[0]).toMatchObject({ t: D0 - 2 * DAY, n: 24 * 60 });
    expect(days[0]!.h.cpuBusy).toEqual([10, 20, 30, 24 * 60]);
  });

  it("sem horas nem minutos em lugar nenhum: nada a fechar (pastas ausentes e fora da janela)", async () => {
    await mkdir(path.join(dir, "metrics", "hour"), { recursive: true });
    await writeFile(path.join(dir, "metrics", "hour", "2020-01-01.jsonl"), "{}\n"); // fora da janela de 90 dias
    await store.rollup(D0 + DAY);
    expect(await readdir(path.join(dir, "metrics"))).toEqual(["hour"]);
  });

  it("as horas mais velhas que a retenção do minuto não são buscadas", async () => {
    await fillMinutes(D0, 60);
    retention = { ...retention, minuteHours: 24 };
    await store.rollup(D0 + 5 * DAY);
    expect(await store.readAggregates("hour", D0, D0 + DAY)).toEqual([]);
  });
});

describe("poda pelo nome do arquivo", () => {
  async function touch(sub: string, name: string) {
    await mkdir(path.join(dir, sub), { recursive: true });
    await writeFile(path.join(dir, sub, name), "{}\n");
  }

  it("minuto: apaga o dia inteiramente fora das 48 h; o dia que ainda tem hora dentro da retenção fica", async () => {
    await touch("metrics-min", "2026-10-17.jsonl");
    await touch("metrics-min", "2026-10-18.jsonl");
    await touch("metrics-min", "2026-10-19.jsonl");
    // agora = 2026-10-20 12:00; corte = 2026-10-18 12:00 → 17 e 18? o 18 termina 10-19 00:00 > corte: fica
    const removed = await store.prune(D0 + 12 * HOUR);
    expect(removed).toBe(1);
    expect((await readdir(path.join(dir, "metrics-min"))).sort()).toEqual(["2026-10-18.jsonl", "2026-10-19.jsonl"]);
  });

  it("hora: 90 dias; dia: 730 dias, por mês inteiro; respeita a retenção escolhida", async () => {
    const old = (days: number) => dayName(D0 - days * DAY) + ".jsonl";
    await touch("metrics/hour", old(91));
    await touch("metrics/hour", old(89));
    await touch("metrics/day", "2024-01.jsonl");
    await touch("metrics/day", "2024-09.jsonl"); // termina em 2024-10-01, antes do corte (2024-10-20)
    await touch("metrics/day", "2024-10.jsonl"); // termina em 2024-11-01: ainda tem dia dentro
    await touch("metrics/day", "2025-06.jsonl");
    expect(await store.prune(D0)).toBe(3);
    expect(await readdir(path.join(dir, "metrics/hour"))).toEqual([old(89)]);
    expect((await readdir(path.join(dir, "metrics/day"))).sort()).toEqual(["2024-10.jsonl", "2025-06.jsonl"]);
    retention = { minuteHours: 24, hourDays: 7, dayDays: 90 };
    await touch("metrics/hour", old(10));
    expect(await store.prune(D0)).toBe(4); // as duas horas e os dois meses
    expect(await readdir(path.join(dir, "metrics/day"))).toEqual([]);
  });

  it("não toca em arquivo que não é de período (temporário, outra coisa), nem em data impossível", async () => {
    await touch("metrics-min", "2026-10-01.jsonl.tmp");
    await touch("metrics-min", "notas.txt");
    await touch("metrics-min", "2026-13-45.jsonl");
    await touch("metrics-min", "2026-10-17.jsonl.corrompido");
    expect(await store.prune(D0 + 30 * DAY)).toBe(0);
    expect(await readdir(path.join(dir, "metrics-min"))).toHaveLength(4);
  });

  it("pastas que não existem não são erro", async () => {
    expect(await store.prune(D0)).toBe(0);
  });
});

describe("uso de disco", () => {
  it("soma o tamanho dos arquivos de período por resolução; ignora o resto", async () => {
    expect(await store.usage()).toEqual({ minuteBytes: 0, hourBytes: 0, dayBytes: 0 });
    await mkdir(path.join(dir, "metrics-min"), { recursive: true });
    await mkdir(path.join(dir, "metrics/hour"), { recursive: true });
    await mkdir(path.join(dir, "metrics/day"), { recursive: true });
    await writeFile(path.join(dir, "metrics-min", "2026-10-20.jsonl"), "x".repeat(100));
    await writeFile(path.join(dir, "metrics-min", "2026-10-21.jsonl"), "x".repeat(50));
    await writeFile(path.join(dir, "metrics-min", "outro.txt"), "x".repeat(999));
    await writeFile(path.join(dir, "metrics/hour", "2026-10-20.jsonl"), "x".repeat(10));
    await writeFile(path.join(dir, "metrics/day", "2026-10.jsonl"), "x".repeat(7));
    expect(await store.usage()).toEqual({ minuteBytes: 150, hourBytes: 10, dayBytes: 7 });
  });
});
