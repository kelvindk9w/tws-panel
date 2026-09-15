/**
 * Testes dos cards de saúde da máquina (HealthStep): todo card tem selo
 * (OK / Atenção / Crítico / Não verificado), o aviso ⚠️ agregado aparece só
 * para aviso e crítico, e a rede nunca mostra interfaces sem fonte do host.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthCheck, HealthScanResult } from "@paas/core";
import { HealthStep } from "../src/pages/setup/HealthStep";

type Checks = HealthScanResult["checks"];

function scanFixture(parcial: Partial<Checks>, extra: Partial<HealthScanResult> = {}): HealthScanResult {
  const checks: Checks = { os: OK, cpu: OK, memory: OK, disk: OK, network: OK, reboot: OK, ...parcial };
  return {
    scannedAt: new Date().toISOString(),
    os: { prettyName: "Ubuntu 24.04 LTS", id: "ubuntu", versionId: "24.04", kernel: "6.8.0", arch: "x86_64", hostname: "vps-1" },
    cpu: { model: "vCPU", cores: 2, loadAvg: [0.1, 0.2, 0.3] },
    memory: { totalBytes: 2 * 1024 ** 3, freeBytes: 1024 ** 3, usedBytes: 1024 ** 3 },
    disk: { mount: "/", totalBytes: 80 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedBytes: 40 * 1024 ** 3 },
    network: {
      publicIp: "203.0.113.10",
      interfaces: [{ name: "eth0", addresses: ["169.58.235.67/24"] }],
      interfacesSource: "host",
    },
    virtualization: "KVM/QEMU",
    uptimeSeconds: 3600,
    reboot: { pending: false, packages: [] },
    checks,
    ...extra,
  };
}

const OK: HealthCheck = { level: "ok", message: "tudo certo" };
const NAO_VERIFICADO: HealthCheck = { level: "unknown", message: "Não verificado: sem acesso à VPS." };

function mockScan(result: HealthScanResult): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HealthStep (cards de saúde)", () => {
  it("todos os checks ok → os seis cards com selo OK e nenhum aviso ⚠️", async () => {
    mockScan(scanFixture({}));
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    expect(screen.getAllByText("OK")).toHaveLength(6);
    expect(screen.queryByText(/pontos de atenção/i)).not.toBeInTheDocument();
  });

  it("RAM baixa → badge Atenção no card de memória + aviso ⚠️ agregado", async () => {
    mockScan(
      scanFixture({ memory: { level: "warning", message: "menos de 1 GiB de RAM" } }),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("menos de 1 GiB de RAM")).toBeInTheDocument();
    expect(screen.getAllByText("Atenção")).toHaveLength(1);
    expect(screen.getByText(/⚠️ Há pontos de atenção/)).toBeInTheDocument();
  });

  it("aviso e crítico têm selos diferentes: Atenção (âmbar) e Crítico (vermelho)", async () => {
    mockScan(
      scanFixture({
        memory: { level: "warning", message: "RAM insuficiente" },
        disk: { level: "critical", message: "menos de 1 GiB livre" },
      }),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("RAM insuficiente")).toBeInTheDocument();
    expect(screen.getByText("menos de 1 GiB livre")).toHaveClass("text-red-400");
    expect(screen.getByText("RAM insuficiente")).toHaveClass("text-amber-400");
    const atencao = screen.getByText("Atenção");
    const critico = screen.getByText("Crítico");
    expect(atencao.className).toContain("amber");
    expect(critico.className).toContain("red");
    expect(critico.className).not.toContain("amber");
    expect(screen.getAllByText("OK")).toHaveLength(4);
    expect(screen.getByText(/⚠️ Há pontos de atenção/)).toBeInTheDocument();
  });

  it("host ilegível → selo neutro Não verificado, sem interfaces e sem aviso ⚠️", async () => {
    mockScan(
      scanFixture(
        { reboot: NAO_VERIFICADO },
        {
          network: { publicIp: "203.0.113.10", interfaces: [], interfacesSource: "unavailable" },
          reboot: { pending: null, packages: [] },
        },
      ),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("Não verificado")).toBeInTheDocument();
    expect(screen.getByText(/Interfaces da VPS: não verificadas/)).toBeInTheDocument();
    expect(screen.getByText("Reinicialização pendente: não verificado")).toBeInTheDocument();
    expect(screen.getByText(NAO_VERIFICADO.message)).toBeInTheDocument();
    expect(screen.queryByText(/eth0/)).not.toBeInTheDocument();
    // não verificado não é problema: nada de aviso agregado
    expect(screen.queryByText(/pontos de atenção/i)).not.toBeInTheDocument();
  });

  it("interfaces lidas no host aparecem no card de Rede", async () => {
    mockScan(scanFixture({}));
    render(<HealthStep onNext={() => undefined} />);
    expect(await screen.findByText("eth0: 169.58.235.67/24")).toBeInTheDocument();
    expect(screen.getByText("Reinicialização pendente: não")).toBeInTheDocument();
  });

  it("reinicialização pendente → Atenção no card de uptime, pacotes e instrução", async () => {
    const instrucao = "Rode o comando sudo reboot, espere cerca de 1 minuto e recarregue.";
    mockScan(
      scanFixture(
        { reboot: { level: "warning", message: instrucao } },
        { reboot: { pending: true, packages: ["linux-image-generic", "libc6"] } },
      ),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText(instrucao)).toBeInTheDocument();
    expect(screen.getByText("Reinicialização pendente: sim")).toBeInTheDocument();
    expect(screen.getByText("Pedida por: linux-image-generic, libc6")).toBeInTheDocument();
    expect(screen.getAllByText("Atenção")).toHaveLength(1);
  });

  it("CPU e rede com problema também ganham selo e mensagem", async () => {
    mockScan(
      scanFixture(
        {
          cpu: NAO_VERIFICADO,
          network: { level: "warning", message: "IP público não detectado" },
        },
        { reboot: { pending: true, packages: [] } },
      ),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("IP público não detectado")).toBeInTheDocument();
    expect(screen.getByText("Não verificado")).toBeInTheDocument();
    expect(screen.getAllByText("Atenção")).toHaveLength(1);
    expect(screen.queryByText(/Pedida por/)).not.toBeInTheDocument();
  });

  it("falha da API → mensagem de erro em vez dos cards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthorized", message: "Setup token inválido ou ausente." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("Setup token inválido ou ausente.")).toBeInTheDocument();
    expect(screen.queryByText("Sistema operacional")).not.toBeInTheDocument();
  });
});
