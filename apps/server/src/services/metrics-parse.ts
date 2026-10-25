/**
 * metrics-parse.ts — leitura (parse) dos arquivos do kernel e dos cgroups. Só
 * funções puras: recebem TEXTO e devolvem números, ou null quando o texto não
 * é o que se esperava ("sem dados", nunca zero inventado).
 *
 * O texto vem de /proc e /sys (o kernel, não o usuário), mas é tratado como
 * externo mesmo assim: tamanho e número de linhas têm teto, e nenhuma
 * expressão regular roda sobre o texto inteiro — só sobre campos já separados
 * e curtos, ou com formato linear.
 */

/** Texto maior que isto é cortado antes de qualquer análise (diskstats de um servidor grande tem dezenas de KB). */
export const MAX_PROC_TEXT = 1_048_576;
/** Linhas analisadas por arquivo. */
export const MAX_PROC_LINES = 20_000;

/** Linhas do texto, com tetos de tamanho e de quantidade. Sem regex. */
export function procLines(text: string): string[] {
  const t = text.length > MAX_PROC_TEXT ? text.slice(0, MAX_PROC_TEXT) : text;
  const out: string[] = [];
  let at = 0;
  while (at < t.length && out.length < MAX_PROC_LINES) {
    let nl = t.indexOf("\n", at);
    if (nl === -1) nl = t.length;
    out.push(t.slice(at, nl));
    at = nl + 1;
  }
  return out;
}

/** Campos separados por espaço ou tab (vários seguidos contam como um). */
function fields(line: string): string[] {
  return line.split(/[ \t]+/).filter((f) => f !== "");
}

/** Inteiro não negativo e seguro, ou null. */
function uint(s: string | undefined): number | null {
  if (s === undefined || s === "" || s.length > 20 || !/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decimal não negativo, ou null. */
function decimal(s: string | undefined): number | null {
  if (s === undefined || s === "" || s.length > 24 || !/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// /proc/stat
// ---------------------------------------------------------------------------

/** Tempos acumulados da CPU em jiffies (1/100 s). */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface ProcStat {
  /** Linha "cpu" (soma de todos os núcleos); null se ilegível. */
  cpu: CpuTimes | null;
  /** Quantidade de linhas "cpuN". */
  cores: number;
  /** Hora do boot (epoch em segundos), se o arquivo informa. */
  btime: number | null;
}

export function parseProcStat(text: string): ProcStat {
  let cpu: CpuTimes | null = null;
  let cores = 0;
  let btime: number | null = null;
  for (const line of procLines(text)) {
    if (line.startsWith("cpu ")) {
      const f = fields(line);
      // user nice system idle iowait irq softirq steal (guest já está dentro de user)
      const n = f.slice(1, 9).map(uint);
      // kernels antigos não têm steal/iowait: os campos que faltam valem 0; os que vierem estragados invalidam
      if (n.length >= 4 && n.every((v) => v !== null) && f.length <= 12) {
        const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = n as number[];
        cpu = { user: user!, nice: nice!, system: system!, idle: idle!, iowait, irq, softirq, steal };
      }
    } else if (/^cpu[0-9]+ /.test(line.slice(0, 12))) {
      cores++;
    } else if (line.startsWith("btime ")) {
      btime = uint(fields(line)[1]);
    }
  }
  return { cpu, cores, btime };
}

// ---------------------------------------------------------------------------
// /proc/meminfo
// ---------------------------------------------------------------------------

export interface MemInfo {
  totalBytes: number;
  /** MemAvailable; sem ele (kernel antigo), a estimativa livre + buffers + cache. */
  availBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export function parseMeminfo(text: string): MemInfo | null {
  const kb: Record<string, number> = {};
  for (const line of procLines(text)) {
    const colon = line.indexOf(":");
    if (colon <= 0 || colon > 32) continue;
    const key = line.slice(0, colon);
    if (key !== "MemTotal" && key !== "MemAvailable" && key !== "MemFree" && key !== "Buffers" && key !== "Cached" && key !== "SwapTotal" && key !== "SwapFree") continue;
    const v = uint(fields(line.slice(colon + 1))[0]);
    if (v !== null) kb[key] = v;
  }
  if (kb.MemTotal === undefined || kb.MemTotal <= 0) return null;
  let avail = kb.MemAvailable;
  if (avail === undefined) {
    if (kb.MemFree === undefined) return null;
    avail = kb.MemFree + (kb.Buffers ?? 0) + (kb.Cached ?? 0);
  }
  const swapTotal = kb.SwapTotal ?? 0;
  const swapFree = Math.min(kb.SwapFree ?? 0, swapTotal);
  return {
    totalBytes: kb.MemTotal * 1024,
    availBytes: Math.min(avail, kb.MemTotal) * 1024,
    swapTotalBytes: swapTotal * 1024,
    swapFreeBytes: swapFree * 1024,
  };
}

// ---------------------------------------------------------------------------
// /proc/vmstat, /proc/loadavg, /proc/uptime, /proc/pressure/*
// ---------------------------------------------------------------------------

export interface VmStat {
  swapIn: number | null;
  swapOut: number | null;
  /** Processos mortos por falta de memória desde o boot (kernel 4.13+). */
  oomKill: number | null;
}

export function parseVmstat(text: string): VmStat {
  const out: VmStat = { swapIn: null, swapOut: null, oomKill: null };
  for (const line of procLines(text)) {
    if (!line.startsWith("pswp") && !line.startsWith("oom_kill")) continue;
    const f = fields(line);
    if (f[0] === "pswpin") out.swapIn = uint(f[1]);
    else if (f[0] === "pswpout") out.swapOut = uint(f[1]);
    else if (f[0] === "oom_kill") out.oomKill = uint(f[1]);
  }
  return out;
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const f = fields(procLines(text)[0] ?? "");
  const a = decimal(f[0]);
  const b = decimal(f[1]);
  const c = decimal(f[2]);
  return a === null || b === null || c === null ? null : [a, b, c];
}

export function parseUptime(text: string): number | null {
  return decimal(fields(procLines(text)[0] ?? "")[0]);
}

/** Pressão (PSI): média de 60 s do tempo "some" (alguém esperou), em %. */
export function parsePressure(text: string): { some60: number; full60: number | null } | null {
  let some: number | null = null;
  let full: number | null = null;
  for (const line of procLines(text)) {
    const f = fields(line);
    const avg60 = f.find((x) => x.startsWith("avg60="));
    if (avg60 === undefined) continue;
    const v = decimal(avg60.slice(6));
    if (f[0] === "some") some = v;
    else if (f[0] === "full") full = v;
  }
  return some === null ? null : { some60: some, full60: full };
}

// ---------------------------------------------------------------------------
// /proc/net/dev, /proc/diskstats
// ---------------------------------------------------------------------------

export interface NetCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
}

export function parseNetDev(text: string): NetCounters[] {
  const out: NetCounters[] = [];
  for (const line of procLines(text)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // cabeçalhos não têm ":" antes dos números
    const name = line.slice(0, colon).trim();
    if (name === "" || name.length > 32 || name.includes(" ")) continue;
    const f = fields(line.slice(colon + 1));
    // rx: bytes packets errs drop fifo frame compressed multicast | tx: bytes ...
    const rx = uint(f[0]);
    const tx = uint(f[8]);
    if (rx === null || tx === null) continue;
    out.push({ name, rxBytes: rx, txBytes: tx });
  }
  return out;
}

/** Interfaces que não são a saída para fora da VPS (loopback, pontes e pares virtuais do Docker, túneis: o tráfego deles já passa pela placa real e somaria em dobro). */
export function isVirtualInterface(name: string): boolean {
  if (name === "lo") return true;
  return ["docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "tun", "tap", "dummy", "vxlan", "kube", "wg", "tailscale", "zt"].some((p) => name.startsWith(p));
}

export interface DiskCounters {
  name: string;
  readBytes: number;
  writeBytes: number;
  /** Tempo acumulado com o disco ocupado, em ms. */
  busyMs: number;
}

/** Disco inteiro (não partição nem loop/ram/dm): sdX, vdX, xvdX, nvmeXnY, mmcblkX. */
export function isWholeDisk(name: string): boolean {
  if (name.length > 32) return false;
  return /^(sd[a-z]{1,3}|vd[a-z]{1,3}|xvd[a-z]{1,3}|hd[a-z]|nvme[0-9]{1,3}n[0-9]{1,3}|mmcblk[0-9]{1,3})$/.test(name);
}

export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of procLines(text)) {
    const f = fields(line);
    const name = f[2];
    if (name === undefined || !isWholeDisk(name)) continue;
    const rs = uint(f[5]);
    const ws = uint(f[9]);
    const busy = uint(f[12]);
    if (rs === null || ws === null || busy === null) continue;
    out.push({ name, readBytes: rs * 512, writeBytes: ws * 512, busyMs: busy });
  }
  return out;
}

// ---------------------------------------------------------------------------
// cgroup v2
// ---------------------------------------------------------------------------

/** "chave número" por linha (cpu.stat, memory.stat, memory.events). Chaves repetidas: vale a última. */
export function parseKeyValue(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of procLines(text)) {
    const sp = line.indexOf(" ");
    if (sp <= 0 || sp > 64) continue;
    const v = uint(line.slice(sp + 1).trim());
    if (v !== null) out[line.slice(0, sp)] = v;
  }
  return out;
}

/** Arquivo de um número só (memory.current). "max" e o que não for número viram null. */
export function parseSingleNumber(text: string): number | null {
  return uint(procLines(text)[0]?.trim());
}

/** io.stat: soma de rbytes e wbytes de todos os dispositivos. */
export function parseIoStat(text: string): { readBytes: number; writeBytes: number } | null {
  let read = 0;
  let write = 0;
  let seen = false;
  for (const line of procLines(text)) {
    for (const f of fields(line)) {
      if (f.startsWith("rbytes=")) {
        const v = uint(f.slice(7));
        if (v !== null) {
          read += v;
          seen = true;
        }
      } else if (f.startsWith("wbytes=")) {
        const v = uint(f.slice(7));
        if (v !== null) {
          write += v;
          seen = true;
        }
      }
    }
  }
  return seen ? { readBytes: read, writeBytes: write } : null;
}

// ---------------------------------------------------------------------------
// Docker API: GET /containers/:id/stats?stream=false&one-shot=true
// ---------------------------------------------------------------------------

export interface DockerStatsRaw {
  /** CPU acumulada do container em microssegundos. */
  cpuUsec: number | null;
  memWorkingBytes: number | null;
  memLimitBytes: number | null;
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Resposta de stats da API do Docker → contadores no mesmo formato dos cgroups. */
export function parseDockerStats(doc: unknown): DockerStatsRaw {
  const d = obj(doc);
  const cpuNs = nonNeg(obj(obj(d.cpu_stats).cpu_usage).total_usage);
  const mem = obj(d.memory_stats);
  const usage = nonNeg(mem.usage);
  const stats = obj(mem.stats);
  // cgroup v2 informa inactive_file; v1, total_inactive_file
  const inactive = nonNeg(stats.inactive_file) ?? nonNeg(stats.total_inactive_file) ?? 0;
  const limit = nonNeg(mem.limit);
  let read: number | null = null;
  let write: number | null = null;
  const blk = obj(d.blkio_stats).io_service_bytes_recursive;
  if (Array.isArray(blk)) {
    for (const e of blk.slice(0, 256)) {
      const op = String(obj(e).op).toLowerCase();
      const v = nonNeg(obj(e).value);
      if (v === null) continue;
      if (op === "read") read = (read ?? 0) + v;
      else if (op === "write") write = (write ?? 0) + v;
    }
  }
  let rx: number | null = null;
  let tx: number | null = null;
  for (const n of Object.values(obj(d.networks)).slice(0, 64)) {
    const a = nonNeg(obj(n).rx_bytes);
    const b = nonNeg(obj(n).tx_bytes);
    if (a !== null) rx = (rx ?? 0) + a;
    if (b !== null) tx = (tx ?? 0) + b;
  }
  return {
    cpuUsec: cpuNs === null ? null : Math.floor(cpuNs / 1000),
    memWorkingBytes: usage === null ? null : Math.max(0, usage - inactive),
    memLimitBytes: limit,
    ioReadBytes: read,
    ioWriteBytes: write,
    netRxBytes: rx,
    netTxBytes: tx,
  };
}
