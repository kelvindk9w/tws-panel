/**
 * project-logs-wiring.test.ts — quem pede (sessão humana ou token), o sinal de
 * cancelamento na rota, o prazo do `docker ps` e o prazo recebido pelo inspect.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dockerInspect } from "../src/services/docker-logs.js";
import type { ProjectLogsService, ReadContext } from "../src/services/project-logs.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/docker-service.js")>();
  return { ...real, listContainers: vi.fn(async () => []) };
});

describe("rota: identidade de quem pede e cancelamento", () => {
  let panel: RealPanel;
  let A = "";
  const seen: ReadContext[] = [];

  beforeAll(async () => {
    panel = await startRealPanel();
    A = await panel.createProject("Fazenda", "fazenda.example.com");
    (panel.app as unknown as { projectLogs: Pick<ProjectLogsService, "read"> }).projectLogs = {
      read: async (_p, _q, _s, ctx) => {
        seen.push(ctx ?? {});
        return { service: null, tail: 200, since: null, services: [], lines: [], truncated: false, generatedAt: "2026-10-24T12:00:00.000Z" };
      },
    };
  }, 120_000);
  afterAll(async () => {
    await panel.close();
  });

  it("sessão humana: ator é a sessão, human=true, com sinal de cancelamento", async () => {
    seen.length = 0;
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/logs`, headers: { cookie: panel.cookie } });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.human).toBe(true);
    expect(seen[0]!.actor).toBeTruthy();
    expect(seen[0]!.actor!.startsWith("token:")).toBe(false);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal!.aborted).toBe(false);
  });

  it("token de API: ator é o token, human=false", async () => {
    seen.length = 0;
    const t = await panel.createToken({ name: "leitura", scope: "read", reach: "panel" });
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/logs`, headers: { authorization: `Bearer ${t.token}` } });
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.human).toBe(false);
    expect(seen[0]!.actor).toBe(`token:${t.id}`);
  });
});

describe("docker ps e inspect respeitam o prazo recebido", () => {
  let tmp = "";
  let oldPath: string | undefined;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "paas-fakedocker-"));
    await writeFile(path.join(tmp, "docker"), "#!/bin/sh\nexec sleep 5\n");
    await chmod(path.join(tmp, "docker"), 0o755);
    oldPath = process.env.PATH;
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("listContainers: o `docker ps` pendurado é cortado no prazo dado (não nos 300 s de antes)", async () => {
    const real = await vi.importActual<typeof import("../src/services/docker-service.js")>("../src/services/docker-service.js");
    process.env.PATH = `${tmp}:${oldPath}`;
    const t0 = Date.now();
    await expect(real.listContainers("/nonexistent.sock", 150)).rejects.toBeInstanceOf(real.DockerUnavailableError);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("dockerInspect: usa o timeoutMs recebido (Docker que não responde é cortado em ~100 ms, não em 10 s)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-insp-"));
    const socket = path.join(dir, "d.sock");
    const server = http.createServer(() => undefined);
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      const t0 = Date.now();
      expect(await dockerInspect(socket, "0123456789ab", 100)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
