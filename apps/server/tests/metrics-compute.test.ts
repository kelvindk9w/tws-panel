import { describe, expect, it } from "vitest";
import {
  MAX_RATE_GAP_SECONDS,
  containerSample,
  counterDelta,
  cpuPercentages,
  hostSample,
  rateWindowOk,
  restartEvents,
  dockerOomEvent,
  vpsOomKills,
  roundMetric,
  sumContainerSamples,
  type ContainerRaw,
  type HostRaw,
} from "../src/services/metrics-compute.js";
import { parseDiskstats, parseLoadavg, parseMeminfo, parseNetDev, parseProcStat, parseVmstat } from "../src/services/metrics-parse.js";
import * as F from "./fixtures/metrics-proc.js";

const cpu1 = parseProcStat(F.PROC_STAT).cpu!;
const cpu2 = parseProcStat(F.PROC_STAT_LATER).cpu!;

function hostRaw(over: Partial<HostRaw> = {}): HostRaw {
  return {
    cpu: cpu1,
    cores: 2,
    load: parseLoadavg(F.LOADAVG),
    mem: parseMeminfo(F.MEMINFO),
    vm: parseVmstat(F.VMSTAT),
    psi: { cpu: 2.5, mem: 0.12, io: null },
    disks: parseDiskstats(F.DISKSTATS),
    net: parseNetDev(F.NET_DEV),
    uptime: 523412.55,
    fs: { totalBytes: 100e9, freeBytes: 40e9, inodePct: 12 },
    ...over,
  };
}

describe("contadores", () => {
  it("diferença normal, zero, e null quando não dá para saber", () => {
    expect(counterDelta(5, 12)).toBe(7);
    expect(counterDelta(5, 5)).toBe(0);
    expect(counterDelta(12, 5)).toBeNull(); // reboot
    expect(counterDelta(null, 5)).toBeNull();
    expect(counterDelta(5, null)).toBeNull();
    expect(counterDelta(undefined, 5)).toBeNull();
    expect(counterDelta(5, undefined)).toBeNull();
  });

  it("janela de taxa: de 1 s até 5 intervalos", () => {
    expect(rateWindowOk(60)).toBe(true);
    expect(rateWindowOk(MAX_RATE_GAP_SECONDS)).toBe(true);
    expect(rateWindowOk(MAX_RATE_GAP_SECONDS + 1)).toBe(false);
    expect(rateWindowOk(0)).toBe(false);
    expect(rateWindowOk(-5)).toBe(false);
    expect(rateWindowOk(Number.NaN)).toBe(false);
    expect(rateWindowOk(Infinity)).toBe(false);
  });
});

describe("CPU do host", () => {
  it("percentuais entre duas leituras reais (steal e iowait separados)", () => {
    const r = cpuPercentages(cpu1, cpu2);
    // deltas: user 3000, nice 0, system 2000, idle 6000, iowait 100, irq 0, softirq 100, steal 200 → total 11400
    expect(r.cpuUser).toBeCloseTo((3000 / 11400) * 100, 5);
    expect(r.cpuSystem).toBeCloseTo((2100 / 11400) * 100, 5);
    expect(r.cpuBusy).toBeCloseTo((5100 / 11400) * 100, 5);
    expect(r.cpuIowait).toBeCloseTo((100 / 11400) * 100, 5);
    expect(r.cpuSteal).toBeCloseTo((200 / 11400) * 100, 5);
  });

  it("sem leitura anterior, sem tempo decorrido ou com contador que voltou: nenhuma métrica", () => {
    expect(cpuPercentages(null, cpu2)).toEqual({});
    expect(cpuPercentages(cpu1, null)).toEqual({});
    expect(cpuPercentages(cpu1, cpu1)).toEqual({});
    expect(cpuPercentages(cpu2, cpu1)).toEqual({});
    expect(cpuPercentages({ ...cpu1 }, { ...cpu2, steal: 0 })).toEqual({});
  });
});

describe("amostra do host", () => {
  const later = (over: Partial<HostRaw> = {}): HostRaw =>
    hostRaw({
      cpu: cpu2,
      vm: { swapIn: 180, swapOut: 340, oomKill: 3 },
      disks: [
        { name: "sda", readBytes: 2400000 * 512 + 6_000_000, writeBytes: 6400000 * 512 + 12_000_000, busyMs: 41000 + 30_000 },
        { name: "nvme0n1", readBytes: 80 * 512, writeBytes: 160 * 512, busyMs: 5 },
      ],
      net: [
        { name: "lo", rxBytes: 9e9, txBytes: 9e9 },
        { name: "eth0", rxBytes: 5000000000 + 6_000_000, txBytes: 2000000000 + 3_000_000 },
        { name: "docker0", rxBytes: 1e9, txBytes: 1e9 },
      ],
      ...over,
    });

  it("valores de agora: memória, swap, carga, disco, PSI, uptime, núcleos", () => {
    const s = hostSample(null, hostRaw(), 0);
    expect(s.memTotal).toBe(8131364 * 1024);
    expect(s.memAvail).toBe(5210044 * 1024);
    expect(s.memUsedPct).toBeCloseTo(((8131364 - 5210044) / 8131364) * 100, 5);
    expect(s.swapTotal).toBe(2097148 * 1024);
    expect(s.swapUsed).toBe((2097148 - 2000000) * 1024);
    expect([s.load1, s.load5, s.load15]).toEqual([0.52, 0.41, 0.35]);
    expect(s.cores).toBe(2);
    expect(s.diskTotal).toBe(100e9);
    expect(s.diskFree).toBe(40e9);
    expect(s.diskPct).toBeCloseTo(60, 8);
    expect(s.inodePct).toBe(12);
    expect(s.psiCpu).toBe(2.5);
    expect(s.psiMem).toBe(0.12);
    expect("psiIo" in s).toBe(false); // sem PSI de IO: ausente, não 0
    expect(s.uptime).toBe(523412.55);
  });

  it("na primeira leitura não há taxa nem evento: cpu, rede, disco, swap e oom ficam ausentes", () => {
    const s = hostSample(null, hostRaw(), 60);
    for (const k of ["cpuBusy", "cpuSteal", "netRx", "ioRead", "swapIn", "oom"] as const) expect(k in s).toBe(false);
  });

  it("taxas e eventos entre duas leituras de 60 s", () => {
    const s = hostSample(hostRaw(), later(), 60);
    expect(s.cpuSteal).toBeCloseTo((200 / 11400) * 100, 5);
    expect(s.swapIn).toBeCloseTo(60 / 60, 8);
    expect(s.swapOut).toBe(0);
    expect(s.oom).toBe(1);
    expect(s.ioRead).toBeCloseTo(6_000_000 / 60, 5);
    expect(s.ioWrite).toBeCloseTo(12_000_000 / 60, 5);
    expect(s.ioBusy).toBeCloseTo((30_000 / 60_000) * 100, 5);
    // só eth0 entra: lo e docker0 são virtuais
    expect(s.netRx).toBeCloseTo(6_000_000 / 60, 5);
    expect(s.netTx).toBeCloseTo(3_000_000 / 60, 5);
  });

  it("intervalo estranho invalida as taxas, mas não os valores de agora nem o evento de oom", () => {
    for (const dt of [0, -3, 301]) {
      const s = hostSample(hostRaw(), later(), dt);
      for (const k of ["netRx", "ioRead", "swapIn", "swapOut"] as const) expect(k in s).toBe(false);
      expect(s.oom).toBe(1);
      expect(s.memAvail).toBeDefined();
    }
  });

  it("contador de oom que voltou (reboot) não vira evento nem número negativo", () => {
    const s = hostSample(hostRaw(), later({ vm: { swapIn: 0, swapOut: 0, oomKill: 0 } }), 60);
    expect("oom" in s).toBe(false);
    expect("swapIn" in s).toBe(false);
  });

  it("kernel sem oom_kill: ausente", () => {
    const s = hostSample(hostRaw({ vm: { swapIn: 0, swapOut: 0, oomKill: null } }), later({ vm: { swapIn: 0, swapOut: 0, oomKill: null } }), 60);
    expect("oom" in s).toBe(false);
  });

  it("disco que sumiu, interface nova e contador que voltou são ignorados individualmente", () => {
    const s = hostSample(
      hostRaw(),
      later({
        disks: [{ name: "sda", readBytes: 0, writeBytes: 0, busyMs: 0 }, { name: "vdz", readBytes: 1, writeBytes: 1, busyMs: 1 }],
        net: [{ name: "eth0", rxBytes: 1, txBytes: 1 }, { name: "ens9", rxBytes: 5, txBytes: 5 }],
      }),
      60,
    );
    expect(["ioRead", "netRx"].some((k) => k in s)).toBe(false);
  });

  it("'ocupado' é o do disco mais ocupado e nunca passa de 100", () => {
    const prev = hostRaw({ disks: [{ name: "sda", readBytes: 0, writeBytes: 0, busyMs: 0 }, { name: "sdb", readBytes: 0, writeBytes: 0, busyMs: 0 }] });
    const cur = hostRaw({ disks: [{ name: "sda", readBytes: 0, writeBytes: 0, busyMs: 30_000 }, { name: "sdb", readBytes: 0, writeBytes: 0, busyMs: 90_000 }] });
    expect(hostSample(prev, cur, 60).ioBusy).toBe(100);
    const cur2 = hostRaw({ disks: [{ name: "sda", readBytes: 0, writeBytes: 0, busyMs: 30_000 }, { name: "sdb", readBytes: 0, writeBytes: 0, busyMs: 6_000 }] });
    expect(hostSample(prev, cur2, 60).ioBusy).toBe(50);
  });

  it("fontes ausentes deixam as métricas ausentes", () => {
    const s = hostSample(null, hostRaw({ cpu: null, cores: null, load: null, mem: null, vm: null, psi: { cpu: null, mem: null, io: null }, disks: null, net: null, uptime: null, fs: null }), 60);
    expect(s).toEqual({});
    expect("cores" in hostSample(null, hostRaw({ cores: 0 }), 60)).toBe(false);
    expect("diskPct" in hostSample(null, hostRaw({ fs: { totalBytes: 0, freeBytes: 0, inodePct: null } }), 60)).toBe(false);
    expect("inodePct" in hostSample(null, hostRaw({ fs: { totalBytes: 10, freeBytes: 5, inodePct: null } }), 60)).toBe(false);
  });
});

describe("container", () => {
  const raw = (over: Partial<ContainerRaw> = {}): ContainerRaw => ({
    cpuUsec: 1_000_000,
    memWorkingBytes: 100,
    memLimitBytes: null,
    ioReadBytes: 1000,
    ioWriteBytes: 2000,
    netRxBytes: 10,
    netTxBytes: 20,
    oomKills: 0,
    ...over,
  });

  it("CPU em % de um núcleo: 30 s de CPU em 60 s = 50", () => {
    const s = containerSample(raw(), raw({ cpuUsec: 31_000_000, ioReadBytes: 7000, netRxBytes: 70, oomKills: 2 }), 60, true);
    expect(s.cpu).toBeCloseTo(50, 8);
    expect(s.ioRead).toBe(100);
    expect(s.ioWrite).toBe(0);
    expect(s.netRx).toBe(1);
    expect(s.oom).toBe(2);
    expect(s.mem).toBe(100);
    expect(s.up).toBe(1);
    expect("memLimit" in s).toBe(false);
  });

  it("limite de memória aparece quando existe", () => {
    expect(containerSample(null, raw({ memLimitBytes: 512 }), 60, true).memLimit).toBe(512);
  });

  it("primeira leitura: só valores de agora; sem leitura: só o estado", () => {
    expect(containerSample(null, raw(), 60, true)).toEqual({ up: 1, mem: 100 });
    expect(containerSample(null, null, 60, false)).toEqual({ up: 0 });
    expect(containerSample(raw(), null, 60, true)).toEqual({ up: 1 });
  });

  it("container recriado (contadores menores) não gera taxa negativa nem oom", () => {
    const s = containerSample(raw({ cpuUsec: 9e9, oomKills: 5 }), raw({ cpuUsec: 10, oomKills: 0 }), 60, true);
    expect(["cpu", "oom"].some((k) => k in s)).toBe(false);
  });

  it("janela estranha invalida taxas, mantém memória e oom", () => {
    const s = containerSample(raw(), raw({ cpuUsec: 5_000_000, oomKills: 1 }), 999, true);
    expect(["cpu", "ioRead", "netRx"].some((k) => k in s)).toBe(false);
    expect(s.oom).toBe(1);
  });

  it("campos que o container não informa ficam de fora", () => {
    const s = containerSample(raw({ netRxBytes: null }), raw({ netRxBytes: null, cpuUsec: null, memWorkingBytes: null }), 60, true);
    expect(["netRx", "cpu", "mem"].some((k) => k in s)).toBe(false);
    expect(s.netTx).toBe(0);
  });
});

describe("reinícios", () => {
  const rt = (restartCount: number | null, startedAt: string | null) => ({ state: "running", restartCount, startedAt });
  it("sem leitura anterior: 0", () => expect(restartEvents(null, rt(3, "a"))).toBe(0));
  it("contador do Docker subiu: a diferença", () => expect(restartEvents(rt(1, "a"), rt(4, "b"))).toBe(3));
  it("começou de novo sem o contador subir (restart manual, deploy): 1", () => expect(restartEvents(rt(0, "a"), rt(0, "b"))).toBe(1));
  it("nada mudou: 0", () => expect(restartEvents(rt(2, "a"), rt(2, "a"))).toBe(0));
  it("parar/iniciar pelo painel (manual): não conta; o contador do Docker subindo conta mesmo assim", () => {
    expect(restartEvents(rt(0, "a"), rt(0, "b"), true)).toBe(0);
    expect(restartEvents(rt(0, "a"), rt(2, "b"), true)).toBe(2);
  });
  it("contador menor (container recriado) e mesmo horário: 0; sem horário: 0", () => {
    expect(restartEvents(rt(5, "a"), rt(0, "a"))).toBe(0);
    expect(restartEvents(rt(0, null), rt(0, "b"))).toBe(0);
    expect(restartEvents(rt(0, "a"), rt(0, null))).toBe(0);
    expect(restartEvents(rt(null, "a"), rt(null, "a"))).toBe(0);
  });
});

describe("soma por projeto", () => {
  it("soma tudo menos o limite; o limite só existe se todos os serviços têm", () => {
    const a = { cpu: 10, mem: 100, memLimit: 200, up: 1, oom: 1 };
    const b = { cpu: 5, mem: 50, memLimit: 300, up: 0 };
    expect(sumContainerSamples([a, b])).toEqual({ cpu: 15, mem: 150, memLimit: 500, up: 1, oom: 1 });
    // serviço rodando sem a leitura de memória naquele minuto: a soma de memória fica sem dados (não cai sem aviso)
    expect(sumContainerSamples([a, { cpu: 1, up: 1 }])).toEqual({ cpu: 11, up: 2, oom: 1 });
    // serviço parado não tem leitura e não impede a soma
    expect(sumContainerSamples([a, { up: 0 }])).toEqual({ cpu: 10, mem: 100, up: 1, oom: 1 });
    expect(sumContainerSamples([])).toEqual({});
  });
  it("com o que cada serviço tinha na volta anterior: medida que nunca existiu não apaga a soma; a que sumiu neste minuto apaga", () => {
    const sidecar = { cpu: 1, mem: 10, up: 1 }; // nunca teve rede
    const web = { cpu: 5, mem: 50, netRx: 7, up: 1 };
    const had = (...keys: string[]) => new Set(keys);
    expect(sumContainerSamples([web, sidecar], [had("cpu", "mem", "netRx"), had("cpu", "mem")]).netRx).toBe(7);
    expect(sumContainerSamples([{ ...web, netRx: undefined }, sidecar], [had("cpu", "mem", "netRx"), had("cpu", "mem")])).not.toHaveProperty("netRx");
    // serviço novo (sem histórico) sem a medida: não se diz que faltou
    expect(sumContainerSamples([web, sidecar], [null, null]).netRx).toBe(7);
  });
  it("métrica que nenhum serviço mediu continua ausente", () => {
    expect("cpu" in sumContainerSamples([{ up: 1 }, { up: 1 }])).toBe(false);
  });
});

describe("arredondamento", () => {
  it("uma casa abaixo de mil, inteiro de mil para cima", () => {
    expect(roundMetric(12.3456)).toBe(12.3);
    expect(roundMetric(0.04)).toBe(0);
    expect(roundMetric(999.94)).toBe(999.9);
    expect(roundMetric(1234.56)).toBe(1235);
    expect(roundMetric(-1234.56)).toBe(-1235);
  });
});

describe("morte por falta de memória: Docker e VPS", () => {
  const rt = (oomKilled: boolean, finishedAt: string | null) => ({ state: "running", restartCount: 0, startedAt: "a", oomKilled, finishedAt });
  it("sinal do Docker: a marca ligou, ou saída nova com a marca; nunca na primeira vez nem sem a marca", () => {
    expect(dockerOomEvent(null, rt(true, "x"))).toBe(false);
    expect(dockerOomEvent(rt(false, null), rt(true, "x"))).toBe(true);
    expect(dockerOomEvent(rt(true, "x"), rt(true, "x"))).toBe(false);
    expect(dockerOomEvent(rt(true, "x"), rt(true, "y"))).toBe(true);
    expect(dockerOomEvent(rt(false, "x"), rt(false, "y"))).toBe(false);
    expect(dockerOomEvent({ state: "running", restartCount: 0, startedAt: "a" }, { state: "running", restartCount: 0, startedAt: "a", oomKilled: true })).toBe(true);
  });
  it("VPS: sem mortes = 0; o excedente das dos containers vale; tudo de containers só vale com pressão no host", () => {
    expect(vpsOomKills(0, 0, {})).toBe(0);
    expect(vpsOomKills(3, 1, {})).toBe(2);
    expect(vpsOomKills(1, 1, {})).toBe(0);
    expect(vpsOomKills(1, 1, { psiMem: 25 })).toBe(1);
    expect(vpsOomKills(1, 1, { psiMem: 2, memTotal: 1000, memAvail: 50 })).toBe(1);
    expect(vpsOomKills(1, 2, { psiMem: 2, memTotal: 1000, memAvail: 500 })).toBe(0);
    expect(vpsOomKills(1, 1, { memTotal: 0, memAvail: 0 })).toBe(0);
  });
});
