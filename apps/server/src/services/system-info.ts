import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import {
  HEALTH_LIMITS,
  type DiskInfo,
  type HealthCheck,
  type HealthScanResult,
  type NetworkInfo,
  type OsInfo,
  type RebootInfo,
} from "@paas/core";

/**
 * Varredura de saúde da máquina.
 *
 * O painel roda DENTRO de um container. Por isso cada dado tem uma origem
 * escolhida de propósito:
 *  - módulo `os`, /proc e /sys: só para o que o kernel compartilha com o
 *    container (CPU, carga, memória total, uptime, DMI da virtualização);
 *  - /host/etc (montado no compose): nome e versão do SO e hostname da VPS;
 *  - `hostProbe`: comandos FIXOS e somente-leitura executados NO HOST (pelo
 *    terminal do servidor) para o que o container não enxerga — interfaces
 *    de rede e reinicialização pendente. Sem `hostProbe` (ou se ele falhar),
 *    esses itens saem como "não verificado", nunca com dado do container.
 */

/** Resultado de um comando somente-leitura executado no host. */
export interface HostProbeResult {
  code: number;
  output: string;
}

/**
 * Executa um dos comandos fixos abaixo NO HOST e devolve a saída. Deve
 * rejeitar quando o host não estiver acessível.
 */
export type HostProbe = (cmd: string) => Promise<HostProbeResult>;

export interface ScanOptions {
  hostProbe?: HostProbe | undefined;
}

/** Interfaces globais da VPS (IPv4 e IPv6), uma por linha. */
export const HOST_NETWORK_COMMAND = "ip -o addr show scope global";

/** Marcador de reinicialização pendente do Ubuntu, com a lista de pacotes. */
export const HOST_REBOOT_COMMAND =
  "if [ -f /var/run/reboot-required ]; then echo PAAS_REBOOT=1; cat /var/run/reboot-required.pkgs 2>/dev/null; else echo PAAS_REBOOT=0; fi; true";

function parseOsRelease(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
    if (match && match[1] !== undefined && match[3] !== undefined) {
      out[match[1]] = match[3];
    }
  }
  return out;
}

async function readFirst(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // tenta o próximo caminho
    }
  }
  return null;
}

async function readOsInfo(): Promise<OsInfo> {
  let osRelease: Record<string, string> = {};
  // Em container, /host/etc/os-release (montado via compose) reflete a VPS
  // real; /etc/os-release local é o da imagem (Debian) — fica como fallback.
  const osReleaseRaw = await readFirst(["/host/etc/os-release", "/etc/os-release"]);
  if (osReleaseRaw !== null) {
    osRelease = parseOsRelease(osReleaseRaw);
  }
  const hostName = (await readFirst(["/host/etc/hostname"]))?.trim();
  return {
    prettyName: osRelease["PRETTY_NAME"] ?? os.platform(),
    id: osRelease["ID"] ?? "unknown",
    versionId: osRelease["VERSION_ID"] ?? "unknown",
    kernel: os.release(),
    arch: os.arch(),
    hostname: hostName ?? os.hostname(),
  };
}

/** Detecta virtualização lendo /sys e /proc (sem executar comandos). */
async function detectVirtualization(): Promise<string> {
  try {
    const product = (await readFile("/sys/class/dmi/id/product_name", "utf8")).trim().toLowerCase();
    const known: Array<[string, string]> = [
      // Nomes de máquina padrão do QEMU (i440fx e q35), usados pelo KVM —
      // o DMI deles não contém "kvm" nem "qemu".
      ["standard pc (i440fx", "KVM/QEMU"],
      ["standard pc (q35", "KVM/QEMU"],
      ["kvm", "KVM"],
      ["qemu", "QEMU"],
      ["virtualbox", "VirtualBox"],
      ["vmware", "VMware"],
      ["microsoft corporation virtual", "Hyper-V"],
      ["xen", "Xen"],
      ["bhyve", "bhyve"],
      ["amazon ec2", "AWS EC2"],
      ["google", "Google Cloud"],
      ["openstack", "OpenStack"],
    ];
    for (const [needle, label] of known) {
      if (product.includes(needle)) return label;
    }
    if (product.length > 0) {
      // produto desconhecido: confirma se há flag de hypervisor na CPU
      const cpuinfo = await readFile("/proc/cpuinfo", "utf8").catch(() => "");
      return cpuinfo.includes("hypervisor") ? `genérico (${product})` : "nenhuma (bare metal)";
    }
  } catch {
    // /sys indisponível (container, macOS, etc.)
  }
  try {
    const cpuinfo = await readFile("/proc/cpuinfo", "utf8");
    if (cpuinfo.includes("hypervisor")) return "genérica (flag hypervisor presente)";
  } catch {
    // ignora
  }
  return "nenhuma (bare metal)";
}

const IPV4_OR_V6 = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

async function fetchPublicIp(): Promise<string | null> {
  const providers = ["https://api.ipify.org", "https://ifconfig.me/ip"];
  for (const url of providers) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (ip.length <= 45 && IPV4_OR_V6.test(ip)) return ip;
    } catch {
      // tenta o próximo provedor
    }
  }
  return null;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function outputLines(output: string): string[] {
  return output
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, "").trim())
    .filter((l) => l.length > 0);
}

/** Executa no host; qualquer falha (terminal indisponível, timeout) vira null. */
async function probe(hostProbe: HostProbe | undefined, cmd: string): Promise<HostProbeResult | null> {
  if (!hostProbe) return null;
  try {
    return await hostProbe(cmd);
  } catch {
    return null;
  }
}

/**
 * Pontes criadas pelo próprio Docker no host (docker0, br-<id>, veth*):
 * existem na VPS, mas são redes internas dos containers — mostrá-las ao lado
 * do eth0 confundiria o operador exatamente como o IP do container confundia.
 */
const DOCKER_IFACE_RE = /^(?:docker\d*|br-[0-9a-f]+|veth[0-9a-z]*)$/i;

/** Linha do `ip -o addr`: "2: eth0    inet 203.0.113.7/24 brd ... scope global eth0". */
const IP_ADDR_LINE_RE = /^\d+:\s+([^\s:@]+)(?:@\S+)?:?\s+inet6?\s+(\S+)/;

async function readHostInterfaces(
  hostProbe: HostProbe | undefined,
): Promise<Pick<NetworkInfo, "interfaces" | "interfacesSource">> {
  const result = await probe(hostProbe, HOST_NETWORK_COMMAND);
  if (result === null || result.code !== 0) {
    return { interfaces: [], interfacesSource: "unavailable" };
  }
  const byName = new Map<string, string[]>();
  for (const line of outputLines(result.output)) {
    const match = IP_ADDR_LINE_RE.exec(line);
    if (!match) continue;
    const [, name, address] = match as unknown as [string, string, string];
    if (DOCKER_IFACE_RE.test(name)) continue;
    const list = byName.get(name) ?? [];
    if (!list.includes(address)) list.push(address);
    byName.set(name, list);
  }
  return {
    interfaces: [...byName].map(([name, addresses]) => ({ name, addresses })),
    interfacesSource: "host",
  };
}

async function readNetworkInfo(hostProbe: HostProbe | undefined): Promise<NetworkInfo> {
  const [publicIp, host] = await Promise.all([fetchPublicIp(), readHostInterfaces(hostProbe)]);
  return { publicIp, ...host };
}

async function readRebootInfo(hostProbe: HostProbe | undefined): Promise<RebootInfo> {
  const result = await probe(hostProbe, HOST_REBOOT_COMMAND);
  if (result === null || result.code !== 0) return { pending: null, packages: [] };
  const lines = outputLines(result.output);
  const flagIndex = lines.findIndex((l) => l === "PAAS_REBOOT=1" || l === "PAAS_REBOOT=0");
  if (flagIndex === -1) return { pending: null, packages: [] };
  if (lines[flagIndex] === "PAAS_REBOOT=0") return { pending: false, packages: [] };
  const packages = [...new Set(lines.slice(flagIndex + 1))];
  return { pending: true, packages };
}

/**
 * Tetos abaixo dos quais a máquina não consegue, na prática, hospedar
 * projetos — não é mais "recomendado ampliar", é "não vai funcionar":
 * RAM insuficiente para o daemon Docker + containers derruba tudo por OOM,
 * e disco quase cheio faz `docker pull`/`build` falhar de cara. Ficam bem
 * abaixo dos mínimos de warning (1 GiB RAM / 10 GiB disco) de propósito —
 * o nível `critical` é para quando hospedar já é inviável, não apertado.
 */
const CRITICAL_MIN_RAM_BYTES = 512 * 1024 ** 2; // 512 MiB
const CRITICAL_MIN_FREE_DISK_BYTES = 1 * 1024 ** 3; // 1 GiB

interface ChecksInput {
  osInfo: OsInfo;
  cpuCores: number;
  memTotal: number;
  disk: DiskInfo;
  network: NetworkInfo;
  reboot: RebootInfo;
}

function buildChecks({ osInfo, cpuCores, memTotal, disk, network, reboot }: ChecksInput): HealthScanResult["checks"] {
  const supported =
    (HEALTH_LIMITS.supportedDistroIds as readonly string[]).includes(osInfo.id) &&
    (HEALTH_LIMITS.supportedVersionIds as readonly string[]).includes(osInfo.versionId);

  const osCheck: HealthCheck = supported
    ? { level: "ok", message: `${osInfo.prettyName} é suportado.` }
    : {
        level: "warning",
        message: `${osInfo.prettyName} não é um SO oficialmente suportado (esperado Ubuntu 22.04/24.04).`,
      };

  const memCheck: HealthCheck =
    memTotal >= HEALTH_LIMITS.minRamBytes
      ? { level: "ok", message: "Memória suficiente (mínimo: 1 GiB)." }
      : memTotal >= CRITICAL_MIN_RAM_BYTES
        ? { level: "warning", message: "Menos de 1 GiB de RAM — recomendado ampliar antes de hospedar projetos." }
        : {
            level: "critical",
            message: "Menos de 512 MiB de RAM — insuficiente para rodar o Docker e hospedar projetos.",
          };

  const diskCheck: HealthCheck =
    disk.freeBytes >= HEALTH_LIMITS.minFreeDiskBytes
      ? { level: "ok", message: "Espaço livre suficiente (mínimo: 10 GiB)." }
      : disk.freeBytes >= CRITICAL_MIN_FREE_DISK_BYTES
        ? { level: "warning", message: "Menos de 10 GiB livres no disco raiz — imagens Docker consomem espaço rápido." }
        : {
            level: "critical",
            message: "Menos de 1 GiB livre no disco raiz — builds e pulls de imagem vão falhar.",
          };

  // Mesmo mínimo do README (1 vCPU). O container enxerga todos os núcleos da
  // VPS (o compose não limita CPU). Com o mínimo em 1, ficar abaixo dele só
  // acontece quando a contagem veio zerada — ou seja, não foi possível ler, o
  // que é "não verificado", não "insuficiente".
  const cpuCheck: HealthCheck =
    cpuCores >= HEALTH_LIMITS.minCpuCores
      ? { level: "ok", message: `Núcleos suficientes (mínimo recomendado: ${HEALTH_LIMITS.minCpuCores} vCPU).` }
      : { level: "unknown", message: "Não verificado: não foi possível contar os núcleos da CPU." };

  // Sem IP público alcançável, os domínios apontados para a VPS não chegam
  // ao painel nem aos projetos — isso muda algo real para o operador.
  const networkCheck: HealthCheck =
    network.publicIp !== null
      ? { level: "ok", message: "IP público detectado." }
      : {
          level: "warning",
          message:
            "IP público não detectado — sem ele os domínios não chegam a esta VPS. Verifique se ela tem acesso à internet.",
        };

  const rebootCheck: HealthCheck =
    reboot.pending === null
      ? {
          level: "unknown",
          message: "Não verificado: o painel não conseguiu ler a VPS para saber se há reinicialização pendente.",
        }
      : reboot.pending
        ? {
            level: "warning",
            message:
              "Reinicialização pendente: atualizações do sistema só passam a valer depois de reiniciar. " +
              "No terminal da VPS, rode o comando sudo reboot, espere cerca de 1 minuto e recarregue esta página " +
              "(se tiver fechado a aba, abra de novo o link com o token). " +
              "O painel volta sozinho e o assistente continua da etapa em que parou.",
          }
        : { level: "ok", message: "Nenhuma reinicialização pendente." };

  return {
    os: osCheck,
    cpu: cpuCheck,
    memory: memCheck,
    disk: diskCheck,
    network: networkCheck,
    reboot: rebootCheck,
  };
}

export async function scanSystemHealth(options: ScanOptions = {}): Promise<HealthScanResult> {
  const cpus = os.cpus();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  // Os dois probes no host rodam em sequência de qualquer forma (o terminal
  // é um só); o resto é lido em paralelo.
  const hostProbe = options.hostProbe;
  const [osInfo, diskStat, network, virtualization, reboot] = await Promise.all([
    readOsInfo(),
    statfs("/"),
    readNetworkInfo(hostProbe),
    detectVirtualization(),
    readRebootInfo(hostProbe),
  ]);

  const diskTotal = diskStat.blocks * diskStat.bsize;
  const diskFree = diskStat.bavail * diskStat.bsize;
  const disk: DiskInfo = {
    mount: "/",
    totalBytes: diskTotal,
    freeBytes: diskFree,
    usedBytes: diskTotal - diskFree,
  };

  const load = os.loadavg();
  return {
    scannedAt: new Date().toISOString(),
    os: osInfo,
    cpu: {
      model: cpus[0]?.model.trim() ?? "desconhecido",
      cores: cpus.length,
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    },
    memory: {
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
    },
    disk,
    network,
    virtualization,
    uptimeSeconds: Math.floor(os.uptime()),
    reboot,
    checks: buildChecks({ osInfo, cpuCores: cpus.length, memTotal: totalBytes, disk, network, reboot }),
  };
}
