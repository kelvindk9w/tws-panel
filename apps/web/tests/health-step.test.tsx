/**
 * Testes dos cards de saúde da máquina (HealthStep): badges OK/Atenção por
 * check e o aviso ⚠️ agregado quando RAM ou disco estão abaixo do mínimo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthCheck, HealthScanResult } from "@paas/core";
import { HealthStep } from "../src/pages/setup/HealthStep";

function scanFixture(checks: { os: HealthCheck; memory: HealthCheck; disk: HealthCheck }): HealthScanResult {
  return {
    scannedAt: new Date().toISOString(),
    os: { prettyName: "Ubuntu 24.04 LTS", id: "ubuntu", versionId: "24.04", kernel: "6.8.0", arch: "x86_64", hostname: "vps-1" },
    cpu: { model: "vCPU", cores: 2, loadAvg: [0.1, 0.2, 0.3] },
    memory: { totalBytes: 2 * 1024 ** 3, freeBytes: 1024 ** 3, usedBytes: 1024 ** 3 },
    disk: { mount: "/", totalBytes: 80 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedBytes: 40 * 1024 ** 3 },
    network: { publicIp: "203.0.113.10", interfaces: [{ name: "eth0", addresses: ["10.0.0.2"] }] },
    virtualization: "kvm",
    uptimeSeconds: 3600,
    checks,
  };
}

const OK: HealthCheck = { level: "ok", message: "tudo certo" };

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
  it("todos os checks ok → badges OK e nenhum aviso ⚠️", async () => {
    mockScan(scanFixture({ os: OK, memory: OK, disk: OK }));
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeInTheDocument();
    expect(screen.getAllByText("OK")).toHaveLength(3);
    expect(screen.queryByText(/pontos de atenção/i)).not.toBeInTheDocument();
  });

  it("RAM baixa → badge Atenção no card de memória + aviso ⚠️ agregado", async () => {
    mockScan(
      scanFixture({
        os: OK,
        memory: { level: "warning", message: "menos de 1 GiB de RAM" },
        disk: OK,
      }),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("menos de 1 GiB de RAM")).toBeInTheDocument();
    expect(screen.getAllByText("Atenção")).toHaveLength(1);
    expect(screen.getByText(/⚠️ Há pontos de atenção/)).toBeInTheDocument();
  });

  it("RAM e disco baixos → dois badges Atenção e as duas mensagens visíveis", async () => {
    mockScan(
      scanFixture({
        os: OK,
        memory: { level: "warning", message: "RAM insuficiente" },
        disk: { level: "critical", message: "menos de 10 GiB livres" },
      }),
    );
    render(<HealthStep onNext={() => undefined} />);

    expect(await screen.findByText("RAM insuficiente")).toBeInTheDocument();
    expect(screen.getByText("menos de 10 GiB livres")).toBeInTheDocument();
    expect(screen.getAllByText("Atenção")).toHaveLength(2);
    expect(screen.getAllByText("OK")).toHaveLength(1);
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
