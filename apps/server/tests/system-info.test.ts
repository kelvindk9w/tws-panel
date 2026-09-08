/**
 * system-info.ts — o retrato da máquina que o operador vê antes de decidir se
 * a VPS dele serve para rodar o painel.
 *
 * O teste de rota (routes-health.test.ts) mede o HOST REAL e por isso só
 * consegue exercitar a faixa em que a máquina de teste calha de estar. Aqui a
 * máquina é simulada (os, /proc, /sys, /etc e a consulta de IP público são
 * substituídos), justamente para provar o que o dono de uma VPS pequena vai
 * ler: os avisos e os alertas críticos de memória e de disco.
 *
 * Nada de números mágicos: as faixas são derivadas de HEALTH_LIMITS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIMITS } from "@paas/core";

/** Máquina simulada — cada teste reescreve só o que lhe interessa. */
const maquina = vi.hoisted(() => ({
  arquivos: new Map<string, string>(),
  totalmem: 0,
  freemem: 0,
  cpus: [] as Array<{ model: string }>,
  loadavg: [] as number[],
  interfaces: {} as Record<string, Array<Record<string, unknown>> | undefined>,
  uptime: 0,
  platform: "linux",
  release: "6.8.0-generic",
  arch: "x64",
  hostname: "hostname-do-node",
  discoTotal: 0,
  discoLivre: 0,
}));

vi.mock("node:fs/promises", () => ({
  readFile: async (caminho: string) => {
    const conteudo = maquina.arquivos.get(caminho);
    if (conteudo === undefined) throw new Error(`ENOENT: ${caminho}`);
    return conteudo;
  },
  // bsize 1 deixa blocos e bytes coincidirem, para o teste falar em bytes
  statfs: async () => ({ blocks: maquina.discoTotal, bsize: 1, bavail: maquina.discoLivre }),
}));

vi.mock("node:os", () => ({
  default: {
    platform: () => maquina.platform,
    release: () => maquina.release,
    arch: () => maquina.arch,
    hostname: () => maquina.hostname,
    cpus: () => maquina.cpus,
    totalmem: () => maquina.totalmem,
    freemem: () => maquina.freemem,
    networkInterfaces: () => maquina.interfaces,
    loadavg: () => maquina.loadavg,
    uptime: () => maquina.uptime,
  },
}));

const { scanSystemHealth } = await import("../src/services/system-info.js");

const OS_RELEASE_UBUNTU = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  "ID=ubuntu",
  'VERSION_ID="24.04"',
  "",
].join("\n");

/** Sem rede: nenhum provedor de IP público responde. */
function semIpPublico(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("rede indisponível");
    }),
  );
}

/** Máquina saudável e suportada — base que cada teste ajusta. */
function maquinaSaudavel(): void {
  maquina.arquivos = new Map([
    ["/host/etc/os-release", OS_RELEASE_UBUNTU],
    ["/host/etc/hostname", "vps-do-cliente\n"],
    ["/sys/class/dmi/id/product_name", "KVM\n"],
    ["/proc/cpuinfo", "flags: fpu vme hypervisor\n"],
  ]);
  maquina.totalmem = HEALTH_LIMITS.minRamBytes * 4;
  maquina.freemem = HEALTH_LIMITS.minRamBytes;
  maquina.cpus = [{ model: "  AMD EPYC 7003  " }, { model: "AMD EPYC 7003" }];
  maquina.loadavg = [0.5, 0.4, 0.3];
  maquina.interfaces = { eth0: [{ internal: false, family: "IPv4", address: "10.0.0.5" }] };
  maquina.uptime = 3600.9;
  maquina.discoTotal = HEALTH_LIMITS.minFreeDiskBytes * 10;
  maquina.discoLivre = HEALTH_LIMITS.minFreeDiskBytes * 5;
  semIpPublico();
}

beforeEach(() => {
  vi.unstubAllGlobals();
  maquinaSaudavel();
});

describe("checagem do SO", () => {
  it("Ubuntu 24.04 é reconhecido como suportado", async () => {
    const scan = await scanSystemHealth();
    expect(scan.os.prettyName).toBe("Ubuntu 24.04.1 LTS");
    expect(scan.os.id).toBe("ubuntu");
    expect(scan.os.versionId).toBe("24.04");
    expect(scan.checks.os.level).toBe("ok");
  });

  it("distribuição fora da lista suportada vira aviso que nomeia o SO encontrado", async () => {
    maquina.arquivos.set(
      "/host/etc/os-release",
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n',
    );
    const scan = await scanSystemHealth();
    expect(scan.checks.os.level).toBe("warning");
    expect(scan.checks.os.message).toContain("Debian GNU/Linux 12 (bookworm)");
  });

  it("versão de Ubuntu não suportada também vira aviso", async () => {
    maquina.arquivos.set(
      "/host/etc/os-release",
      'PRETTY_NAME="Ubuntu 20.04 LTS"\nID=ubuntu\nVERSION_ID="20.04"\n',
    );
    const scan = await scanSystemHealth();
    expect(scan.checks.os.level).toBe("warning");
  });

  it("sem os-release legível, o relatório assume desconhecido em vez de quebrar", async () => {
    maquina.arquivos.delete("/host/etc/os-release");
    maquina.arquivos.delete("/host/etc/hostname");
    const scan = await scanSystemHealth();
    expect(scan.os.prettyName).toBe(maquina.platform);
    expect(scan.os.id).toBe("unknown");
    expect(scan.os.versionId).toBe("unknown");
    // sem /host/etc/hostname o nome cai para o do próprio processo
    expect(scan.os.hostname).toBe(maquina.hostname);
    expect(scan.checks.os.level).toBe("warning");
  });

  it("o hostname da VPS montada tem prioridade sobre o do container", async () => {
    const scan = await scanSystemHealth();
    expect(scan.os.hostname).toBe("vps-do-cliente");
  });
});

describe("checagem de memória", () => {
  it("acima do mínimo → ok", async () => {
    const scan = await scanSystemHealth();
    expect(scan.checks.memory.level).toBe("ok");
    expect(scan.memory.usedBytes).toBe(maquina.totalmem - maquina.freemem);
  });

  it("abaixo do mínimo mas ainda utilizável → aviso para ampliar antes de hospedar", async () => {
    // metade do mínimo (512 MiB) é exatamente o piso do nível crítico
    maquina.totalmem = HEALTH_LIMITS.minRamBytes / 2;
    maquina.freemem = 0;
    const scan = await scanSystemHealth();
    expect(scan.checks.memory.level).toBe("warning");
    expect(scan.checks.memory.message).toContain("recomendado ampliar");
  });

  it("abaixo do piso crítico → crítico: nem o Docker sobe", async () => {
    maquina.totalmem = HEALTH_LIMITS.minRamBytes / 4;
    maquina.freemem = 0;
    const scan = await scanSystemHealth();
    expect(scan.checks.memory.level).toBe("critical");
    expect(scan.checks.memory.message).toContain("insuficiente");
  });
});

describe("checagem de disco", () => {
  it("espaço livre acima do mínimo → ok", async () => {
    const scan = await scanSystemHealth();
    expect(scan.checks.disk.level).toBe("ok");
    expect(scan.disk.mount).toBe("/");
    expect(scan.disk.usedBytes).toBe(maquina.discoTotal - maquina.discoLivre);
  });

  it("pouco espaço livre → aviso de que imagens Docker consomem rápido", async () => {
    // um décimo do mínimo (1 GiB) é exatamente o piso do nível crítico
    maquina.discoLivre = HEALTH_LIMITS.minFreeDiskBytes / 10;
    const scan = await scanSystemHealth();
    expect(scan.checks.disk.level).toBe("warning");
    expect(scan.checks.disk.message).toContain("imagens Docker");
  });

  it("abaixo do piso crítico → crítico: build e pull vão falhar", async () => {
    maquina.discoLivre = HEALTH_LIMITS.minFreeDiskBytes / 20;
    const scan = await scanSystemHealth();
    expect(scan.checks.disk.level).toBe("critical");
    expect(scan.checks.disk.message).toContain("falhar");
  });
});

describe("detecção de virtualização", () => {
  it("reconhece o hipervisor pelo nome do produto DMI", async () => {
    const scan = await scanSystemHealth();
    expect(scan.virtualization).toBe("KVM");
  });

  it("produto DMI desconhecido com flag de hypervisor na CPU → genérico nomeando o produto", async () => {
    maquina.arquivos.set("/sys/class/dmi/id/product_name", "Placa Exotica X\n");
    const scan = await scanSystemHealth();
    expect(scan.virtualization).toBe("genérico (placa exotica x)");
  });

  it("produto DMI desconhecido e CPU sem flag de hypervisor → bare metal", async () => {
    maquina.arquivos.set("/sys/class/dmi/id/product_name", "Placa Exotica X\n");
    maquina.arquivos.set("/proc/cpuinfo", "flags: fpu vme\n");
    const scan = await scanSystemHealth();
    expect(scan.virtualization).toBe("nenhuma (bare metal)");
  });

  it("sem /sys, a flag de hypervisor no cpuinfo ainda denuncia a virtualização", async () => {
    maquina.arquivos.delete("/sys/class/dmi/id/product_name");
    const scan = await scanSystemHealth();
    expect(scan.virtualization).toBe("genérica (flag hypervisor presente)");
  });

  it("sem /sys e sem /proc/cpuinfo → bare metal", async () => {
    maquina.arquivos.delete("/sys/class/dmi/id/product_name");
    maquina.arquivos.delete("/proc/cpuinfo");
    const scan = await scanSystemHealth();
    expect(scan.virtualization).toBe("nenhuma (bare metal)");
  });
});

describe("rede", () => {
  it("lista só endereços externos e mantém o prefixo dos IPv6", async () => {
    maquina.interfaces = {
      lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
      eth0: [
        { internal: false, family: "IPv4", address: "203.0.113.7" },
        { internal: false, family: "IPv6", address: "2001:db8::1", cidr: "2001:db8::1/64" },
        { internal: false, family: "IPv6", address: "2001:db8::2", cidr: null },
      ],
      vazia: undefined,
    };
    const scan = await scanSystemHealth();
    expect(scan.network.interfaces).toEqual([
      { name: "eth0", addresses: ["203.0.113.7", "2001:db8::1/64", "2001:db8::2"] },
    ]);
  });

  it("quando o primeiro provedor de IP público falha, o segundo é consultado", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        chamadas.push(url);
        if (chamadas.length === 1) return { ok: false, text: async () => "" };
        return { ok: true, text: async () => "203.0.113.42\n" };
      }),
    );
    const scan = await scanSystemHealth();
    expect(chamadas).toHaveLength(2);
    expect(scan.network.publicIp).toBe("203.0.113.42");
  });

  it("resposta que não parece um IP é descartada em vez de virar dado do relatório", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "<html>erro do provedor</html>" })),
    );
    const scan = await scanSystemHealth();
    expect(scan.network.publicIp).toBeNull();
  });

  it("sem rede, o IP público fica nulo e o restante do scan continua válido", async () => {
    const scan = await scanSystemHealth();
    expect(scan.network.publicIp).toBeNull();
    expect(scan.checks.os.level).toBe("ok");
  });
});

describe("CPU e uptime", () => {
  it("usa o modelo da primeira CPU, sem espaços, e conta os núcleos", async () => {
    const scan = await scanSystemHealth();
    expect(scan.cpu.model).toBe("AMD EPYC 7003");
    expect(scan.cpu.cores).toBe(2);
    expect(scan.cpu.loadAvg).toEqual([0.5, 0.4, 0.3]);
    expect(scan.uptimeSeconds).toBe(3600);
  });

  it("sem CPU e sem load reportados, o relatório usa marcadores em vez de undefined", async () => {
    maquina.cpus = [];
    maquina.loadavg = [];
    const scan = await scanSystemHealth();
    expect(scan.cpu.model).toBe("desconhecido");
    expect(scan.cpu.cores).toBe(0);
    expect(scan.cpu.loadAvg).toEqual([0, 0, 0]);
  });
});
