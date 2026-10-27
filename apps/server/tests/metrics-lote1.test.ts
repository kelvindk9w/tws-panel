import { describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT } from "@paas/core";
import { MetricsCollector, type CollectorDeps, type ContainerPort } from "../src/services/metrics-collector.js";
import { containerSample, sumContainerSamples, type ContainerRaw, type HostRaw } from "../src/services/metrics-compute.js";
import type { ContainerRuntime } from "../src/services/docker-logs.js";
import type { DockerEntry } from "../src/services/metrics-docker.js";
import { hasListeningSocket, parseCpuMax, parseLoadavg, parseMeminfo, parseProcStat, parseVmstat } from "../src/services/metrics-parse.js";
import { ContainerReader } from "../src/services/metrics-sources.js";
import type { Sample } from "../src/services/metrics-series.js";
import type { StartupObservation } from "../src/services/metrics-startup.js";
import * as F from "./fixtures/metrics-proc.js";

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const idOf = (n: number) => n.toString(16).padStart(64, "0");

describe("parse: cpu.max e sockets em LISTEN", () => {
  it("cpu.max vira % de um núcleo; sem limite ou ilegível é null", () => {
    expect(parseCpuMax("50000 100000\n")).toBe(50);
    expect(parseCpuMax("200000 100000\n")).toBe(200);
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseCpuMax("0 100000\n")).toBeNull();
    expect(parseCpuMax("50000\n")).toBeNull();
    expect(parseCpuMax("abc 100000\n")).toBeNull();
    expect(parseCpuMax("")).toBeNull();
  });
  it("hasListeningSocket: estado 0A (LISTEN) em qualquer linha depois do cabeçalho", () => {
    const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const listen = "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0 100 0 0 10 0\n";
    const estab = "   1: 0100007F:1F90 0100007F:D2A0 01 00000000:00000000 00:00000000 00000000     0        0 12346 1 0 100 0 0 10 0\n";
    expect(hasListeningSocket(head + estab + listen)).toBe(true);
    expect(hasListeningSocket(head + estab)).toBe(false);
    expect(hasListeningSocket(head)).toBe(false);
    expect(hasListeningSocket("")).toBe(false);
  });
});

describe("compute: throttling e limite de CPU", () => {
  const raw = (over: Partial<ContainerRaw> = {}): ContainerRaw => ({
    cpuUsec: 0,
    cpuPeriods: 100,
    cpuThrottled: 10,
    cpuLimitPct: 50,
    memWorkingBytes: 1,
    memLimitBytes: null,
    ioReadBytes: null,
    ioWriteBytes: null,
    netRxBytes: null,
    netTxBytes: null,
    oomKills: null,
    ...over,
  });
  it("throttling = parte dos períodos em que o limite segurou; limite vem do cpu.max", () => {
    const v = containerSample(raw(), raw({ cpuPeriods: 200, cpuThrottled: 35, cpuUsec: 30_000_000 }), 60, true);
    expect(v.cpuThrottle).toBe(25);
    expect(v.cpuLimit).toBe(50);
    expect(v.cpu).toBe(50);
  });
  it("sem períodos novos, sem leitura anterior ou contador que voltou: sem dado (nunca zero)", () => {
    expect(containerSample(raw(), raw(), 60, true).cpuThrottle).toBeUndefined();
    expect(containerSample(null, raw(), 60, true).cpuThrottle).toBeUndefined();
    expect(containerSample(raw(), raw({ cpuPeriods: 5, cpuThrottled: 1 }), 60, true).cpuThrottle).toBeUndefined();
    expect(containerSample(raw(), raw({ cpuPeriods: null, cpuThrottled: null, cpuLimitPct: null }), 60, true)).not.toHaveProperty("cpuLimit");
  });
  it("nunca passa de 100%", () => {
    expect(containerSample(raw({ cpuPeriods: 0, cpuThrottled: 0 }), raw({ cpuPeriods: 10, cpuThrottled: 50 }), 60, true).cpuThrottle).toBe(100);
  });
  it("soma de serviços: throttling é o pior; limite só se todos têm", () => {
    const a = { up: 1, cpu: 10, cpuThrottle: 20, cpuLimit: 50 };
    const b = { up: 1, cpu: 5, cpuThrottle: 70, cpuLimit: 100 };
    expect(sumContainerSamples([a, b])).toMatchObject({ cpu: 15, cpuThrottle: 70, cpuLimit: 150 });
    const total = sumContainerSamples([a, { up: 1, cpu: 1 }]);
    expect(total.cpuThrottle).toBe(20);
    expect(total).not.toHaveProperty("cpuLimit");
  });
});

describe("ContainerReader: throttling lido do cgroup e porta aberta", () => {
  const ID = idOf(7);
  const dir = `/host/sys/fs/cgroup/system.slice/docker-${ID}.scope`;
  const files = (cpuMax: string | null): Record<string, string> => ({
    "/host/sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
    [`${dir}/memory.current`]: "1000\n",
    [`${dir}/memory.max`]: "max\n",
    [`${dir}/cpu.stat`]: "usage_usec 500\nnr_periods 40\nnr_throttled 8\nthrottled_usec 1234\n",
    ...(cpuMax === null ? {} : { [`${dir}/cpu.max`]: cpuMax }),
  });
  const make = (f: Record<string, string>) => new ContainerReader({ cgroupRoot: "/host/sys/fs/cgroup", procRoot: "/host/proc", read: async (p) => f[p] ?? null, stats: async () => null });

  it("lê períodos, períodos segurados e o limite", async () => {
    const r = make(files("25000 100000\n"));
    await r.refresh();
    const { raw } = await r.read(ID, null, null);
    expect(raw).toMatchObject({ cpuUsec: 500, cpuPeriods: 40, cpuThrottled: 8, cpuLimitPct: 25 });
  });
  it("sem cpu.max ou 'max': limite nulo", async () => {
    for (const cpuMax of [null, "max 100000\n"]) {
      const r = make(files(cpuMax));
      await r.refresh();
      expect((await r.read(ID, null, null)).raw?.cpuLimitPct).toBeNull();
    }
  });
  it("listening: tcp ou tcp6, e null sem PID ou sem a montagem", async () => {
    const head = "  sl  local_address rem_address   st\n";
    const listen = "   0: 00000000:1F90 00000000:0000 0A 0\n";
    const r4 = make({ "/host/proc/10/net/tcp": head + listen, "/host/proc/10/net/tcp6": head });
    const r6 = make({ "/host/proc/11/net/tcp": head, "/host/proc/11/net/tcp6": head + listen });
    const closed = make({ "/host/proc/12/net/tcp": head });
    expect(await r4.listening(10)).toBe(true);
    expect(await r6.listening(11)).toBe(true);
    expect(await closed.listening(12)).toBe(false);
    expect(await closed.listening(99)).toBeNull();
    expect(await closed.listening(null)).toBeNull();
    expect(await closed.listening(-3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coletor: réplicas e tempo de subida
// ---------------------------------------------------------------------------

const hostRaw = (): HostRaw => ({
  cpu: parseProcStat(F.PROC_STAT).cpu,
  cores: 2,
  load: parseLoadavg(F.LOADAVG),
  mem: parseMeminfo(F.MEMINFO),
  vm: parseVmstat(F.VMSTAT),
  psi: { cpu: 1, mem: 0, io: null },
  disks: null,
  net: null,
  uptime: 100,
  fs: { totalBytes: 100, freeBytes: 50, inodePct: 5 },
});

const rt = (over: Partial<ContainerRuntime> = {}): ContainerRuntime => ({
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: "2026-10-24T10:00:00Z",
  finishedAt: null,
  exitCode: 0,
  tty: false,
  pid: 1234,
  oomKilled: false,
  restartPolicy: "always",
  ...over,
});

function harness(entries: DockerEntry[], runtimeOf: (e: DockerEntry) => ContainerRuntime | null, memOf: (e: DockerEntry) => { mem: number; limit: number | null } = () => ({ mem: 1000, limit: null }), over: Partial<CollectorDeps> = {}) {
  const appended: Sample[] = [];
  const now = { ms: T0 };
  const reader: ContainerPort = {
    refresh: async () => true,
    read: async (id) => {
      const e = entries.find((x) => x.id === id)!;
      const m = memOf(e);
      return { raw: { cpuUsec: 1_000_000, memWorkingBytes: m.mem, memLimitBytes: m.limit, ioReadBytes: 0, ioWriteBytes: 0, netRxBytes: 0, netTxBytes: 0, oomKills: 0 }, via: "cgroup" };
    },
    retain: () => undefined,
  };
  const deps: CollectorDeps = {
    store: { appendSample: vi.fn(async (s: Sample) => void appended.push(s)), rollup: vi.fn(async () => undefined), prune: vi.fn(async () => 0) },
    retention: () => METRICS_RETENTION_DEFAULT,
    host: { read: async () => ({ raw: hostRaw(), source: "mounted" as const }) },
    docker: { list: async () => entries, inspect: async (id) => rt0(entries.find((x) => x.id === id)!), reader },
    now: () => now.ms,
    clock: () => now.ms,
    log: () => undefined,
    ...over,
  };
  const rt0 = (e: DockerEntry) => runtimeOf(e);
  return { c: new MetricsCollector(deps), appended, now, reader };
}

const web = (n: number, over: Partial<DockerEntry> = {}): DockerEntry => ({ id: idOf(n), name: `paas-loja-web-${n}`, state: "running", managed: true, projectSlug: "loja", service: "web", oneoff: false, ...over });

describe("coletor: réplicas", () => {
  it("duas réplicas do mesmo serviço viram UMA série somada (antes uma sobrescrevia a outra), com rodando × desejadas", async () => {
    const h = harness(
      [web(1), web(2), web(3, { state: "exited" })],
      (e) => (e.state === "exited" ? rt({ state: "exited", exitCode: 1, pid: null }) : rt()),
      (e) => ({ mem: e.id === idOf(1) ? 1000 : 3000, limit: 10_000 }),
      { desired: async () => ({ web: 3 }) },
    );
    await h.c.tick();
    const s = h.appended[0]!;
    expect(s.c["loja/web"]).toMatchObject({ mem: 4000, up: 1, replicas: 2, replicasWanted: 3 });
    expect(s.c["loja"]).toMatchObject({ mem: 4000 });
    const tick = h.c.latest()!;
    expect(tick.services).toEqual([{ slug: "loja", service: "web", running: 2, wanted: 3 }]);
  });

  it("sem o compose, o desejado é o que existe; execução avulsa não conta como réplica", async () => {
    const h = harness([web(1), web(2), web(3, { oneoff: true })], () => rt());
    await h.c.tick();
    expect(h.appended[0]!.c["loja/web"]).toMatchObject({ replicas: 2, replicasWanted: 2 });
    expect(h.c.latest()!.services).toEqual([{ slug: "loja", service: "web", running: 2, wanted: 2 }]);
    expect(h.c.latest()!.containers.find((c) => c.id === idOf(3))!.oneoff).toBe(true);
  });

  it("desired que falha ou devolve null não derruba a volta", async () => {
    const boom = harness([web(1)], () => rt(), undefined, {
      desired: async () => {
        throw new Error("x");
      },
    });
    await boom.c.tick();
    expect(boom.appended[0]!.c["loja/web"]).toMatchObject({ replicas: 1, replicasWanted: 1 });
    const none = harness([web(1)], () => rt(), undefined, { desired: async () => null });
    await none.c.tick();
    expect(none.appended[0]!.c["loja/web"]).toMatchObject({ replicasWanted: 1 });
  });

  it("serviço todo parado: up 0, replicas 0 e desejadas 1; fora de projeto não tem contagem", async () => {
    const h = harness([web(1, { state: "exited" }), web(2, { projectSlug: null, managed: false, service: null, name: "caddy" })], (e) => (e.state === "exited" ? rt({ state: "exited", exitCode: 1, pid: null }) : rt()));
    await h.c.tick();
    expect(h.appended[0]!.c["loja/web"]).toMatchObject({ up: 0, replicas: 0, replicasWanted: 1 });
    expect(h.appended[0]!.c["~/caddy"]).not.toHaveProperty("replicas");
  });

  it("estado do container traz política de reinício e % da memória do limite", async () => {
    const h = harness([web(1)], () => rt({ restartPolicy: "on-failure" }), () => ({ mem: 950, limit: 1000 }));
    await h.c.tick();
    expect(h.c.latest()!.containers[0]).toMatchObject({ restartPolicy: "on-failure", oneoff: false, memPct: 95 });
  });
});

describe("coletor: tempo de subida", () => {
  it("entrega ao medidor o que precisa (saúde, horário exato, porta aberta) e esquece containers que sumiram", async () => {
    const seen: StartupObservation[] = [];
    const retained: ReadonlySet<string>[] = [];
    const h = harness([web(1), web(2, { service: "worker" }), web(3, { oneoff: true }), web(4, { projectSlug: null, managed: false, service: null })], () => rt({ health: "healthy", healthyAt: "2026-10-24T10:00:05Z" }), undefined, {
      startups: {
        observe: async (o) => void seen.push(o),
        retain: (ids) => void retained.push(ids),
      },
    });
    h.reader.listening = async (pid) => (pid === 1234 ? true : null);
    await h.c.tick();
    expect(seen.map((o) => `${o.slug}/${o.service}`).sort()).toEqual(["loja/web", "loja/worker"]);
    expect(seen[0]).toMatchObject({ state: "running", health: "healthy", healthyAt: "2026-10-24T10:00:05Z", startedAt: "2026-10-24T10:00:00Z" });
    expect(await seen[0]!.listening()).toBe(true);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.size).toBe(4);
  });

  it("leitor sem 'listening' vira null; falha do medidor nunca afeta a coleta", async () => {
    const seen: StartupObservation[] = [];
    const h = harness([web(1)], () => rt(), undefined, {
      startups: {
        observe: async (o) => {
          seen.push(o);
          throw new Error("disco");
        },
        retain: () => undefined,
      },
    });
    await h.c.tick();
    expect(await seen[0]!.listening()).toBeNull();
    expect(h.appended).toHaveLength(1);
  });

  it("sem inspect não se mede nada", async () => {
    const observe = vi.fn(async () => undefined);
    const h = harness([web(1)], () => null, undefined, { startups: { observe, retain: () => undefined } });
    await h.c.tick();
    expect(observe).not.toHaveBeenCalled();
  });
});
