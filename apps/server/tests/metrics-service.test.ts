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
afterEach(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

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

  it("intenção do projeto e réplicas desejadas chegam ao vigia e ao coletor; sem elas tudo segue", async () => {
    const entry = { id: "a".repeat(64), name: "paas-loja-web-1", state: "exited", managed: true, projectSlug: "loja", service: "web" };
    const runtime = { state: "exited", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: 1, tty: false, pid: null };
    const docker = {
      list: async () => [entry],
      inspect: async () => runtime,
      reader: { refresh: async () => true, read: async () => ({ raw: null, via: "none" as const }), retain: () => undefined },
    };
    let intent: "stopped" | null = "stopped";
    const m = make({ docker, intent: () => intent, desired: async () => ({ web: 2 }) });
    const svc = await m.svc;
    expect(svc.startups.list("loja")).toEqual([]);
    for (let i = 0; i < 6; i++) {
      await svc.collector.tick();
      m.advance(60);
    }
    expect(m.create).not.toHaveBeenCalledWith(expect.objectContaining({ title: "loja/web parou de rodar" })); // parado pelo painel
    expect(svc.collector.latest()!.services).toEqual([{ slug: "loja", service: "web", running: 0, wanted: 2 }]);
    intent = null;
    for (let i = 0; i < 4; i++) {
      await svc.collector.tick();
      m.advance(60);
    }
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ title: "loja/web parou de rodar", source: "resources" }));
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

  describe("fonte dos eventos de morte por memória", () => {
    const CID = "e".repeat(64);
    const docker = {
      list: async () => [{ id: CID, name: "paas-loja-web-1", state: "running", managed: true, projectSlug: "loja", service: "web" }],
      inspect: async () => ({ state: "running", health: null, restartCount: 0, startedAt: "2026-10-24T10:00:00Z", finishedAt: null, exitCode: 0, tty: false, pid: 10, oomKilled: false }),
      reader: {
        refresh: async () => true,
        read: async () => ({ raw: { cpuUsec: 1, memWorkingBytes: 10, memLimitBytes: 1000, ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0, oomKills: 0 }, via: "cgroup" as const }),
        retain: () => undefined,
      },
    };
    const source = () => {
      const calls = { start: 0, stop: 0 };
      let pending: Array<{ id: string; timeNano: bigint }> = [{ id: CID, timeNano: 1n }];
      return { calls, src: { start: () => void calls.start++, stop: () => void calls.stop++, drain: () => pending.splice(0, pending.length) } };
    };

    it("o coletor recebe os eventos da fonte, ela liga com o serviço e desliga ao parar (se isto sumir da montagem, o OOM volta a ser invisível)", async () => {
      const { calls, src } = source();
      const m = make({ docker, oomSource: src });
      const svc = await m.svc;
      svc.start();
      expect(calls.start).toBe(1);
      svc.collector.stop(); // só a fonte interessa aqui; a volta é feita à mão
      await svc.collector.tick();
      expect(svc.collector.latest()!.sample.c["loja/web"]!.oom).toBe(1);
      expect(svc.collector.latest()!.containers[0]!.oomAt).toHaveLength(1);
      await svc.stop();
      expect(calls.stop).toBe(1);
    });

    it("PAAS_METRICS=off: nem a fonte de eventos liga", async () => {
      const { calls, src } = source();
      const svc = await createMetricsService({
        dataDir: dir,
        dockerSocketPath: "/nonexistent.sock",
        config: { enabled: false, hostProc: "/host/proc", hostCgroup: "/host/sys/fs/cgroup" },
        alerts: { create: async () => ({ alert: { id: "x" }, created: true }), setStatus: async () => undefined },
        log: () => undefined,
        oomSource: src,
      });
      svc.start();
      expect(calls.start).toBe(0);
      await svc.stop();
    });
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
