import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerReader, HostSampler, READ_CHUNK_BYTES, READ_MAX_BYTES, readText, type ReadText, type StatFs } from "../src/services/metrics-sources.js";
import type { DockerStatsRaw } from "../src/services/metrics-parse.js";
import * as F from "./fixtures/metrics-proc.js";

const ID = "a".repeat(64);
const fsOf = (files: Record<string, string>): ReadText => async (file) => files[file] ?? null;
const statfs: StatFs = async () => ({ blocks: 1000, bsize: 4096, bavail: 400, files: 5000, ffree: 4400 });

function hostFiles(root: string): Record<string, string> {
  return {
    [`${root}/stat`]: F.PROC_STAT,
    [`${root}/meminfo`]: F.MEMINFO,
    [`${root}/vmstat`]: F.VMSTAT,
    [`${root}/loadavg`]: F.LOADAVG,
    [`${root}/uptime`]: F.UPTIME,
    [`${root}/diskstats`]: F.DISKSTATS,
    [`${root}/pressure/cpu`]: F.PRESSURE_CPU,
    [`${root}/pressure/memory`]: F.PRESSURE_MEM,
    [`${root}/1/net/dev`]: F.NET_DEV,
  };
}
const hostOpts = (files: Record<string, string>, over: Partial<{ statfs: StatFs }> = {}) => ({
  mountedProc: "/host/proc",
  ownProc: "/proc",
  dataDir: "/data",
  read: fsOf(files),
  statfs,
  ...over,
});

describe("readText", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-readtext-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("lê o arquivo; ausente, pasta e caminho estranho dão null", async () => {
    await writeFile(path.join(dir, "a"), "oi\n");
    expect(await readText(path.join(dir, "a"))).toBe("oi\n");
    expect(await readText(path.join(dir, "nao"))).toBeNull();
    expect(await readText(dir)).toBeNull();
    expect(await readText("\0")).toBeNull();
  });

  it("arquivo maior que um bloco (e que não é múltiplo dele) volta inteiro, na ordem", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `linha ${i}`).join("\n") + "\n";
    expect(text.length).toBeGreaterThan(READ_CHUNK_BYTES * 2);
    await writeFile(path.join(dir, "medio"), text);
    expect(await readText(path.join(dir, "medio"))).toBe(text);
    await writeFile(path.join(dir, "exato"), "x".repeat(READ_CHUNK_BYTES * 2));
    expect((await readText(path.join(dir, "exato")))!.length).toBe(READ_CHUNK_BYTES * 2);
    await writeFile(path.join(dir, "vazio"), "");
    expect(await readText(path.join(dir, "vazio"))).toBe("");
  });

  it("corta no teto de bytes", async () => {
    await writeFile(path.join(dir, "grande"), "x".repeat(READ_MAX_BYTES + 1000));
    expect((await readText(path.join(dir, "grande")))!.length).toBe(READ_MAX_BYTES);
  });

  it("lê arquivos de verdade de /proc (o ambiente de teste é Linux)", async () => {
    const stat = await readText("/proc/stat");
    if (stat !== null) expect(stat.startsWith("cpu ")).toBe(true);
  });
});

describe("HostSampler", () => {
  it("com /proc montado lê tudo, inclusive a rede do host, e diz 'mounted'", async () => {
    const { raw, source } = await new HostSampler(hostOpts(hostFiles("/host/proc"))).read();
    expect(source).toBe("mounted");
    expect(raw!.cpu!.steal).toBe(1500);
    expect(raw!.cores).toBe(2);
    expect(raw!.load).toEqual([0.52, 0.41, 0.35]);
    expect(raw!.mem!.totalBytes).toBe(8131364 * 1024);
    expect(raw!.vm!.oomKill).toBe(2);
    expect(raw!.psi).toEqual({ cpu: 2.5, mem: 0.12, io: null });
    expect(raw!.disks!.map((d) => d.name)).toEqual(["sda", "nvme0n1"]);
    expect(raw!.net!.map((n) => n.name)).toContain("eth0");
    expect(raw!.uptime).toBe(523412.55);
    expect(raw!.fs).toEqual({ totalBytes: 1000 * 4096, freeBytes: 400 * 4096, inodePct: 12 });
  });

  it("sem a montagem cai para o /proc do container: host só pelos arquivos globais, sem rede, e diz 'container'", async () => {
    const files = hostFiles("/proc");
    const { raw, source } = await new HostSampler(hostOpts({ ...files, "/proc/1/net/dev": F.NET_DEV })).read();
    expect(source).toBe("container");
    expect(raw!.cpu).not.toBeNull();
    expect(raw!.net).toBeNull(); // o net/dev do container não é o do host
  });

  it("nem um nem outro: raw null e 'none'", async () => {
    expect(await new HostSampler(hostOpts({})).read()).toEqual({ raw: null, source: "none" });
  });

  it("arquivo que falta deixa só aquela parte sem dados", async () => {
    const files = hostFiles("/host/proc");
    for (const k of ["meminfo", "vmstat", "loadavg", "uptime", "diskstats", "pressure/cpu", "pressure/memory", "1/net/dev"]) delete files[`/host/proc/${k}`];
    const { raw } = await new HostSampler(hostOpts(files)).read();
    expect(raw).toMatchObject({ load: null, mem: null, vm: null, disks: null, net: null, uptime: null, psi: { cpu: null, mem: null, io: null } });
    expect(raw!.cpu).not.toBeNull();
  });

  it("conteúdo estragado também vira ausência; stat sem a linha cpu gera cpu null e cores null", async () => {
    const files = { ...hostFiles("/host/proc"), "/host/proc/pressure/cpu": "lixo", "/host/proc/stat": "btime 1\n" };
    const { raw } = await new HostSampler(hostOpts(files)).read();
    expect(raw!.psi.cpu).toBeNull();
    expect(raw!.cpu).toBeNull();
    expect(raw!.cores).toBeNull();
  });

  it("statfs falhando, vazio ou sem inodes: fs null / inodePct null", async () => {
    const files = hostFiles("/host/proc");
    expect((await new HostSampler(hostOpts(files, { statfs: async () => Promise.reject(new Error("x")) })).read()).raw!.fs).toBeNull();
    expect((await new HostSampler(hostOpts(files, { statfs: async () => ({ blocks: 0, bsize: 4096, bavail: 0, files: 0, ffree: 0 }) })).read()).raw!.fs).toBeNull();
    expect((await new HostSampler(hostOpts(files, { statfs: async () => ({ blocks: 10, bsize: 4096, bavail: 5, files: 0, ffree: 0 }) })).read()).raw!.fs).toEqual({ totalBytes: 40960, freeBytes: 20480, inodePct: null });
  });

  it("só lê caminhos da lista fixa (nada de cmdline, environ ou outro arquivo de processo)", async () => {
    const seen: string[] = [];
    await new HostSampler({ ...hostOpts({}), read: async (f) => (seen.push(f), null) }).read();
    const files = hostFiles("/host/proc");
    const reads = new HostSampler({ ...hostOpts(files), read: async (f) => (seen.push(f), files[f] ?? null) });
    seen.length = 0;
    await reads.read();
    for (const f of seen) expect(f).toMatch(/^\/host\/proc\/(stat|meminfo|vmstat|loadavg|uptime|diskstats|pressure\/(cpu|memory|io)|1\/net\/dev)$/);
  });
});

describe("ContainerReader", () => {
  const sysDir = `/host/sys/fs/cgroup/system.slice/docker-${ID}.scope`;
  const cg = (dir: string, over: Record<string, string | undefined> = {}): Record<string, string> => {
    const base: Record<string, string | undefined> = {
      "cpu.stat": F.CG_CPU_STAT,
      "memory.current": F.CG_MEMORY_CURRENT,
      "memory.max": F.CG_MEMORY_MAX_LIMIT,
      "memory.stat": F.CG_MEMORY_STAT,
      "memory.events": F.CG_MEMORY_EVENTS,
      "io.stat": F.CG_IO_STAT,
      ...over,
    };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined) out[`${dir}/${k}`] = v;
    return out;
  };
  const root: Record<string, string> = { "/host/sys/fs/cgroup/cgroup.controllers": "cpu io memory pids\n" };
  const make = (files: Record<string, string>, stats: (id: string) => Promise<DockerStatsRaw | null> = async () => null) =>
    new ContainerReader({ cgroupRoot: "/host/sys/fs/cgroup", procRoot: "/host/proc", read: fsOf(files), stats });

  it("cgroup v2 com driver systemd: CPU, memória de trabalho, limite, disco, oom e rede pelo PID", async () => {
    const r = make({ ...root, ...cg(sysDir), "/host/proc/777/net/dev": F.PROC_PID_NET_DEV });
    await r.refresh();
    const { raw, via } = await r.read(ID, 777, 8e9);
    expect(via).toBe("cgroup");
    expect(raw).toEqual({
      cpuUsec: 91234567,
      cpuPeriods: 0,
      cpuThrottled: 0,
      cpuLimitPct: null,
      memWorkingBytes: 314572800 - 157286400,
      memLimitBytes: 536870912,
      ioReadBytes: 1048576 + 1024,
      ioWriteBytes: 2097152 + 2048,
      netRxBytes: 123456,
      netTxBytes: 65432,
      oomKills: 1,
    });
  });

  it("driver cgroupfs (docker/<id>) também é achado, e o caminho é lembrado", async () => {
    const dir = `/host/sys/fs/cgroup/docker/${ID}`;
    const reads: string[] = [];
    const files = { ...root, ...cg(dir) };
    const r = new ContainerReader({ cgroupRoot: "/host/sys/fs/cgroup", procRoot: "/host/proc", read: async (f) => (reads.push(f), files[f] ?? null), stats: async () => null });
    await r.refresh();
    expect((await r.read(ID, null, null)).via).toBe("cgroup");
    reads.length = 0;
    await r.read(ID, null, null);
    expect(reads.filter((f) => f.includes("system.slice"))).toEqual([]); // não procura de novo
  });

  it("sem limite ('max'), sem io.stat, sem PID e sem eventos: esses campos ficam null; memória nunca negativa", async () => {
    const r = make({ ...root, ...cg(sysDir, { "memory.max": F.CG_MEMORY_MAX_NONE, "io.stat": undefined, "memory.events": undefined, "memory.stat": "inactive_file 999999999999\n" }) });
    await r.refresh();
    const { raw } = await r.read(ID, null, null);
    expect(raw).toMatchObject({ memLimitBytes: null, ioReadBytes: null, ioWriteBytes: null, oomKills: null, netRxBytes: null, memWorkingBytes: 0 });
  });

  it("memory.stat ausente: não desconta cache; arquivos de CPU/memória ausentes: null", async () => {
    const r = make({ ...root, ...cg(sysDir, { "memory.stat": undefined, "cpu.stat": undefined, "memory.max": undefined }) });
    await r.refresh();
    expect((await r.read(ID, null, null)).raw).toMatchObject({ memWorkingBytes: 314572800, cpuUsec: null, memLimitBytes: null });
  });

  it("rede: só interfaces de verdade; só loopback (ou PID ruim) = null", async () => {
    const onlyLo = "Inter-|\n face |\n    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n";
    const r = make({ ...root, ...cg(sysDir), "/host/proc/10/net/dev": onlyLo, "/host/proc/11/net/dev": F.PROC_PID_NET_DEV });
    await r.refresh();
    expect((await r.read(ID, 10, null)).raw).toMatchObject({ netRxBytes: null, netTxBytes: null });
    expect((await r.read(ID, 11, null)).raw).toMatchObject({ netRxBytes: 123456 });
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect((await r.read(ID, bad, null)).raw).toMatchObject({ netRxBytes: null });
    }
  });

  it("container sem pasta no cgroup (ou cgroup v2 ausente) cai para a API do Docker; limite igual à RAM do host = sem limite", async () => {
    const stats = vi.fn(async (): Promise<DockerStatsRaw> => ({
      cpuUsec: 5,
      memWorkingBytes: 6,
      memLimitBytes: 8e9,
      ioReadBytes: 7,
      ioWriteBytes: 8,
      netRxBytes: 9,
      netTxBytes: 10,
    }));
    for (const files of [root, {}]) {
      const r = make(files, stats);
      await r.refresh();
      const { raw, via } = await r.read(ID, null, 8e9);
      expect(via).toBe("api");
      expect(raw).toEqual({ cpuUsec: 5, cpuPeriods: null, cpuThrottled: null, cpuLimitPct: null, memWorkingBytes: 6, memLimitBytes: null, ioReadBytes: 7, ioWriteBytes: 8, netRxBytes: 9, netTxBytes: 10, oomKills: null });
    }
    const r = make({}, stats);
    expect((await r.read(ID, null, 16e9)).raw!.memLimitBytes).toBe(8e9); // limite de verdade (bem menor que a RAM)
    expect((await r.read(ID, null, null)).raw!.memLimitBytes).toBe(8e9);
  });

  it("nem cgroup nem API: none", async () => {
    const r = make(root);
    await r.refresh();
    expect(await r.read(ID, null, null)).toEqual({ raw: null, via: "none" });
  });

  it("id fora do formato nunca vira caminho", async () => {
    const reads: string[] = [];
    // cgroup v2 montado (senão o leitor nem tentaria montar caminho): aí o id é a única coisa que poderia entrar no caminho
    const r = new ContainerReader({
      cgroupRoot: "/host/sys/fs/cgroup",
      procRoot: "/host/proc",
      read: async (f) => (reads.push(f), f.endsWith("cgroup.controllers") ? "cpu\n" : null),
      stats: async () => null,
    });
    expect(await r.refresh()).toBe(true);
    reads.length = 0;
    for (const bad of ["../../etc", "A".repeat(64), "abc", `${ID}/..`, ""]) {
      expect(await r.read(bad, null, null)).toEqual({ raw: null, via: "none" });
    }
    expect(reads).toEqual([]);
  });

  it("refresh() diz se o cgroup está montado e se atualiza; retain() esquece containers que sumiram", async () => {
    const files: Record<string, string> = {};
    const r = new ContainerReader({ cgroupRoot: "/host/sys/fs/cgroup", procRoot: "/host/proc", read: fsOf(files), stats: async () => null });
    expect(await r.refresh()).toBe(false);
    Object.assign(files, root, cg(sysDir));
    expect(await r.refresh()).toBe(true);
    expect((await r.read(ID, null, null)).via).toBe("cgroup");
    r.retain(new Set());
    delete files[`${sysDir}/memory.current`];
    expect((await r.read(ID, null, null)).via).toBe("none");
  });
});
