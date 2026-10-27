import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT, type MetricsCollectorStatus } from "@paas/core";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { CACHE_MAX_ENTRIES, CACHE_TTL_MS, MAX_QUEUE, MAX_READS, MetricsBusyError, MetricsQuery } from "../src/services/metrics-query.js";
import { MetricsStore } from "../src/services/metrics-store.js";
import type { Sample } from "../src/services/metrics-series.js";

const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86400;

let dir: string;
let store: MetricsStore;
let retentionRef = METRICS_RETENTION_DEFAULT;
let clock: { ms: number };
let tick: TickResult | null;
let status: MetricsCollectorStatus;
let q: MetricsQuery;

const cstatus = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64),
  name: "paas-loja-web-1",
  slug: "loja",
  service: "web",
  managed: true,
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: null,
  exitCode: 0,
  oomKilled: false,
  restartsAt: [],
  oomAt: [],
  unhealthySince: null,
  ...over,
});

const protections = async () => ({ certificates: { total: 2, problems: 0 }, backups: { destinationConnected: true, lastFailure: false } });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-metrics-query-"));
  retentionRef = METRICS_RETENTION_DEFAULT;
  store = new MetricsStore({ dataDir: dir, retention: () => retentionRef });
  clock = { ms: NOW_MS };
  tick = null;
  status = { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: null, lastError: null, retention: METRICS_RETENTION_DEFAULT };
  q = new MetricsQuery({ store, collector: { status: () => status, latest: () => tick }, now: () => clock.ms });
});
afterEach(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function fill(from: number, minutes: number, make: (i: number) => Sample["h"], c: (i: number) => Sample["c"] = () => ({})) {
  for (let i = 0; i < minutes; i++) await store.appendSample({ t: from + i * 60, h: make(i), c: c(i) });
}

describe("host", () => {
  it("24 h: resolução de minuto, passo de 4 min, média e pico por balde; 'partial' quando a coleta é mais nova que a janela", async () => {
    await fill(NOW - 100 * 60, 100, (i) => ({ cpuBusy: i < 50 ? 10 : 30, memTotal: 1000, cores: 2 }));
    const r = await q.host("24h");
    expect(r).toMatchObject({ range: "24h", resolution: "minute", stepSeconds: 240, to: NOW });
    expect(r.partial).toBe(true);
    const cpu = r.series.cpuBusy!;
    expect(cpu.length).toBeGreaterThan(20);
    expect(cpu[0]).toMatchObject({ v: 10, max: 10 });
    expect(cpu.at(-1)).toMatchObject({ v: 30 });
    expect(cpu.every((p, i) => i === 0 || p.t > cpu[i - 1]!.t)).toBe(true);
    // métricas constantes ficam fora das séries
    expect("memTotal" in r.series).toBe(false);
    expect("cores" in r.series).toBe(false);
    // métrica que nunca foi medida não aparece (nada de série de zeros)
    expect("cpuSteal" in r.series).toBe(false);
  });

  it("24 h completo (dado desde o começo da janela) não é parcial", async () => {
    await fill(NOW - DAY, 1441, () => ({ cpuBusy: 5 }));
    expect((await q.host("24h")).partial).toBe(false);
  });

  it("sem nenhum dado: séries vazias, parcial, sem 'agora'", async () => {
    const r = await q.host("1h");
    expect(r.series).toEqual({});
    expect(r.partial).toBe(true);
    expect(r.latest).toBeNull();
  });

  it("'agora' vem da última volta do coletor", async () => {
    tick = { t: NOW, host: { cpuBusy: 12.5, memTotal: 100 }, containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    expect((await q.host("1h")).latest).toEqual({ t: NOW, values: { cpuBusy: 12.5, memTotal: 100 } });
  });

  it("7 dias usa os agregados de hora: média ponderada e pico; evento soma", async () => {
    retentionRef = { ...METRICS_RETENTION_DEFAULT, minuteHours: 168 };
    for (let d = 6; d >= 0; d--) {
      const start = Math.floor(NOW / DAY) * DAY - d * DAY;
      await fill(start, 120, (i) => ({ cpuBusy: i < 60 ? 10 : 20, oom: i === 5 ? 1 : 0 }));
    }
    await store.rollup(NOW);
    const r = await q.host("7d");
    expect(r.resolution).toBe("hour");
    expect(r.stepSeconds).toBe(HOUR);
    expect(r.series.cpuBusy![0]).toMatchObject({ v: 10, max: 10 });
    expect(r.series.cpuBusy![1]).toMatchObject({ v: 20, max: 20 });
    expect(r.series.oom!.reduce((s, p) => s + p.v, 0)).toBe(7);
  });

  it("1 ano usa os agregados de dia", async () => {
    for (let h = 0; h < 24; h++) await store.appendSample({ t: Math.floor(NOW / DAY) * DAY - 2 * DAY + h * HOUR, h: { cpuBusy: 40 }, c: {} });
    await store.rollup(NOW);
    const r = await q.host("1y");
    expect(r.resolution).toBe("day");
    expect(r.series.cpuBusy).toEqual([{ t: Math.floor(NOW / DAY) * DAY - 2 * DAY, v: 40, max: 40 }]);
  });

  it("agregado estragado no disco é pulado, o resto da série sai", async () => {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const start = Math.floor(NOW / DAY) * DAY - DAY;
    await mkdir(path.join(dir, "metrics", "hour"), { recursive: true });
    const file = path.join(dir, "metrics", "hour", `${new Date(start * 1000).toISOString().slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify({ t: start, n: 60, h: { cpuBusy: [1, 2, 3, 60] }, c: {} }) + "\n");
    await appendFile(file, JSON.stringify({ t: start + HOUR, n: 60, h: { cpuBusy: [1, 2, 3, 0] }, c: {} }) + "\n");
    await appendFile(file, "lixo\n");
    expect((await q.host("7d")).series.cpuBusy).toHaveLength(1);
  });
});

describe("projeto", () => {
  const cdata = (i: number): Sample["c"] => ({
    loja: { cpu: 30 + i, mem: 300, up: 2 },
    "loja/web": { cpu: 20 + i, mem: 200, up: 1, memLimit: 500, ...(i === 5 ? { restarts: 2 } : {}) },
    "loja/db": { cpu: 10, mem: 100, up: 1, ...(i === 8 ? { oom: 1 } : {}) },
    loja2: { cpu: 99, mem: 9999, up: 1 },
    "loja2/web": { cpu: 99, mem: 9999, up: 1 },
    "~/caddy": { cpu: 1, up: 1 },
  });

  it("soma do projeto e cada serviço; nunca mistura com 'loja2' (mesmo começo de nome) nem com containers de fora", async () => {
    await fill(NOW - 20 * 60, 20, () => ({}), cdata);
    const r = await q.project("loja", "1h");
    expect(r.total!.service).toBe("");
    expect(r.services.map((s) => s.service)).toEqual(["db", "web"]);
    expect(r.total!.series.cpu!.every((p) => p.v < 60)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("9999");
    expect(JSON.stringify(r)).not.toContain("caddy");
    expect("memLimit" in r.services[1]!.series).toBe(false);
  });

  it("eventos de reinício e morte por memória, do mais novo para o mais velho, por serviço, com horário", async () => {
    await fill(NOW - 20 * 60, 20, () => ({}), cdata);
    const r = await q.project("loja", "1h");
    expect(r.events).toEqual([
      { t: NOW - 20 * 60 + 8 * 60, service: "db", kind: "oom", count: 1 },
      { t: NOW - 20 * 60 + 5 * 60, service: "web", kind: "restart", count: 2 },
    ]);
  });

  it("'agora' de cada serviço vem da última volta; serviço sem dado na janela mas vivo aparece", async () => {
    tick = { t: NOW, host: {}, containers: [], sample: { t: NOW, h: {}, c: { loja: { cpu: 7, up: 1 }, "loja/novo": { mem: 5, up: 1, memLimit: 10 } } }, dockerOk: true };
    const r = await q.project("loja", "1h");
    expect(r.total!.latest).toEqual({ cpu: 7, up: 1 });
    expect(r.services[0]).toMatchObject({ service: "novo", latest: { mem: 5, up: 1, memLimit: 10 }, series: {} });
  });

  it("valores 'agora' que não são métricas conhecidas são ignorados", async () => {
    tick = { t: NOW, host: {}, containers: [], sample: { t: NOW, h: {}, c: { loja: { cpu: 7, lixo: 1, constructor: 5 } } }, dockerOk: true };
    expect((await q.project("loja", "1h")).total!.latest).toEqual({ cpu: 7 });
  });

  it("projeto sem nenhum dado: total null, sem serviços, parcial", async () => {
    const r = await q.project("nada", "24h");
    expect(r).toMatchObject({ total: null, services: [], events: [], partial: true });
  });

  it("7 dias lê as horas e traz os eventos de hora", async () => {
    retentionRef = { ...METRICS_RETENTION_DEFAULT, minuteHours: 168 };
    const start = Math.floor(NOW / DAY) * DAY - 2 * DAY;
    await fill(start, 120, () => ({}), cdata);
    await store.rollup(NOW);
    const r = await q.project("loja", "7d");
    expect(r.resolution).toBe("hour");
    expect(r.events.map((e) => e.kind).sort()).toEqual(["oom", "restart"]);
    expect(r.events.find((e) => e.kind === "restart")!.count).toBe(2);
  });

  it("no máximo 100 eventos", async () => {
    await fill(NOW - 200 * 60, 200, () => ({}), () => ({ "loja/web": { restarts: 1, up: 1 } }));
    expect((await q.project("loja", "6h")).events).toHaveLength(100);
  });
});

describe("cache, divisão de leituras e limites", () => {
  it("a mesma consulta dentro de 30 s não lê o disco de novo; depois do prazo lê", async () => {
    const spy = vi.spyOn(store, "readSamples");
    await q.host("1h");
    await q.host("1h");
    expect(spy).toHaveBeenCalledTimes(1);
    clock.ms += CACHE_TTL_MS - 1;
    await q.host("1h");
    expect(spy).toHaveBeenCalledTimes(1);
    clock.ms += 2;
    await q.host("1h");
    expect(spy).toHaveBeenCalledTimes(2);
    await q.host("6h"); // janela diferente = outra consulta
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("pedidos iguais ao mesmo tempo dividem uma leitura só", async () => {
    const spy = vi.spyOn(store, "readSamples");
    await Promise.all([q.host("1h"), q.host("1h"), q.host("1h")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falha de leitura não fica guardada", async () => {
    const spy = vi.spyOn(store, "readSamples").mockRejectedValueOnce(new Error("disco"));
    await expect(q.host("1h")).rejects.toThrow("disco");
    await expect(q.host("1h")).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("o cache tem tamanho máximo", async () => {
    const spy = vi.spyOn(store, "readSamples");
    for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) await q.project(`p${i}`, "1h");
    await q.project("p0", "1h"); // já foi expulso
    expect(spy).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 6);
  });

  it("no máximo 3 leituras de disco ao mesmo tempo; a fila é limitada (acima, MetricsBusyError)", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    vi.spyOn(store, "readSamples").mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      return [];
    });
    const results = Array.from({ length: MAX_READS + MAX_QUEUE + 3 }, (_, i) => q.project(`p${i}`, "1h").then(() => "ok", (e: unknown) => (e instanceof MetricsBusyError ? "busy" : "erro")));
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBe(MAX_READS);
    // libera em ondas até acabar
    for (let guard = 0; guard < 200 && releases.length > 0; guard++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 2));
    }
    const done = await Promise.all(results);
    expect(done.filter((x) => x === "busy")).toHaveLength(3);
    expect(done.filter((x) => x === "ok")).toHaveLength(MAX_READS + MAX_QUEUE);
    expect(peak).toBe(MAX_READS);
  });
});

describe("semáforo (summary)", () => {
  const host = (over: Record<string, number> = {}) => ({ cpuBusy: 20, cpuSteal: 0.5, psiCpu: 1, memTotal: 1000, memAvail: 600, memUsedPct: 40, swapUsed: 0, psiMem: 0, diskPct: 50, diskFree: 500, inodePct: 5, netRx: 100, netTx: 50, cores: 2, ...over });

  it("sem coleta nenhuma: tudo 'sem dados' (nunca verde por falta de dado)", async () => {
    const s = await q.summary({ protections: async () => ({ certificates: null, backups: null }), visible: null });
    expect([s.cpu.level, s.memory.level, s.disk.level, s.network.level, s.projects.level, s.protections.level]).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(s.cpu.busyPct).toBeNull();
    expect(s.memory.oomKills24h).toBe(0);
    expect(s.disk.daysToFull).toBeNull();
  });

  it("valores de agora, sparkline de 24 h em baldes de 15 min, níveis ok", async () => {
    await fill(NOW - 3 * HOUR, 180, () => host());
    tick = { t: NOW, host: host(), containers: [cstatus()], sample: { t: NOW, h: host(), c: {} }, dockerOk: true };
    const s = await q.summary({ protections, visible: null });
    expect(s.cpu).toMatchObject({ level: "ok", busyPct: 20, stealPct: 0.5, psi: 1, cores: 2 });
    expect(s.cpu.spark.length).toBeGreaterThan(10);
    expect(s.cpu.spark.length).toBeLessThanOrEqual(97);
    expect(s.memory).toMatchObject({ level: "ok", usedPct: 40, availBytes: 600, totalBytes: 1000, oomKills24h: 0 });
    expect(s.disk).toMatchObject({ level: "ok", usedPct: 50, freeBytes: 500, inodePct: 5, daysToFull: null });
    expect(s.network).toMatchObject({ level: "ok", rxBytesPerSecond: 100, txBytesPerSecond: 50 });
    expect(s.network.spark[0]!.v).toBe(150);
    expect(s.projects).toMatchObject({ level: "ok", running: 1, total: 1, problems: [], problemCount: 0 });
    expect(s.protections).toMatchObject({ level: "ok", certificates: { total: 2, problems: 0 } });
    expect(s.generatedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("disco cheio e steal alto acendem os selos certos", async () => {
    tick = { t: NOW, host: host({ diskPct: 93, cpuSteal: 12, memAvail: 30 }), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    const s = await q.summary({ protections, visible: null });
    expect(s.disk.level).toBe("critical");
    expect(s.cpu.level).toBe("critical");
    expect(s.memory.level).toBe("critical"); // 3% disponível
  });

  it("morte por falta de memória nas últimas 24 h deixa a memória crítica mesmo com tudo normal agora", async () => {
    await fill(NOW - 600, 10, (i) => host({ oom: i === 3 ? 2 : 0 }));
    tick = { t: NOW, host: host(), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    const s = await q.summary({ protections, visible: null });
    expect(s.memory.oomKills24h).toBe(2);
    expect(s.memory.level).toBe("critical");
  });

  it("depois de reiniciar o painel, antes da primeira volta, usa a última amostra gravada se for recente (< 5 min); velha, não", async () => {
    await fill(NOW - 120, 2, () => host());
    expect((await q.summary({ protections, visible: null })).cpu.busyPct).toBe(20);
    clock.ms += 10 * 60_000;
    q = new MetricsQuery({ store, collector: { status: () => status, latest: () => null }, now: () => clock.ms });
    expect((await q.summary({ protections, visible: null })).cpu.busyPct).toBeNull();
  });

  it("a janela de 24 h fica em memória: a segunda leitura (depois do cache de 30 s) busca só o que chegou depois e só o host", async () => {
    await fill(NOW - 3 * HOUR, 180, () => host());
    const lastBefore = NOW - 3 * HOUR + 179 * 60;
    const spy = vi.spyOn(store, "readSamples");
    const first = await q.summary({ protections, visible: null });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2]).toBe(true); // só o host
    clock.ms += 60_000;
    await store.appendSample({ t: NOW + 30, h: host({ cpuBusy: 90 }), c: {} });
    const second = await q.summary({ protections, visible: null });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toBe(lastBefore + 1);
    expect(spy.mock.calls[1]![2]).toBe(true);
    // a amostra nova entrou na miniatura sem reler o dia
    expect(second.cpu.spark.at(-1)!.max).toBe(90);
    expect(first.cpu.spark.at(-1)!.max).toBe(20);
  });

  it("janela em memória velha demais (coleta parada há mais de 10 min) é relida inteira; amostras com mais de 24 h saem", async () => {
    await fill(NOW - 3 * HOUR, 180, () => host());
    const spy = vi.spyOn(store, "readSamples");
    await q.summary({ protections, visible: null });
    clock.ms += 30 * 60_000;
    await q.summary({ protections, visible: null });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toBe(Math.floor((NOW + 30 * 60 - DAY) / 900) * 900);
  });

  it("projeção do disco: 30 dias de uso crescendo 1%/dia → faixa de dias e selo", async () => {
    const aggDir = path.join(dir, "metrics", "hour");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(aggDir, { recursive: true });
    for (let d = 14; d >= 0; d--) {
      const day = Math.floor(NOW / DAY) * DAY - d * DAY;
      const lines = Array.from({ length: 24 }, (_, h) => JSON.stringify({ t: day + h * HOUR, n: 60, h: { diskPct: [0, 80 + (14 - d) * 1 + h / 24, 0, 60] }, c: {} })).join("\n");
      await writeFile(path.join(aggDir, `${new Date(day * 1000).toISOString().slice(0, 10)}.jsonl`), lines + "\n");
    }
    tick = { t: NOW, host: host({ diskPct: 94 }), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    const s = await q.summary({ protections, visible: null });
    expect(s.disk.daysToFull).not.toBeNull();
    expect(s.disk.daysToFull!.low).toBeLessThanOrEqual(6);
  });

  it("projetos: só os do painel contam; mostra os que têm problema com o motivo; 'visible' esconde os de fora", async () => {
    tick = {
      t: NOW,
      host: host(),
      sample: { t: NOW, h: {}, c: {} },
      dockerOk: true,
      containers: [
        cstatus({ slug: "loja", service: "web", state: "restarting" }),
        cstatus({ id: "b".repeat(64), slug: "loja", service: "db" }),
        cstatus({ id: "c".repeat(64), slug: "blog", service: "app", health: "unhealthy" }),
        cstatus({ id: "d".repeat(64), slug: "parado", service: "x", state: "exited", exitCode: 0 }),
        cstatus({ id: "e".repeat(64), slug: null, managed: false, name: "redis", service: null, state: "restarting" }),
      ],
    };
    const all = await q.summary({ protections, visible: null });
    expect(all.projects).toMatchObject({ running: 2, total: 3, problemCount: 2, level: "critical" });
    expect(all.projects.problems).toEqual([
      { slug: "blog", services: ["app"], reasons: ["unhealthy"], level: "warning" },
      { slug: "loja", services: ["web"], reasons: ["restarting"], level: "critical" },
    ]);
    const mine = await q.summary({ protections, visible: new Set(["blog"]) });
    expect(mine.projects.problems.map((p) => p.slug)).toEqual(["blog"]);
    expect(mine.projects.level).toBe("warning");
    expect(mine.projects.problemCount).toBe(1); // a contagem vem da mesma lista filtrada, não da VPS inteira
    expect(JSON.stringify(mine.projects)).not.toContain("loja");
    const none = await q.summary({ protections, visible: new Set(["parado"]) });
    expect(none.projects.problems).toEqual([]);
    expect(none.projects.level).toBe("ok");
  });

  it("Docker fora do ar: projetos 'sem dados' (não 'tudo bem'), e o filtro continua sem dados", async () => {
    tick = { t: NOW, host: host(), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: false };
    expect((await q.summary({ protections, visible: null })).projects.level).toBe("unknown");
    expect((await q.summary({ protections, visible: new Set() })).projects.level).toBe("unknown");
  });

  it("falha ao consultar certificados e backups vira 'sem dados' só nesse indicador", async () => {
    tick = { t: NOW, host: host(), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    const s = await q.summary({ protections: async () => Promise.reject(new Error("x")), visible: null });
    expect(s.protections).toEqual({ level: "unknown", certificates: null, backups: null });
    expect(s.cpu.level).toBe("ok");
  });

  it("a projeção falhando não derruba o resto", async () => {
    tick = { t: NOW, host: host(), containers: [], sample: { t: NOW, h: {}, c: {} }, dockerOk: true };
    vi.spyOn(store, "readAggregates").mockRejectedValue(new Error("disco"));
    const s = await q.summary({ protections, visible: null });
    expect(s.disk.daysToFull).toBeNull();
    expect(s.disk.level).toBe("ok");
  });
});
