/**
 * routes-metrics-backup-falha.test.ts — o semáforo informa QUANDO a última cópia
 * externa falhou (`lastFailureAt`, ISO), mantendo o booleano `lastFailure`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;

beforeAll(async () => {
  panel = await startRealPanel();
}, 120_000);
afterAll(async () => panel.close());

describe("semáforo: falha do backup externo", () => {
  it("devolve a data da falha ao lado do booleano", async () => {
    vi.spyOn(panel.app.backupService, "facts").mockResolvedValue({
      destinationConnected: true,
      verifiedRemote: 1,
      lastFailure: "sem espaço",
      lastFailureAt: "2026-10-26T03:15:00.000Z",
    });
    const s = (await panel.app.inject({ method: "GET", url: "/api/metrics/summary", headers: { cookie: panel.cookie } })).json();
    expect(s.protections.backups).toEqual({ destinationConnected: true, lastFailure: true, lastFailureAt: "2026-10-26T03:15:00.000Z" });
    expect(s.protections.level).toBe("critical");
  });
});
