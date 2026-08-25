/**
 * Testes das rotas de saúde (health.ts): o liveness público e o scan real da
 * máquina (system-info.ts) — sem mocks: o teste valida a FORMA e a sanidade
 * dos dados coletados de verdade do host de teste (CPU, memória, disco, OS).
 * A verificação de suporte (Ubuntu 22.04/24.04, mínimos de RAM/disco) varia
 * por máquina, então o teste aceita ok/warning e confere a coerência.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS, SETUP_TOKEN_HEADER } from "@paas/core";
import healthRoutes from "../src/routes/health.js";
import { TerminalUnavailableError } from "../src/services/terminal-service.js";
import type { TerminalService } from "../src/services/terminal-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

/** Terminal falso: registra os comandos do espelho e simula indisponibilidade. */
function fakeTerminal(behavior: "ok" | "unavailable" | "boom"): { term: TerminalService; calls: string[] } {
  const calls: string[] = [];
  const term = {
    runCommand: (cmd: string, onData?: (chunk: string) => void) => {
      calls.push(cmd);
      if (behavior === "unavailable") {
        return Promise.reject(new TerminalUnavailableError("sem docker.sock"));
      }
      if (behavior === "boom") return Promise.reject(new Error("falha inesperada"));
      onData?.("saida-ao-vivo\n");
      return Promise.resolve({ code: 0, output: "" });
    },
  } as unknown as TerminalService;
  return { term, calls };
}

/** Aguarda o espelho fire-and-forget terminar (fila de comandos drenada). */
async function waitForMirror(calls: string[]): Promise<void> {
  for (let i = 0; i < 100 && calls.length < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  await app.register(healthRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("GET /api/healthz", () => {
  it("público (sem token) → { status: 'ok' }", async () => {
    const res = await app.inject({ method: "GET", url: "/api/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/health/scan", () => {
  it("exige autenticação (setup token nesta fase)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health/scan" });
    expect(res.statusCode).toBe(401);
  });

  it(
    "retorna o scan real da máquina com dados coerentes",
    { timeout: 30_000 }, // consulta de IP público tem timeout próprio de 3s por provedor
    async () => {
      const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // dados reais do host de teste
      expect(body.os.id).toBeTypeOf("string");
      expect(body.os.kernel.length).toBeGreaterThan(0);
      expect(body.cpu.cores).toBeGreaterThan(0);
      expect(body.cpu.loadAvg).toHaveLength(3);
      expect(body.memory.totalBytes).toBeGreaterThan(0);
      expect(body.memory.usedBytes).toBe(body.memory.totalBytes - body.memory.freeBytes);
      expect(body.disk.mount).toBe("/");
      expect(body.disk.totalBytes).toBeGreaterThan(0);
      expect(body.disk.usedBytes).toBe(body.disk.totalBytes - body.disk.freeBytes);
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof body.virtualization).toBe("string");
      expect(Array.isArray(body.network.interfaces)).toBe(true);
      // publicIp: string quando há rede, null quando offline — nunca lixo
      expect(body.network.publicIp === null || typeof body.network.publicIp === "string").toBe(true);

      // checks coerentes com os limites efetivos
      const supported =
        HEALTH_LIMITS.supportedDistroIds.includes(body.os.id) &&
        HEALTH_LIMITS.supportedVersionIds.includes(body.os.versionId);
      expect(body.checks.os.level).toBe(supported ? "ok" : "warning");
      expect(body.checks.memory.level).toBe(
        body.memory.totalBytes >= HEALTH_LIMITS.minRamBytes ? "ok" : "warning",
      );
      expect(body.checks.disk.level).toBe(
        body.disk.freeBytes >= HEALTH_LIMITS.minFreeDiskBytes ? "ok" : "warning",
      );
    },
  );

  it(
    "espelha a varredura no terminal web (comandos fixos somente-leitura, ao vivo)",
    { timeout: 30_000 },
    async () => {
      const { term, calls } = fakeTerminal("ok");
      app.decorate("terminalService", term);

      const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
      expect(res.statusCode).toBe(200);

      await waitForMirror(calls);
      // o usuário vê os checks de verdade rodando no terminal embutido
      expect(calls.some((c) => c.includes("cat /etc/os-release"))).toBe(true);
      expect(calls).toContain("free -h");
      expect(calls).toContain("df -h /");
      expect(calls).toContain("uptime");
    },
  );

  it(
    "terminal indisponível → espelho é pulado em silêncio (o scan formatado nunca quebra)",
    { timeout: 30_000 },
    async () => {
      const { term, calls } = fakeTerminal("unavailable");
      app.decorate("terminalService", term);
      const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
      expect(res.statusCode).toBe(200);
      await waitForMirror(calls);
      expect(calls.length).toBeGreaterThan(0); // tentou espelhar
    },
  );

  it(
    "falha inesperada no espelho vira warning de log (sem derrubar a resposta)",
    { timeout: 30_000 },
    async () => {
      const { term } = fakeTerminal("boom");
      app.decorate("terminalService", term);
      const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
    },
  );
});
