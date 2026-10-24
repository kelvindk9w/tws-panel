/**
 * metrics-compute.ts — de contadores crus a métricas (puro).
 *
 * O kernel entrega contadores que só crescem (tempo de CPU, bytes). Uma
 * métrica é a DIFERENÇA entre duas leituras dividida pelo tempo entre elas.
 * Regras que valem aqui:
 *  - sem leitura anterior, ou com o contador menor que o anterior (reboot,
 *    container recriado), a taxa daquele minuto NÃO existe: a métrica fica
 *    ausente ("sem dados"), nunca 0 e nunca um número negativo;
 *  - intervalo entre leituras estranho (zero, negativo, ou mais que 5× o
 *    normal — a VPS ficou parada) também invalida as taxas;
 *  - o que o kernel não informa fica ausente.
 */
import { METRICS_INTERVAL_SECONDS, type ContainerMetricId, type HostMetricId } from "@paas/core";
import { isVirtualInterface, type CpuTimes, type DiskCounters, type MemInfo, type NetCounters, type VmStat } from "./metrics-parse.js";

export type HostSampleValues = Partial<Record<HostMetricId, number>>;
export type ContainerSampleValues = Partial<Record<ContainerMetricId, number>>;

/** Maior intervalo entre duas leituras em que uma taxa ainda faz sentido. */
export const MAX_RATE_GAP_SECONDS = METRICS_INTERVAL_SECONDS * 5;

export function rateWindowOk(dtSeconds: number): boolean {
  return Number.isFinite(dtSeconds) && dtSeconds > 0 && dtSeconds <= MAX_RATE_GAP_SECONDS;
}

/** Diferença de um contador; null se não dá para saber (sem anterior, ou ele diminuiu). */
export function counterDelta(prev: number | null | undefined, cur: number | null | undefined): number | null {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  return cur >= prev ? cur - prev : null;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface HostRaw {
  cpu: CpuTimes | null;
  cores: number | null;
  load: [number, number, number] | null;
  mem: MemInfo | null;
  vm: VmStat | null;
  psi: { cpu: number | null; mem: number | null; io: number | null };
  disks: DiskCounters[] | null;
  net: NetCounters[] | null;
  uptime: number | null;
  /** statfs da pasta de dados: bytes e inodes. */
  fs: { totalBytes: number; freeBytes: number; inodePct: number | null } | null;
}

const CPU_FIELDS = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"] as const;

/** % do tempo em cada modo entre duas leituras do /proc/stat. */
export function cpuPercentages(prev: CpuTimes | null, cur: CpuTimes | null): HostSampleValues {
  if (!prev || !cur) return {};
  const d = {} as Record<(typeof CPU_FIELDS)[number], number>;
  let total = 0;
  for (const f of CPU_FIELDS) {
    const v = counterDelta(prev[f], cur[f]);
    if (v === null) return {}; // reboot: um contador voltou
    d[f] = v;
    total += v;
  }
  if (total <= 0) return {};
  const pct = (v: number) => (v / total) * 100;
  const user = pct(d.user + d.nice);
  const system = pct(d.system + d.irq + d.softirq);
  return { cpuUser: user, cpuSystem: system, cpuBusy: user + system, cpuIowait: pct(d.iowait), cpuSteal: pct(d.steal) };
}

/** Soma de bytes das interfaces de verdade presentes nas DUAS leituras. */
function netRates(prev: NetCounters[] | null, cur: NetCounters[] | null, dt: number): HostSampleValues {
  if (!prev || !cur || !rateWindowOk(dt)) return {};
  const before = new Map(prev.filter((n) => !isVirtualInterface(n.name)).map((n) => [n.name, n]));
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const n of cur) {
    if (isVirtualInterface(n.name)) continue;
    const p = before.get(n.name);
    if (!p) continue;
    const a = counterDelta(p.rxBytes, n.rxBytes);
    const b = counterDelta(p.txBytes, n.txBytes);
    if (a === null || b === null) continue;
    rx += a;
    tx += b;
    any = true;
  }
  return any ? { netRx: rx / dt, netTx: tx / dt } : {};
}

function diskRates(prev: DiskCounters[] | null, cur: DiskCounters[] | null, dt: number): HostSampleValues {
  if (!prev || !cur || !rateWindowOk(dt)) return {};
  const before = new Map(prev.map((d) => [d.name, d]));
  let read = 0;
  let write = 0;
  let busy = 0;
  let any = false;
  for (const d of cur) {
    const p = before.get(d.name);
    if (!p) continue;
    const r = counterDelta(p.readBytes, d.readBytes);
    const w = counterDelta(p.writeBytes, d.writeBytes);
    const b = counterDelta(p.busyMs, d.busyMs);
    if (r === null || w === null || b === null) continue;
    read += r;
    write += w;
    // "ocupado" é por disco; o painel mostra o mais ocupado (somar passaria de 100%)
    busy = Math.max(busy, Math.min(100, (b / (dt * 1000)) * 100));
    any = true;
  }
  return any ? { ioRead: read / dt, ioWrite: write / dt, ioBusy: busy } : {};
}

/** Amostra do host: valores de agora + taxas desde a leitura anterior. */
export function hostSample(prev: HostRaw | null, cur: HostRaw, dtSeconds: number): HostSampleValues {
  const out: HostSampleValues = {};
  if (prev) Object.assign(out, cpuPercentages(prev.cpu, cur.cpu));
  if (cur.cores !== null && cur.cores > 0) out.cores = cur.cores;
  if (cur.load) [out.load1, out.load5, out.load15] = cur.load;
  if (cur.mem) {
    out.memTotal = cur.mem.totalBytes;
    out.memAvail = cur.mem.availBytes;
    out.memUsedPct = ((cur.mem.totalBytes - cur.mem.availBytes) / cur.mem.totalBytes) * 100;
    out.swapTotal = cur.mem.swapTotalBytes;
    out.swapUsed = cur.mem.swapTotalBytes - cur.mem.swapFreeBytes;
  }
  if (prev && cur.vm && prev.vm) {
    const oom = counterDelta(prev.vm.oomKill, cur.vm.oomKill);
    if (oom !== null) out.oom = oom;
    if (rateWindowOk(dtSeconds)) {
      const si = counterDelta(prev.vm.swapIn, cur.vm.swapIn);
      const so = counterDelta(prev.vm.swapOut, cur.vm.swapOut);
      if (si !== null) out.swapIn = si / dtSeconds;
      if (so !== null) out.swapOut = so / dtSeconds;
    }
  }
  if (cur.psi.cpu !== null) out.psiCpu = cur.psi.cpu;
  if (cur.psi.mem !== null) out.psiMem = cur.psi.mem;
  if (cur.psi.io !== null) out.psiIo = cur.psi.io;
  if (cur.fs && cur.fs.totalBytes > 0) {
    out.diskTotal = cur.fs.totalBytes;
    out.diskFree = cur.fs.freeBytes;
    out.diskPct = (1 - cur.fs.freeBytes / cur.fs.totalBytes) * 100;
    if (cur.fs.inodePct !== null) out.inodePct = cur.fs.inodePct;
  }
  if (prev) {
    Object.assign(out, diskRates(prev.disks, cur.disks, dtSeconds));
    Object.assign(out, netRates(prev.net, cur.net, dtSeconds));
  }
  if (cur.uptime !== null) out.uptime = cur.uptime;
  return out;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface ContainerRaw {
  /** CPU acumulada em microssegundos. */
  cpuUsec: number | null;
  memWorkingBytes: number | null;
  /** null = sem limite. */
  memLimitBytes: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  oomKills: number | null;
}

export interface ContainerRuntimeLite {
  state: string;
  restartCount: number | null;
  startedAt: string | null;
}

function rate(prev: number | null, cur: number | null, dt: number): number | undefined {
  const d = counterDelta(prev, cur);
  return d === null ? undefined : d / dt;
}

/** Amostra de um container. `raw` ausente (não deu para ler) = só o que o Docker informou (estado). */
export function containerSample(prev: ContainerRaw | null, cur: ContainerRaw | null, dtSeconds: number, running: boolean): ContainerSampleValues {
  const out: ContainerSampleValues = { up: running ? 1 : 0 };
  if (!cur) return out;
  if (cur.memWorkingBytes !== null) out.mem = cur.memWorkingBytes;
  if (cur.memLimitBytes !== null) out.memLimit = cur.memLimitBytes;
  if (prev) {
    const oom = counterDelta(prev.oomKills, cur.oomKills);
    if (oom !== null) out.oom = oom;
    if (rateWindowOk(dtSeconds)) {
      const cpu = rate(prev.cpuUsec, cur.cpuUsec, dtSeconds * 1_000_000);
      if (cpu !== undefined) out.cpu = cpu * 100;
      const set = (id: ContainerMetricId, v: number | undefined) => {
        if (v !== undefined) out[id] = v;
      };
      set("ioRead", rate(prev.ioReadBytes, cur.ioReadBytes, dtSeconds));
      set("ioWrite", rate(prev.ioWriteBytes, cur.ioWriteBytes, dtSeconds));
      set("netRx", rate(prev.netRxBytes, cur.netRxBytes, dtSeconds));
      set("netTx", rate(prev.netTxBytes, cur.netTxBytes, dtSeconds));
    }
  }
  return out;
}

/** Reinícios entre duas leituras do estado: o contador do Docker subiu, ou o container começou de novo. */
export function restartEvents(prev: ContainerRuntimeLite | null, cur: ContainerRuntimeLite): number {
  if (!prev) return 0;
  const byCount = counterDelta(prev.restartCount, cur.restartCount) ?? 0;
  if (byCount > 0) return byCount;
  return prev.startedAt !== null && cur.startedAt !== null && prev.startedAt !== cur.startedAt ? 1 : 0;
}

/** Soma as métricas dos serviços de um projeto. O limite de memória só existe se TODOS os serviços têm limite. */
export function sumContainerSamples(samples: ContainerSampleValues[]): ContainerSampleValues {
  const out: ContainerSampleValues = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s) as Array<[ContainerMetricId, number]>) {
      if (k === "memLimit") continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  if (samples.length > 0 && samples.every((s) => s.memLimit !== undefined)) {
    out.memLimit = samples.reduce((sum, s) => sum + (s.memLimit ?? 0), 0);
  }
  return out;
}

/** Casas decimais razoáveis para gravar: 1 casa abaixo de 1000, inteiro acima. */
export function roundMetric(v: number): number {
  return Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 10) / 10;
}
