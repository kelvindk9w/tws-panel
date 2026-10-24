/**
 * project-logs-destroyed.test.ts — a rota recebe o pedido com a resposta já
 * destruída (conexão caiu antes de a rota começar): não lê nada e não chama o
 * serviço.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectLogsService } from "../src/services/project-logs.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const reads = vi.fn();

beforeAll(async () => {
  panel = await startRealPanel({
    beforeReady: (app) => {
      app.addHook("preHandler", async (request, reply) => {
        if (request.headers["x-destruir"]) Object.defineProperty(reply.raw, "destroyed", { value: true, configurable: true });
      });
    },
  });
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  (panel.app as unknown as { projectLogs: Pick<ProjectLogsService, "read"> }).projectLogs = {
    read: async (...args) => {
      reads(...args);
      return { service: null, tail: 200, since: null, services: [], lines: [], truncated: false, generatedAt: "2026-10-24T12:00:00.000Z" };
    },
  };
}, 120_000);

afterAll(async () => {
  await panel.close();
});

describe("rota com a resposta já destruída", () => {
  it("responde 499 e não chama o serviço de logs", async () => {
    reads.mockClear();
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/logs`, headers: { cookie: panel.cookie, "x-destruir": "1" } });
    expect(res.statusCode).toBe(499);
    expect(reads).not.toHaveBeenCalled();
  });

  it("sem a conexão caída, o mesmo pedido lê normalmente", async () => {
    reads.mockClear();
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/logs`, headers: { cookie: panel.cookie } });
    expect(res.statusCode).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
