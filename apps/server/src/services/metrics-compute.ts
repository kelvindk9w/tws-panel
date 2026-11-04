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
  /** Períodos de CPU contados e quantos tiveram o container segurado pelo limite (cpu.stat; só com limite de CPU). */
  cpuPeriods?: number | null;
  cpuThrottled?: number | null;
  /** Limite de CPU em % de UM núcleo (cpu.max); null = sem limite. */
  cpuLimitPct?: number | null;
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
  /** O Docker marcou a última saída como morte por falta de memória. */
  oomKilled?: boolean;
  finishedAt?: string | null;
}

/**
 * Morte por falta de memória vista só pelo Docker (State.OOMKilled). Vale quando o container
 * volta a ser reiniciado antes da próxima leitura: o cgroup novo começa com o contador zerado e
 * o delta some, mas o Docker guarda que a última saída foi OOM. Conta uma vez por saída nova
 * (a marca ligou, ou o instante da saída mudou). Primeira vez que o container é visto não conta.
 */
export function dockerOomEvent(prev: ContainerRuntimeLite | null, cur: ContainerRuntimeLite): boolean {
  if (!prev || cur.oomKilled !== true) return false;
  return prev.oomKilled !== true || (prev.finishedAt ?? null) !== (cur.finishedAt ?? null);
}

/**
 * Mortes por falta de memória que valem para a VPS. O contador do kernel (oom_kill) conta também
 * quem bateu no limite do próprio container; essas já são do container (que tem o seu alerta) e
 * são descontadas. Sobrando mortes (processos fora de container), valem. Se TODAS são de
 * containers, só valem para a VPS quando o host estava sob pressão de memória (aí foi falta de
 * memória da máquina, não só do limite de um serviço).
 */
export function vpsOomKills(hostKills: number, containerKills: number, host: HostSampleValues): number {
  if (!(hostKills > 0)) return 0;
  const excess = hostKills - containerKills;
  if (excess > 0) return excess;
  const availPct = host.memTotal !== undefined && host.memTotal > 0 && host.memAvail !== undefined ? (host.memAvail / host.memTotal) * 100 : null;
  const pressured = (host.psiMem ?? 0) >= HOST_OOM_PSI || (availPct !== null && availPct < HOST_OOM_AVAIL_PCT);
  return pressured ? hostKills : 0;
}

/** Pressão de memória (PSI, %) e memória disponível (%) a partir das quais a morte é da VPS, não do limite de um container. */
const HOST_OOM_PSI = 10;
const HOST_OOM_AVAIL_PCT = 10;

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
  if (cur.cpuLimitPct !== null && cur.cpuLimitPct !== undefined) out.cpuLimit = cur.cpuLimitPct;
  if (prev) {
    // throttling: parte dos períodos de CPU em que o limite segurou o container (sem períodos novos = sem dado, nunca 0)
    const periods = counterDelta(prev.cpuPeriods, cur.cpuPeriods);
    const throttled = counterDelta(prev.cpuThrottled, cur.cpuThrottled);
    if (periods !== null && throttled !== null && periods > 0) out.cpuThrottle = Math.min(100, (throttled / periods) * 100);
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
export function restartEvents(prev: ContainerRuntimeLite | null, cur: ContainerRuntimeLite, manual = false): number {
  if (!prev) return 0;
  const byCount = counterDelta(prev.restartCount, cur.restartCount) ?? 0;
  if (byCount > 0) return byCount;
  // começou de novo sem o contador subir: parar/iniciar feito pela pessoa (no painel) não é reinício sem parar
  if (manual) return 0;
  return prev.startedAt !== null && cur.startedAt !== null && prev.startedAt !== cur.startedAt ? 1 : 0;
}

/** Métricas medidas a cada volta: se um serviço rodando ficou sem a leitura, a soma do projeto ficaria parcial (cairia sem aviso). */
const SUMMED_READINGS: readonly ContainerMetricId[] = ["cpu", "mem", "ioRead", "ioWrite", "netRx", "netTx"];

/**
 * Soma as métricas dos serviços de um projeto. O limite de memória só existe se TODOS os serviços têm limite.
 * Uma medida a que falta a leitura de algum serviço rodando que a tinha na volta anterior fica fora da soma
 * ("sem dados"), em vez de um total menor que o real.
 */
export function sumContainerSamples(samples: ContainerSampleValues[], known?: ReadonlyArray<ReadonlySet<string> | null>): ContainerSampleValues {
  const out: ContainerSampleValues = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s) as Array<[ContainerMetricId, number]>) {
      if (k === "memLimit" || k === "cpuLimit" || k === "cpuThrottle") continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  // throttling: o pior serviço (somar percentuais não faz sentido)
  const throttles = samples.map((s) => s.cpuThrottle).filter((v): v is number => v !== undefined);
  if (throttles.length > 0) out.cpuThrottle = Math.max(...throttles);
  if (samples.length > 0 && samples.every((s) => s.cpuLimit !== undefined)) {
    out.cpuLimit = samples.reduce((sum, s) => sum + (s.cpuLimit ?? 0), 0);
  }
  for (const k of SUMMED_READINGS) {
    // `known` = o que cada serviço tinha na volta anterior: serviço que NUNCA tem a medida (sem E/S de bloco,
    // rede "none") não apaga a soma do projeto; só a que sumiu neste minuto. Sem `known`, qualquer falta vale.
    if (samples.some((s, i) => s.up === 1 && s[k] === undefined && (known === undefined || known[i]?.has(k) === true))) delete out[k];
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
