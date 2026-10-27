import { describe, expect, it } from "vitest";
import {
  MAX_PROC_LINES,
  MAX_PROC_TEXT,
  isVirtualInterface,
  isWholeDisk,
  parseDiskstats,
  parseDockerStats,
  parseIoStat,
  parseKeyValue,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parsePressure,
  parseProcStat,
  parseSingleNumber,
  parseUptime,
  parseVmstat,
  procLines,
} from "../src/services/metrics-parse.js";
import * as F from "./fixtures/metrics-proc.js";

describe("procLines", () => {
  it("separa por \\n e não perde a última linha sem quebra", () => {
    expect(procLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(procLines("a\n")).toEqual(["a"]);
    expect(procLines("")).toEqual([]);
  });

  it("corta o texto e o número de linhas", () => {
    expect(procLines("x".repeat(MAX_PROC_TEXT + 500)).join("").length).toBe(MAX_PROC_TEXT);
    expect(procLines("a\n".repeat(MAX_PROC_LINES + 10))).toHaveLength(MAX_PROC_LINES);
  });
});

describe("parseProcStat", () => {
  it("lê os tempos da CPU, os núcleos e a hora do boot", () => {
    expect(parseProcStat(F.PROC_STAT)).toEqual({
      cpu: { user: 10132153, nice: 290696, system: 3084719, idle: 46828483, iowait: 16683, irq: 0, softirq: 25195, steal: 1500 },
      cores: 2,
      btime: 1760000000,
    });
  });

  it("kernel antigo sem iowait/steal: o que falta vale 0", () => {
    expect(parseProcStat(F.PROC_STAT_OLD_KERNEL).cpu).toEqual({ user: 100, nice: 5, system: 50, idle: 800, iowait: 0, irq: 0, softirq: 0, steal: 0 });
  });

  it("linha cpu estragada vira null (não zero)", () => {
    expect(parseProcStat("cpu  1 2 3\n").cpu).toBeNull();
    expect(parseProcStat("cpu  1 2 x 4 5 6 7 8\n").cpu).toBeNull();
    expect(parseProcStat("cpu  -1 2 3 4\n").cpu).toBeNull();
    expect(parseProcStat("").cpu).toBeNull();
  });

  it("linha cpu longa demais é recusada", () => {
    expect(parseProcStat(`cpu ${"1 ".repeat(30)}\n`).cpu).toBeNull();
  });

  it("btime ruim vira null; cpu sem número (cpuinfo) não conta como núcleo", () => {
    expect(parseProcStat("btime abc\ncpufreq 1\n")).toEqual({ cpu: null, cores: 0, btime: null });
  });
});

describe("parseMeminfo", () => {
  it("usa MemAvailable e converte kB em bytes", () => {
    expect(parseMeminfo(F.MEMINFO)).toEqual({
      totalBytes: 8131364 * 1024,
      availBytes: 5210044 * 1024,
      swapTotalBytes: 2097148 * 1024,
      swapFreeBytes: 2000000 * 1024,
    });
  });

  it("sem MemAvailable estima livre + buffers + cache; sem swap, 0", () => {
    expect(parseMeminfo(F.MEMINFO_NO_AVAILABLE)).toEqual({
      totalBytes: 1000000 * 1024,
      availBytes: 400000 * 1024,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    });
  });

  it("disponível nunca passa do total; swap livre nunca passa do total de swap", () => {
    const r = parseMeminfo("MemTotal: 100 kB\nMemAvailable: 500 kB\nSwapTotal: 10 kB\nSwapFree: 50 kB\n")!;
    expect(r.availBytes).toBe(100 * 1024);
    expect(r.swapFreeBytes).toBe(10 * 1024);
  });

  it("sem total, ou sem disponível nem livre, é null", () => {
    expect(parseMeminfo("MemFree: 1 kB\n")).toBeNull();
    expect(parseMeminfo("MemTotal: 0 kB\n")).toBeNull();
    expect(parseMeminfo("MemTotal: 1000 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });

  it("ignora chaves de outros nomes e valores estragados", () => {
    const r = parseMeminfo("Dirty: 5 kB\nMemTotal: 100 kB\nMemAvailable: lixo kB\nMemFree: 10 kB\n:\n" + "k".repeat(40) + ": 1 kB\n")!;
    expect(r.availBytes).toBe(10 * 1024);
  });
});

describe("parseVmstat / loadavg / uptime / pressão", () => {
  it("vmstat: swap e mortes por falta de memória", () => {
    expect(parseVmstat(F.VMSTAT)).toEqual({ swapIn: 120, swapOut: 340, oomKill: 2 });
  });
  it("vmstat sem oom_kill: null, não 0", () => {
    expect(parseVmstat(F.VMSTAT_NO_OOM)).toEqual({ swapIn: 0, swapOut: 0, oomKill: null });
    expect(parseVmstat("")).toEqual({ swapIn: null, swapOut: null, oomKill: null });
  });
  it("loadavg", () => {
    expect(parseLoadavg(F.LOADAVG)).toEqual([0.52, 0.41, 0.35]);
    expect(parseLoadavg("x y z")).toBeNull();
    expect(parseLoadavg("0.1 0.2")).toBeNull();
    expect(parseLoadavg("")).toBeNull();
  });
  it("uptime", () => {
    expect(parseUptime(F.UPTIME)).toBe(523412.55);
    expect(parseUptime("abc")).toBeNull();
  });
  it("pressão: some e full de 60 s; sem some é null", () => {
    expect(parsePressure(F.PRESSURE_CPU)).toEqual({ some60: 2.5, full60: 0 });
    expect(parsePressure(F.PRESSURE_MEM)).toEqual({ some60: 0.12, full60: 0.05 });
    expect(parsePressure("full avg10=0 avg60=1.00 avg300=0 total=0\n")).toBeNull();
    expect(parsePressure("some avg10=0.00 avg60=abc avg300=0 total=0\n")).toBeNull();
    expect(parsePressure("")).toBeNull();
    expect(parsePressure("some total=1\n")).toBeNull();
  });
});

describe("rede e disco", () => {
  it("parseNetDev: bytes de entrada e saída por interface, ignorando cabeçalhos", () => {
    const r = parseNetDev(F.NET_DEV);
    expect(r.map((i) => i.name)).toEqual(["lo", "eth0", "docker0", "veth1a2b"]);
    expect(r.find((i) => i.name === "eth0")).toEqual({ name: "eth0", rxBytes: 5000000000, txBytes: 2000000000 });
  });
  it("parseNetDev: linha estragada ou com nome estranho é ignorada", () => {
    expect(parseNetDev("eth0: a b c\n  : 1 2 3 4 5 6 7 8 9\n" + "n".repeat(40) + ": 1 2 3 4 5 6 7 8 9\nx y: 1 2 3 4 5 6 7 8 9\n")).toEqual([]);
  });
  it("interfaces virtuais: lo, pontes e pares do Docker, túneis; eth0 e ens3 não", () => {
    for (const n of ["lo", "docker0", "br-1a2b3c", "veth12", "virbr0", "cni0", "flannel.1", "cali123", "tun0", "tap1", "dummy0", "vxlan.calico", "kube-ipvs0", "wg0", "tailscale0", "ztabcdef12"]) {
      expect(isVirtualInterface(n)).toBe(true);
    }
    for (const n of ["eth0", "ens3", "enp1s0", "eno1", "wlan0", "bond0"]) expect(isVirtualInterface(n)).toBe(false);
  });
  it("disco inteiro: sda, vdb, xvda, nvme0n1, mmcblk0; partição, loop e dm não", () => {
    for (const n of ["sda", "vdb", "xvda", "nvme0n1", "mmcblk0", "hda"]) expect(isWholeDisk(n)).toBe(true);
    for (const n of ["sda1", "vda2", "loop0", "dm-0", "nvme0n1p1", "mmcblk0p1", "ram0", "md0", "", "s".repeat(40)]) expect(isWholeDisk(n)).toBe(false);
  });
  it("parseDiskstats: setores viram bytes (512) e fica só o disco inteiro", () => {
    expect(parseDiskstats(F.DISKSTATS)).toEqual([
      { name: "sda", readBytes: 2400000 * 512, writeBytes: 6400000 * 512, busyMs: 41000 },
      { name: "nvme0n1", readBytes: 80 * 512, writeBytes: 160 * 512, busyMs: 5 },
    ]);
  });
  it("parseDiskstats: linha curta ou com lixo é ignorada", () => {
    expect(parseDiskstats("8 0 sda 1 2 3\n8 0 sdb 1 0 x 0 0 0 0 0 0 0 0\n")).toEqual([]);
  });
});

describe("cgroup v2", () => {
  it("parseKeyValue lê chave e número; ignora o resto", () => {
    expect(parseKeyValue(F.CG_CPU_STAT).usage_usec).toBe(91234567);
    expect(parseKeyValue(F.CG_MEMORY_STAT).inactive_file).toBe(157286400);
    expect(parseKeyValue(F.CG_MEMORY_EVENTS).oom_kill).toBe(1);
    expect(parseKeyValue("semespaco\n x 1\nok 5\nbad abc\n" + "k".repeat(70) + " 1\n")).toEqual({ ok: 5 });
  });
  it("parseSingleNumber: número; 'max', vazio e lixo são null", () => {
    expect(parseSingleNumber(F.CG_MEMORY_CURRENT)).toBe(314572800);
    expect(parseSingleNumber(F.CG_MEMORY_MAX_LIMIT)).toBe(536870912);
    expect(parseSingleNumber(F.CG_MEMORY_MAX_NONE)).toBeNull();
    expect(parseSingleNumber("")).toBeNull();
    expect(parseSingleNumber("12abc")).toBeNull();
    expect(parseSingleNumber("9".repeat(25))).toBeNull();
    expect(parseSingleNumber("99999999999999999999")).toBeNull();
  });
  it("parseIoStat soma os dispositivos; sem rbytes/wbytes é null", () => {
    expect(parseIoStat(F.CG_IO_STAT)).toEqual({ readBytes: 1048576 + 1024, writeBytes: 2097152 + 2048 });
    expect(parseIoStat("")).toBeNull();
    expect(parseIoStat("8:0 rios=1\n")).toBeNull();
    expect(parseIoStat("8:0 rbytes=x wbytes=y\n")).toBeNull();
    expect(parseIoStat("8:0 rbytes=5\n")).toEqual({ readBytes: 5, writeBytes: 0 });
    expect(parseIoStat("8:0 wbytes=7\n")).toEqual({ readBytes: 0, writeBytes: 7 });
  });
});

describe("parseDockerStats (reserva quando o cgroup não está montado)", () => {
  it("converte nanossegundos de CPU, memória de trabalho, disco e rede (soma das interfaces)", () => {
    expect(parseDockerStats(F.DOCKER_STATS)).toEqual({
      cpuUsec: 91234567,
      memWorkingBytes: 314572800 - 157286400,
      memLimitBytes: 536870912,
      ioReadBytes: 1048576,
      ioWriteBytes: 2097152,
      netRxBytes: 123466,
      netTxBytes: 65452,
    });
  });
  it("cgroup v1 usa total_inactive_file; sem nenhum, não desconta nada", () => {
    expect(parseDockerStats({ memory_stats: { usage: 1000, stats: { total_inactive_file: 400 } } }).memWorkingBytes).toBe(600);
    expect(parseDockerStats({ memory_stats: { usage: 1000, stats: {} } }).memWorkingBytes).toBe(1000);
    expect(parseDockerStats({ memory_stats: { usage: 100, stats: { inactive_file: 400 } } }).memWorkingBytes).toBe(0);
  });
  it("campos ausentes ou estranhos viram null, nunca 0", () => {
    const empty = { cpuUsec: null, memWorkingBytes: null, memLimitBytes: null, ioReadBytes: null, ioWriteBytes: null, netRxBytes: null, netTxBytes: null };
    expect(parseDockerStats({})).toEqual(empty);
    expect(parseDockerStats(null)).toEqual(empty);
    expect(parseDockerStats([])).toEqual(empty);
    expect(parseDockerStats({ cpu_stats: { cpu_usage: { total_usage: -1 } }, memory_stats: { usage: "x", limit: Number.NaN }, blkio_stats: { io_service_bytes_recursive: [{ op: "Read", value: "x" }, 5, null] }, networks: { eth0: {} } })).toEqual(empty);
  });
  it("disco: leituras e escritas se somam; limita a quantidade de entradas lidas", () => {
    const blk = Array.from({ length: 1000 }, () => ({ op: "Read", value: 1 }));
    expect(parseDockerStats({ blkio_stats: { io_service_bytes_recursive: blk } }).ioReadBytes).toBe(256);
    expect(parseDockerStats({ blkio_stats: { io_service_bytes_recursive: "x" } }).ioReadBytes).toBeNull();
  });
});

describe("desempenho com entrada hostil (tudo linear)", () => {
  const hostile = [" ".repeat(900_000), "\t 1".repeat(250_000), "a:".repeat(400_000), "1 ".repeat(450_000), ("some avg60=" + "9".repeat(1000) + " ").repeat(500)];
  it("nenhum parser passa de 1 s com um megabyte de lixo", () => {
    const parsers: Array<(t: string) => unknown> = [parseProcStat, parseMeminfo, parseVmstat, parseLoadavg, parseUptime, parsePressure, parseNetDev, parseDiskstats, parseKeyValue, parseSingleNumber, parseIoStat];
    // tempo de CPU do processo, não de relógio: com a máquina ocupada o relógio infla sem que o parser tenha ficado mais lento
    const start = process.cpuUsage();
    for (const text of hostile) for (const p of parsers) p(text);
    const used = process.cpuUsage(start);
    expect((used.user + used.system) / 1000).toBeLessThan(1500);
  });
});
