/**
 * metrics-sources.ts — leitura dos arquivos do kernel (host e cgroups).
 *
 * Segurança: só caminhos FIXOS, montados a partir de uma raiz de configuração e
 * de um id/PID que o próprio painel obteve do Docker e validou (hexadecimal / inteiro).
 * Nunca se lê cmdline, environ, maps, nem qualquer arquivo de processo que possa
 * trazer segredo — a montagem do /proc do host dá visão de tudo, e o código se
 * limita ao que está listado aqui.
 *
 * Cada arquivo é lido com teto de bytes. Arquivo ausente, sem permissão ou
 * estranho vira null ("sem dados"), nunca exceção: a falha de uma métrica não
 * derruba a coleta.
 */
import { open } from "node:fs/promises";
import type { HostRaw, ContainerRaw } from "./metrics-compute.js";
import {
  isVirtualInterface,
  parseDiskstats,
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
  type DockerStatsRaw,
} from "./metrics-parse.js";

/** Teto de bytes por arquivo lido (diskstats grande tem dezenas de KB). */
export const READ_MAX_BYTES = 512 * 1024;
/** Tamanho de cada bloco lido (a maioria dos arquivos cabe em um). */
export const READ_CHUNK_BYTES = 16 * 1024;

export type ReadText = (file: string) => Promise<string | null>;

/** Lê um arquivo de texto com teto de bytes; qualquer erro vira null. */
export const readText: ReadText = async (file) => {
  let handle;
  try {
    handle = await open(file, "r");
    // Blocos pequenos até o fim (ou o teto): quase todo arquivo de /proc e de cgroup tem poucos KB, e
    // alocar o teto inteiro a cada leitura custava mais CPU que o resto da coleta. /proc não informa o
    // tamanho (stat dá 0), então lê até acabar.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < READ_MAX_BYTES) {
      const want = Math.min(READ_CHUNK_BYTES, READ_MAX_BYTES - total);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buf, 0, want, total);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export type StatFs = (path: string) => Promise<{ blocks: number; bsize: number; bavail: number; files: number; ffree: number }>;

export interface HostSourceOptions {
  /** /proc do host montado no container (ex.: /host/proc). */
  mountedProc: string;
  /** /proc do próprio container (já é do host nos arquivos globais, mas não a rede). */
  ownProc: string;
  dataDir: string;
  read: ReadText;
  statfs: StatFs;
}

export type HostSource = "mounted" | "container" | "none";

export class HostSampler {
  constructor(private readonly o: HostSourceOptions) {}

  /** Lê tudo de uma vez. `raw` null = nem o /proc do container pôde ser lido. */
  async read(): Promise<{ raw: HostRaw | null; source: HostSource }> {
    let root = this.o.mountedProc;
    let source: HostSource = "mounted";
    let stat = await this.o.read(`${root}/stat`);
    if (stat === null) {
      root = this.o.ownProc;
      source = "container";
      stat = await this.o.read(`${root}/stat`);
    }
    if (stat === null) return { raw: null, source: "none" };
    const get = (name: string) => this.o.read(`${root}/${name}`);
    const [meminfo, vmstat, loadavg, uptime, diskstats, pCpu, pMem, pIo, net, fs] = await Promise.all([
      get("meminfo"),
      get("vmstat"),
      get("loadavg"),
      get("uptime"),
      get("diskstats"),
      get("pressure/cpu"),
      get("pressure/memory"),
      get("pressure/io"),
      // a rede do host só existe pelo /proc montado: o /proc/net/dev do container é o da rede dele
      source === "mounted" ? this.o.read(`${root}/1/net/dev`) : Promise.resolve(null),
      this.fs(),
    ]);
    const ps = parseProcStat(stat);
    const some = (t: string | null) => (t === null ? null : (parsePressure(t)?.some60 ?? null));
    return {
      source,
      raw: {
        cpu: ps.cpu,
        cores: ps.cores > 0 ? ps.cores : null,
        load: loadavg === null ? null : parseLoadavg(loadavg),
        mem: meminfo === null ? null : parseMeminfo(meminfo),
        vm: vmstat === null ? null : parseVmstat(vmstat),
        psi: { cpu: some(pCpu), mem: some(pMem), io: some(pIo) },
        disks: diskstats === null ? null : parseDiskstats(diskstats),
        net: net === null ? null : parseNetDev(net),
        uptime: uptime === null ? null : parseUptime(uptime),
        fs,
      },
    };
  }

  private async fs(): Promise<HostRaw["fs"]> {
    try {
      const s = await this.o.statfs(this.o.dataDir);
      const total = s.blocks * s.bsize;
      if (!(total > 0)) return null;
      return { totalBytes: total, freeBytes: s.bavail * s.bsize, inodePct: s.files > 0 ? (1 - s.ffree / s.files) * 100 : null };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface ContainerSourceOptions {
  /** /sys/fs/cgroup do host montado (ex.: /host/sys/fs/cgroup). */
  cgroupRoot: string;
  /** /proc do host montado, para a rede do container pelo PID dele. */
  procRoot: string;
  read: ReadText;
  /** Reserva: estatísticas pela API do Docker. */
  stats: (id: string) => Promise<DockerStatsRaw | null>;
}

export type ContainerVia = "cgroup" | "api" | "none";

const ID_RE = /^[0-9a-f]{12,64}$/;

export class ContainerReader {
  private v2: boolean | null = null;
  /** Pasta do cgroup de cada container já achada (id → pasta). */
  private readonly dirs = new Map<string, string>();

  constructor(private readonly o: ContainerSourceOptions) {}

  /** O cgroup v2 do host está montado e legível? Conferido de novo a cada coleta (a montagem pode aparecer depois de recriar o container). */
  async refresh(): Promise<boolean> {
    this.v2 = (await this.o.read(`${this.o.cgroupRoot}/cgroup.controllers`)) !== null;
    return this.v2;
  }

  /** Esquece containers que não existem mais (a memória não cresce com o tempo). */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.dirs.keys()) if (!ids.has(id)) this.dirs.delete(id);
  }

  private async findDir(id: string): Promise<string | null> {
    const known = this.dirs.get(id);
    if (known !== undefined && (await this.o.read(`${known}/memory.current`)) !== null) return known;
    this.dirs.delete(id);
    // systemd (padrão do Ubuntu) e cgroupfs
    for (const dir of [`${this.o.cgroupRoot}/system.slice/docker-${id}.scope`, `${this.o.cgroupRoot}/docker/${id}`]) {
      if ((await this.o.read(`${dir}/memory.current`)) !== null) {
        this.dirs.set(id, dir);
        return dir;
      }
    }
    return null;
  }

  /**
   * Contadores de UM container. `pid` (do inspect) só serve à rede. `hostMemTotal`
   * descarta o "limite" que o Docker mostra quando o container não tem limite.
   */
  async read(id: string, pid: number | null, hostMemTotal: number | null): Promise<{ raw: ContainerRaw | null; via: ContainerVia }> {
    if (!ID_RE.test(id)) return { raw: null, via: "none" };
    if (this.v2 === true) {
      const raw = await this.fromCgroup(id, pid);
      if (raw) return { raw, via: "cgroup" };
    }
    const s = await this.o.stats(id);
    if (!s) return { raw: null, via: "none" };
    const limit = s.memLimitBytes !== null && hostMemTotal !== null && s.memLimitBytes >= hostMemTotal * 0.98 ? null : s.memLimitBytes;
    return {
      via: "api",
      raw: {
        cpuUsec: s.cpuUsec,
        memWorkingBytes: s.memWorkingBytes,
        memLimitBytes: limit,
        ioReadBytes: s.ioReadBytes,
        ioWriteBytes: s.ioWriteBytes,
        netRxBytes: s.netRxBytes,
        netTxBytes: s.netTxBytes,
        oomKills: null,
      },
    };
  }

  private async fromCgroup(id: string, pid: number | null): Promise<ContainerRaw | null> {
    const dir = await this.findDir(id);
    if (dir === null) return null;
    const [cpuStat, current, max, memStat, events, io, net] = await Promise.all([
      this.o.read(`${dir}/cpu.stat`),
      this.o.read(`${dir}/memory.current`),
      this.o.read(`${dir}/memory.max`),
      this.o.read(`${dir}/memory.stat`),
      this.o.read(`${dir}/memory.events`),
      this.o.read(`${dir}/io.stat`),
      pid !== null && Number.isSafeInteger(pid) && pid > 0 ? this.o.read(`${this.o.procRoot}/${pid}/net/dev`) : Promise.resolve(null),
    ]);
    const cur = current === null ? null : parseSingleNumber(current);
    const inactive = memStat === null ? 0 : (parseKeyValue(memStat).inactive_file ?? 0);
    const ioStat = io === null ? null : parseIoStat(io);
    let rx: number | null = null;
    let tx: number | null = null;
    if (net !== null) {
      const real = parseNetDev(net).filter((n) => !isVirtualInterface(n.name));
      if (real.length > 0) {
        rx = real.reduce((s, n) => s + n.rxBytes, 0);
        tx = real.reduce((s, n) => s + n.txBytes, 0);
      }
    }
    return {
      cpuUsec: cpuStat === null ? null : (parseKeyValue(cpuStat).usage_usec ?? null),
      memWorkingBytes: cur === null ? null : Math.max(0, cur - inactive),
      memLimitBytes: max === null ? null : parseSingleNumber(max),
      ioReadBytes: ioStat?.readBytes ?? null,
      ioWriteBytes: ioStat?.writeBytes ?? null,
      netRxBytes: rx,
      netTxBytes: tx,
      oomKills: events === null ? null : (parseKeyValue(events).oom_kill ?? null),
    };
  }
}
