/**
 * monitor-service.test.ts — MonitorService.runNow() (apps/server/src/services/monitor-service.ts).
 *
 * Bug real: runNow() (POST /api/security/monitor/run, "rodar agora" manual)
 * chamava executeScan() diretamente, ignorando o lock `inFlight` do
 * MonitorScheduler que já protege o tick automático — um POST manual podia
 * rodar em paralelo com um tick automático, dois scans disputando os mesmos
 * recursos do alvo. Corrigido para que runNow() passe pelo MESMO
 * MonitorScheduler (via scheduler.runNow()), herdando o lock.
 *
 * Também cobre o novo piso de intervalo (EFFECTIVE_MIN_INTERVAL_MS): o
 * mínimo antigo (10s, @paas/core MONITOR_MIN_INTERVAL_MS) era menor que a
 * duração real de um scan — o serviço agora aplica um piso mais realista.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityBaseline } from "@paas/core";
import { AlertsService } from "../src/services/alerts-service.js";
import type { ServerConfig } from "../src/config.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Espera até `condition()` ser true, sem depender de um número fixo de ticks
 * de microtask/timer — sob carga (suíte inteira rodando em paralelo) um
 * `setTimeout(fn, 0)` isolado pode não ser suficiente para o executeScan()
 * avançar até o await de collectBaseline antes da próxima asserção.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condição não satisfeita a tempo");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const collectBaselineMock = vi.hoisted(() => vi.fn());

vi.mock("@paas/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/security")>();
  return {
    ...actual,
    collectBaseline: collectBaselineMock,
    ContainerRunner: vi.fn().mockImplementation(() => ({
      label: "container:fake",
      profile: "container",
      ensureReady: () => Promise.resolve(),
      exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      execStream: () => Promise.resolve(0),
      uploadDir: () => Promise.resolve(),
    })),
  };
});

const { MonitorService } = await import("../src/services/monitor-service.js");

let dir: string;
let alerts: AlertsService;
let config: ServerConfig;

const FAKE_BASELINE: SecurityBaseline = {
  id: "baseline-1",
  createdAt: new Date().toISOString(),
  target: "container:fake",
  packages: [],
  ports: [],
  files: {},
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-monitor-service-"));
  alerts = new AlertsService(dir);
  config = {
    dataDir: dir,
    securityTarget: "container",
    securityTargetContainer: "paas-target-test",
    monitorIntervalMs: 60_000,
  } as ServerConfig;
  collectBaselineMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runNow() — respeita o lock inFlight do scheduler", () => {
  it("recusa com erro claro quando já há um scan em andamento", async () => {
    const gate = deferred<SecurityBaseline>();
    collectBaselineMock.mockReturnValueOnce(gate.promise);
    const monitor = new MonitorService(config, alerts);

    await monitor.getState(); // pré-carrega o estado (fora da zona cronometrada)
    const first = monitor.runNow();
    // deixa o executeScan() chegar até o await de collectBaseline
    await waitUntil(() => collectBaselineMock.mock.calls.length > 0);

    await expect(monitor.runNow()).rejects.toThrow(/já existe um scan/i);

    gate.resolve(FAKE_BASELINE);
    await first;
  });

  it("depois que o scan em andamento termina, um novo runNow() funciona e retorna o resultado fresco", async () => {
    collectBaselineMock.mockResolvedValue(FAKE_BASELINE);
    const monitor = new MonitorService(config, alerts);

    const r1 = await monitor.runNow();
    const r2 = await monitor.runNow();
    expect(r1.target).toBe("container:fake");
    expect(r2.target).toBe("container:fake");
    expect(collectBaselineMock).toHaveBeenCalledTimes(2);
  });

  it("um tick automático concorrente é pulado (não empilha) enquanto o runNow() manual está em andamento", async () => {
    const gate = deferred<SecurityBaseline>();
    collectBaselineMock.mockReturnValueOnce(gate.promise);
    const monitor = new MonitorService(config, alerts);
    await monitor.start();
    await monitor.getState(); // pré-carrega o estado (fora da zona cronometrada)

    const first = monitor.runNow();
    await waitUntil(() => collectBaselineMock.mock.calls.length > 0);

    // Simula o setInterval disparando durante o scan manual (acesso ao
    // scheduler interno só pelo índice de string — não precisa mais de
    // supressão de tipo, o acesso via string index já é aceito pelo tsc).
    await monitor["scheduler"]["tick"]();
    expect(collectBaselineMock).toHaveBeenCalledTimes(1); // não rodou um segundo scan

    gate.resolve(FAKE_BASELINE);
    await first;
    monitor.stop();
  });
});

describe("intervalo mínimo efetivo do scan recorrente", () => {
  it("um intervalo configurado abaixo do piso realista é elevado automaticamente", async () => {
    const monitor = new MonitorService({ ...config, monitorIntervalMs: 10_000 }, alerts);
    const state = await monitor.getState();
    expect(state.config.intervalMs).toBeGreaterThanOrEqual(60_000);
  });

  it("setIntervalMs também aplica o piso mínimo efetivo", async () => {
    const monitor = new MonitorService(config, alerts);
    await monitor.setIntervalMs(15_000);
    const state = await monitor.getState();
    expect(state.config.intervalMs).toBeGreaterThanOrEqual(60_000);
  });
});
