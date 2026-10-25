/**
 * metrics-service.test.ts — a montagem das peças (retenção, armazenamento,
 * coletor, consultas, alertas), com tudo injetado: nenhum /proc, nenhum Docker.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT } from "@paas/core";
import { DEFAULT_METRICS_CONFIG, createMetricsService } from "../src/services/metrics-service.js";
import * as F from "./fixtures/metrics-proc.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-metrics-service-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const files: Record<string, string> = {
  "/host/proc/stat": F.PROC_STAT,
  "/host/proc/meminfo": F.MEMINFO,
  "/host/proc/vmstat": F.VMSTAT,
  "/host/proc/loadavg": F.LOADAVG,
  "/host/proc/uptime": F.UPTIME,
  "/host/proc/pressure/memory": "some avg10=0 avg60=45.00 avg300=0 total=0\n",
  "/host/sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
};
const statfs = async () => ({ blocks: 100, bsize: 4096, bavail: 40, files: 100, ffree: 90 });

function make(over: Partial<Parameters<typeof createMetricsService>[0]> = {}) {
  const create = vi.fn(async () => ({ alert: { id: "al-1" }, created: true }));
  const setStatus = vi.fn(async () => undefined);
  const logs: string[] = [];
  let ms = Date.UTC(2026, 9, 24, 12);
  const svc = createMetricsService({
    dataDir: dir,
    dockerSocketPath: "/nonexistent.sock",
    alerts: { create, setStatus },
    log: (m) => logs.push(m),
    read: async (f) => files[f] ?? null,
    statfs,
    now: () => ms,
    clock: () => ms,
    docker: { list: async () => [], inspect: async () => null, reader: { refresh: async () => true, read: async () => ({ raw: null, via: "none" }), retain: () => undefined } },
    ...over,
  });
  return { svc, create, setStatus, logs, advance: (s: number) => (ms += s * 1000) };
}

describe("createMetricsService", () => {
  it("monta tudo com a retenção padrão e uma coleta grava no disco e aparece nas consultas", async () => {
    const m = make();
    const svc = await m.svc;
    expect(svc.enabled).toBe(true);
    expect(svc.settings.current()).toEqual(METRICS_RETENTION_DEFAULT);
    await svc.collector.tick();
    expect(svc.collector.status()).toMatchObject({ mode: "full", hostSource: "mounted" });
    const day = new Date(Date.UTC(2026, 9, 24)).toISOString().slice(0, 10);
    expect((await readFile(path.join(dir, "metrics-min", `${day}.jsonl`), "utf8")).trim().split("\n")).toHaveLength(1);
    const host = await svc.query.host("1h");
    expect(host.series.memUsedPct).toBeDefined();
    expect(host.latest!.values.memTotal).toBe(8131364 * 1024);
  });

  it("retenção escolhida antes vale na subida", async () => {
    const first = await make().svc;
    await first.settings.set({ minuteHours: 72, hourDays: 30, dayDays: 365 });
    const second = await make().svc;
    expect(second.settings.current().minuteHours).toBe(72);
    expect(second.collector.status().retention.hourDays).toBe(30);
  });

  it("pressão de memória sustentada vira alerta na central, com origem 'resources'", async () => {
    const m = make();
    const svc = await m.svc;
    for (let i = 0; i < 6; i++) {
      await svc.collector.tick();
      m.advance(60);
    }
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ source: "resources", severity: "critical", title: "Memória da VPS apertada" }));
    // volta ao normal: o alerta é encerrado pela central
    files["/host/proc/pressure/memory"] = "some avg10=0 avg60=1.00 avg300=0 total=0\n";
    for (let i = 0; i < 20; i++) {
      await svc.collector.tick();
      m.advance(60);
    }
    expect(m.setStatus).toHaveBeenCalledWith("al-1", "resolved");
    files["/host/proc/pressure/memory"] = "some avg10=0 avg60=45.00 avg300=0 total=0\n";
  });

  it("desligado (PAAS_METRICS=off): start() não agenda nada; stop() é seguro", async () => {
    vi.useFakeTimers();
    try {
      const svc = await make({ config: { ...DEFAULT_METRICS_CONFIG, enabled: false } }).svc;
      expect(svc.enabled).toBe(false);
      svc.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(svc.collector.status().lastTickAt).toBeNull();
      await svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ligado: start() agenda a coleta e stop() para e espera a volta em andamento", async () => {
    vi.useFakeTimers();
    try {
      const svc = await make().svc;
      svc.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await svc.collector.idle(); // a volta grava em disco de verdade
      expect(svc.collector.status().lastTickAt).not.toBeNull();
      await svc.stop();
      const at = svc.collector.status().lastTickAt;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(svc.collector.status().lastTickAt).toBe(at);
    } finally {
      vi.useRealTimers();
    }
  });

  it("depois de reiniciar o painel, o vigia adota o alerta de recursos que estava aberto (listOpen)", async () => {
    const listOpen = vi.fn(async () => [{ id: "velho", title: "Memória da VPS apertada" }]);
    const m = make({ alerts: { create: async () => ({ alert: { id: "novo" }, created: true }), setStatus: async () => undefined, listOpen } });
    const svc = await m.svc;
    await svc.collector.tick();
    expect(listOpen).toHaveBeenCalledTimes(1);
    expect(svc.watcher.activeKeys()).toEqual(["host:memory"]);
    await svc.stop();
  });

  it("sem configuração usa as montagens do compose (/host/proc e /host/sys/fs/cgroup)", () => {
    expect(DEFAULT_METRICS_CONFIG).toEqual({ enabled: true, hostProc: "/host/proc", hostCgroup: "/host/sys/fs/cgroup" });
  });

  it("padrões de produção: leitor de arquivos, statfs, Docker e relógios reais não quebram a montagem (sem /host/proc aqui: cai no do container)", async () => {
    const svc = await createMetricsService({
      dataDir: dir,
      dockerSocketPath: path.join(dir, "nao-existe.sock"),
      config: { enabled: true, hostProc: path.join(dir, "sem-proc"), hostCgroup: path.join(dir, "sem-cg") },
      alerts: { create: async () => ({ alert: { id: "x" }, created: true }), setStatus: async () => undefined },
      log: () => undefined,
    });
    await svc.collector.tick();
    const status = svc.collector.status();
    expect(["container", "none"]).toContain(status.hostSource);
    expect(status.containerSource).toBe("none");
    expect(status.lastError).not.toBeNull(); // sem Docker: motivo curto, sem lançar
    await svc.stop();
  });
});
