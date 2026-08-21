import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import {
  HEALTH_LIMITS,
  type DiskInfo,
  type HealthCheck,
  type HealthScanResult,
  type NetworkInfo,
  type OsInfo,
} from "@paas/core";

/**
 * Varredura de saúde da máquina.
 * Usa apenas o módulo `os` do Node e leitura de arquivos em /proc, /sys e /etc —
 * nenhum shell arbitrário é executado.
 */

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

async function readNetworkInfo(): Promise<NetworkInfo> {
  const interfaces: NetworkInfo["interfaces"] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const addresses = (addrs ?? [])
      .filter((a) => !a.internal)
      // Node já retorna `cidr` no formato "endereço/prefixo" para IPv6
      .map((a) => (a.family === "IPv6" ? (a.cidr ?? a.address) : a.address));
    if (addresses.length > 0) interfaces.push({ name, addresses });
  }
  const publicIp = await fetchPublicIp();
  return { publicIp, interfaces };
}

function buildChecks(osInfo: OsInfo, memTotal: number, disk: DiskInfo): HealthScanResult["checks"] {
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
      : { level: "warning", message: "Menos de 1 GiB de RAM — recomendado ampliar antes de hospedar projetos." };

  const diskCheck: HealthCheck =
    disk.freeBytes >= HEALTH_LIMITS.minFreeDiskBytes
      ? { level: "ok", message: "Espaço livre suficiente (mínimo: 10 GiB)." }
      : { level: "warning", message: "Menos de 10 GiB livres no disco raiz — imagens Docker consomem espaço rápido." };

  return { os: osCheck, memory: memCheck, disk: diskCheck };
}

export async function scanSystemHealth(): Promise<HealthScanResult> {
  const cpus = os.cpus();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  const [osInfo, diskStat, network, virtualization] = await Promise.all([
    readOsInfo(),
    statfs("/"),
    readNetworkInfo(),
    detectVirtualization(),
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
    checks: buildChecks(osInfo, totalBytes, disk),
  };
}
