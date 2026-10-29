/**
 * mcp-rodada4.test.ts — deploy bloqueado por guardrail, de ponta a ponta (rota real, compose real em disco):
 * a agregação é por projeto + ator + conjunto de regras, nunca esconde o deploy de uma pessoa, e a contagem do que
 * foi suprimido entra quando a janela fecha.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { runWithActor } from "../src/services/request-actor.js";
import { removeDir } from "./helpers/tmp.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let dir = "";
let bearer = "";
const human = () => ({ cookie: panel.cookie });

const compose = (extra: string) => `services:\n  web:\n    image: nginx:1.27\n    privileged: true\n${extra}`;

async function deploy(as: "token" | "person") {
  return panel.app.inject({
    method: "POST",
    url: `/api/projects/${A}/deploy`,
    headers: as === "token" ? { authorization: `Bearer ${bearer}` } : human(),
    payload: {},
  });
}
const entries = async () => ((await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; actor: string; detail: string }[]).filter((e) => e.action === "deploy.blocked");
const alerts = async () => ((await panel.app.inject({ method: "GET", url: "/api/alerts", headers: human() })).json().alerts as { source: string }[]).filter((a) => a.source === "guardrail").length;

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  dir = await mkdtemp(path.join(tmpdir(), "paas-r4-"));
  await writeFile(path.join(dir, "docker-compose.yml"), compose(""));
  vi.spyOn(panel.app.deployService as unknown as { sourceDirOf(p: unknown): string | null }, "sourceDirOf").mockReturnValue(dir);
  const t = await panel.createToken({ name: "ia", scope: "admin", reach: "panel" });
  expect(t.status).toBe(201);
  bearer = t.token;
}, 120_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await removeDir(dir);
  await panel.close();
});

describe("deploy bloqueado por guardrail: auditoria e alerta", () => {
  it("o mesmo bloqueio do mesmo token, no mesmo minuto, grava uma vez; regra diferente e deploy de pessoa sempre gravam", async () => {
    const first = await deploy("token");
    expect(first.statusCode, first.body).toBe(409);
    expect(first.json().error).toBe("guardrail_blocked");
    expect((await entries()).length).toBe(1);
    const alertsAfterFirst = await alerts();
    expect(alertsAfterFirst).toBeGreaterThan(0);

    // repetido pelo mesmo token: continua 409, sem nova auditoria nem novo alerta
    expect((await deploy("token")).statusCode).toBe(409);
    expect((await entries()).length).toBe(1);
    expect(await alerts()).toBe(alertsAfterFirst);

    // outro conjunto de regras no mesmo minuto: registra
    await writeFile(path.join(dir, "docker-compose.yml"), compose("    pid: host\n"));
    expect((await deploy("token")).statusCode).toBe(409);
    const depoisRegra = await entries();
    expect(depoisRegra.length).toBe(2);
    expect(depoisRegra[0]!.detail).toContain("pid");

    // a pessoa pela tela: nunca é suprimida, mesmo com as mesmas violações
    expect((await deploy("person")).statusCode).toBe(409);
    expect((await entries()).length).toBe(3);
    expect((await deploy("person")).statusCode).toBe(409);
    expect((await entries()).length).toBe(4);
  });

  it("a contagem do que foi suprimido é gravada quando a janela fecha", async () => {
    vi.useFakeTimers();
    try {
      const svc = panel.app.deployService as unknown as { blockedRecently(p: { id: string; slug: string }, detail: string): boolean };
      const record = vi.spyOn(panel.app.auditService, "record");
      const project = { id: "p-janela", slug: "janela" };
      const results = runWithActor("token:ia", () => [svc.blockedRecently(project, "d"), svc.blockedRecently(project, "d"), svc.blockedRecently(project, "d")]);
      expect(results).toEqual([false, true, true]);
      expect(record).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({ actor: "token:ia", action: "deploy.blocked", target: "janela" });
      expect(record.mock.calls[0]![0].detail).toContain("2 vez(es)");
      // outro token tem a própria janela
      expect(runWithActor("token:outra", () => svc.blockedRecently(project, "d"))).toBe(false);
      // fora de requisição de token (pessoa): nunca suprime
      expect(svc.blockedRecently(project, "d")).toBe(false);
      expect(svc.blockedRecently(project, "d")).toBe(false);
      record.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tabela de janelas se limpa quando passa de mil entradas", () => {
    const svc = panel.app.deployService as unknown as { blockedRecently(p: { id: string; slug: string }, detail: string): boolean; blockedSeen: Map<string, unknown> };
    for (let i = 0; i < 1_005; i++) runWithActor("token:ia", () => svc.blockedRecently({ id: `m${i}`, slug: "m" }, "d"));
    expect(svc.blockedSeen.size).toBeGreaterThan(0);
  });
});
