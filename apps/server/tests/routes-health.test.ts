/**
 * Testes das rotas de saúde (health.ts): o liveness público e o scan real da
 * máquina (system-info.ts) — sem mocks: o teste valida a FORMA e a sanidade
 * dos dados coletados de verdade do host de teste (CPU, memória, disco, OS).
 * A verificação de suporte (Ubuntu 22.04/24.04, mínimos de RAM/disco) varia
 * por máquina, então o teste aceita ok/warning e confere a coerência.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIMITS, SETUP_TOKEN_HEADER } from "@paas/core";
import healthRoutes, { HOST_PROBE_TIMEOUT_MS } from "../src/routes/health.js";
import { HOST_NETWORK_COMMAND, HOST_REBOOT_COMMAND } from "../src/services/system-info.js";
import type { ServerConfig } from "../src/config.js";
import { TerminalUnavailableError } from "../src/services/terminal-service.js";
import type { TerminalService } from "../src/services/terminal-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

/** Terminal falso: registra os comandos do espelho e simula indisponibilidade. */
function fakeTerminal(
  behavior: "ok" | "unavailable" | "boom" | "travado" | "falha-no-meio",
  capturas: Record<string, string> = {},
): { term: TerminalService; calls: string[]; captured: string[] } {
  const calls: string[] = [];
  const captured: string[] = [];
  const term = {
    runCommandCaptured: (cmd: string) => {
      captured.push(cmd);
      if (behavior === "travado") return new Promise(() => undefined);
      if (behavior === "unavailable") return Promise.reject(new TerminalUnavailableError("sem docker.sock"));
      return Promise.resolve({ code: 0, output: capturas[cmd] ?? "" });
    },
    runCommand: (cmd: string, onData?: (chunk: string) => void) => {
      calls.push(cmd);
      if (behavior === "unavailable") {
        return Promise.reject(new TerminalUnavailableError("sem docker.sock"));
      }
      if (behavior === "boom") return Promise.reject(new Error("falha inesperada"));
      if (behavior === "falha-no-meio" && cmd === "free -h") {
        return Promise.reject(new Error("sessão caiu no meio do espelho"));
      }
      onData?.("saida-ao-vivo\n");
      return Promise.resolve({ code: 0, output: "" });
    },
  } as unknown as TerminalService;
  return { term, calls, captured };
}

/** Alvo do terminal: só "host" autoriza ler a VPS por ele. */
function decorateTarget(target: ServerConfig["securityTarget"]): void {
  app.decorate("config", { securityTarget: target } as ServerConfig);
}

/** Sem rede nos testes de probe: a consulta de IP público falha na hora. */
function semRede(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
}

/** Aguarda o espelho fire-and-forget terminar (fila de comandos drenada). */
async function waitForMirror(calls: string[]): Promise<void> {
  for (let i = 0; i < 100 && calls.length < 7; i += 1) {
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
      // sem terminal do host, nada de interfaces do processo local nem "ok" de reboot
      expect(body.network.interfacesSource).toBe("unavailable");
      expect(body.network.interfaces).toEqual([]);
      expect(body.reboot.pending).toBeNull();
      expect(body.checks.reboot.level).toBe("unknown");
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

  it("alvo host: interfaces e reinicialização pendente são lidas NA VPS pelo terminal", async () => {
    semRede();
    const { term, captured, calls } = fakeTerminal("ok", {
      [HOST_NETWORK_COMMAND]: "2: eth0    inet 169.58.235.67/24 brd 169.58.235.255 scope global eth0\r\n",
      [HOST_REBOOT_COMMAND]: "PAAS_REBOOT=1\r\nlinux-image-generic\r\n",
    });
    app.decorate("terminalService", term);
    decorateTarget("host");

    const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(captured.sort()).toEqual([HOST_NETWORK_COMMAND, HOST_REBOOT_COMMAND].sort());
    expect(body.network).toMatchObject({
      interfacesSource: "host",
      interfaces: [{ name: "eth0", addresses: ["169.58.235.67/24"] }],
    });
    expect(body.reboot).toEqual({ pending: true, packages: ["linux-image-generic"] });
    expect(body.checks.reboot.level).toBe("warning");
    // o cabeçalho do espelho entra na fila antes das leituras
    expect(calls[0]).toContain("Varredura de saúde");
    await waitForMirror(calls);
    expect(calls).toHaveLength(7);
  });

  it("alvo container (dev): o terminal não é a VPS → nada é lido por ele, itens não verificados", async () => {
    semRede();
    const { term, captured } = fakeTerminal("ok");
    app.decorate("terminalService", term);
    decorateTarget("container");

    const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
    const body = res.json();
    expect(captured).toEqual([]);
    expect(body.network.interfacesSource).toBe("unavailable");
    expect(body.checks.reboot.level).toBe("unknown");
  });

  it("alvo host com terminal indisponível → não verificado, nunca ok", async () => {
    semRede();
    const { term } = fakeTerminal("unavailable");
    app.decorate("terminalService", term);
    decorateTarget("host");

    const body = (await app.inject({ method: "GET", url: "/api/health/scan", headers: auth })).json();
    expect(body.network.interfacesSource).toBe("unavailable");
    expect(body.reboot.pending).toBeNull();
    expect(body.checks.reboot.level).toBe("unknown");
  });

  it("leitura do host travada → o scan responde no tempo limite com itens não verificados", async () => {
    semRede();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { term, captured } = fakeTerminal("travado");
    app.decorate("terminalService", term);
    decorateTarget("host");

    const pending = app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
    // espera as duas leituras entrarem (setImmediate não é simulado)
    for (let i = 0; i < 10_000 && captured.length < 2; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(captured).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(HOST_PROBE_TIMEOUT_MS + 1);
    const body = (await pending).json();
    expect(body.network.interfacesSource).toBe("unavailable");
    expect(body.checks.reboot.level).toBe("unknown");
  });

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

  it("falha no meio do espelho interrompe o restante e só gera log", async () => {
    semRede();
    const { term, calls } = fakeTerminal("falha-no-meio");
    app.decorate("terminalService", term);
    const warn = vi.spyOn(app.log, "warn");
    const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 100 && warn.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls).toContain("free -h");
    expect(calls).not.toContain("df -h /");
    expect(warn).toHaveBeenCalled();
  });

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
