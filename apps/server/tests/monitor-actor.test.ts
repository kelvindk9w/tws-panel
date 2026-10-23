/**
 * O agendador do monitoramento, recriado por uma requisição de token (PUT
 * /api/security/monitor/config), não herda o ator do token: o disparo seguinte,
 * horas depois, não pode aparecer na Auditoria como `token:<nome>`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityBaseline } from "@paas/core";
import { AlertsService } from "../src/services/alerts-service.js";
import { currentActor, runWithActor } from "../src/services/request-actor.js";
import type { ServerConfig } from "../src/config.js";

const seen = vi.hoisted(() => [] as Array<string | undefined>);
const collectBaselineMock = vi.hoisted(() => vi.fn());

vi.mock("@paas/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/security")>();
  return {
    ...actual,
    collectBaseline: collectBaselineMock,
    ContainerRunner: vi.fn().mockImplementation(function () {
      return {
        label: "container:fake",
        profile: "container",
        ensureReady: () => Promise.resolve(),
        exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        execStream: () => Promise.resolve(0),
        uploadDir: () => Promise.resolve(),
      };
    }),
  };
});

const { MonitorService } = await import("../src/services/monitor-service.js");

const BASELINE: SecurityBaseline = {
  id: "baseline-1",
  createdAt: "2026-10-22T12:00:00.000Z",
  target: "container:fake",
  packages: [],
  ports: [],
  files: {},
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-monitor-actor-"));
  seen.length = 0;
  collectBaselineMock.mockReset();
  collectBaselineMock.mockImplementation(async () => {
    seen.push(currentActor());
    return BASELINE;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("monitoramento e ator de token", () => {
  it("intervalo trocado dentro de uma requisição de token: o timer recriado nasce sem ator (os disparos futuros não saem como token)", async () => {
    const config = { dataDir: dir, securityTarget: "container", securityTargetContainer: "paas-target-test", monitorIntervalMs: 60_000 } as ServerConfig;
    const monitor = new MonitorService(config, new AlertsService(dir));
    await monitor.getState();
    await monitor.start();
    // Timer real captura o contexto de quem o cria. O que importa é o ator no momento da criação.
    const realSetInterval = globalThis.setInterval;
    const created: Array<string | undefined> = [];
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      created.push(currentActor());
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    try {
      await runWithActor("token:ia", () => monitor.setIntervalMs(120_000));
    } finally {
      spy.mockRestore();
      monitor.stop();
    }
    expect(created.length).toBe(1);
    expect(created[0]).toBeUndefined();
    // e o disparo do tick, de fato, vê o contexto vazio
    collectBaselineMock.mockClear();
    seen.length = 0;
    await runWithActor("token:ia", async () => {
      await monitor.runNow();
    });
    expect(seen).toEqual(["token:ia"]); // trabalho da PRÓPRIA requisição segue atribuído ao token
  });
});
