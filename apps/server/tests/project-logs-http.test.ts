/**
 * project-logs-http.test.ts — cancelamento da rota com servidor HTTP REAL em
 * porta efêmera (127.0.0.1): cliente que fecha a conexão antes e depois de a
 * leitura começar. Docker em dublê; o servidor vive só durante o teste.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectLogsService, ReadContext } from "../src/services/project-logs.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let port = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condição não aconteceu a tempo");
    await sleep(10);
  }
}

const reads: ReadContext[] = [];
let holdUntilAbort = true;

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  (panel.app as unknown as { projectLogs: Pick<ProjectLogsService, "read"> }).projectLogs = {
    read: async (_p, _q, _s, ctx) => {
      reads.push(ctx ?? {});
      if (holdUntilAbort) {
        await new Promise<void>((resolve) => {
          if (ctx?.signal?.aborted) return resolve();
          ctx?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { service: null, tail: 200, since: null, services: [], lines: [], truncated: false, generatedAt: "2026-10-24T12:00:00.000Z" };
    },
  };
  await panel.app.listen({ host: "127.0.0.1", port: 0 });
  port = (panel.app.server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await panel.close();
});

function request(): http.ClientRequest {
  const req = http.request({ host: "127.0.0.1", port, path: `/api/projects/${A}/logs`, method: "GET", headers: { cookie: panel.cookie } });
  req.on("error", () => undefined);
  req.end();
  return req;
}

describe("rota de logs com HTTP real", () => {
  it("cliente que fecha DEPOIS de a leitura começar: o sinal do serviço aborta", async () => {
    reads.length = 0;
    holdUntilAbort = true;
    const req = request();
    await until(() => reads.length === 1);
    expect(reads[0]!.signal!.aborted).toBe(false);
    req.destroy();
    await until(() => reads[0]!.signal!.aborted);
  });

  it("cliente que fecha ANTES de a leitura começar (durante a leitura das variáveis): a leitura nem começa", async () => {
    reads.length = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    let asked = false;
    const spy = vi.spyOn(panel.app.deployService, "logSecretValues").mockImplementation(async () => {
      asked = true;
      await gate;
      return [];
    });
    try {
      const req = request();
      await until(() => asked);
      req.destroy();
      await sleep(150); // dá tempo de o servidor perceber o fechamento
      open();
      await sleep(150);
      expect(reads).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("cliente que fica até o fim: o sinal não aborta e a resposta chega", async () => {
    reads.length = 0;
    holdUntilAbort = false;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/projects/${A}/logs`, headers: { cookie: panel.cookie } }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve(`${res.statusCode} ${data}`));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body.startsWith("200 ")).toBe(true);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal!.aborted).toBe(false);
    holdUntilAbort = true;
  });
});
