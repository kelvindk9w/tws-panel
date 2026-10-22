/**
 * Ouvido do aviso de envio no plugin de e-mail: instalação nova SEM reinício.
 * O segredo só nasce quando o servidor de e-mail é criado (com o painel já no
 * ar); por isso o ouvido sobe com o painel (em container) mesmo sem servidor
 * criado, em vez de esperar um reinício que ninguém faria.
 */
import { createServer } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

let ctx: AuthTestContext;
let app: FastifyInstance;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function configure(mailHookPort: number) {
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
    mailHookPort,
  } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(),
    listProjects: vi.fn(async () => []),
  } as unknown as FastifyInstance["deployService"]);
}

async function reachable(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mail-hook/send`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" });
    return res.status;
  } catch {
    return null;
  }
}

beforeEach(async () => {
  ctx = await buildAuthTestApp("token");
  app = ctx.app;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAuthTestApp(ctx);
});

describe("ouvido do aviso de envio sobe sem reinício", () => {
  it("painel em container, servidor de e-mail ainda NÃO criado: o ouvido já está de pé (recusa quem não é o Stalwart)", async () => {
    const port = await freePort();
    vi.spyOn(MailService.prototype, "sendHookListenable").mockReturnValue(true);
    await configure(port);
    await app.register(mailRoutes);
    await app.ready();
    // 403: está escutando, mas só aceita o endereço do container do Stalwart
    expect(await reachable(port)).toBe(403);
  });

  it("fora de container (ou porta 0): ninguém escuta", async () => {
    const port = await freePort();
    await configure(port);
    await app.register(mailRoutes);
    await app.ready();
    expect(await reachable(port)).toBeNull();
  });

  it("porta ocupada não derruba o painel: só avisa", async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "0.0.0.0", () => r()));
    const port = (taken.address() as { port: number }).port;
    vi.spyOn(MailService.prototype, "sendHookListenable").mockReturnValue(true);
    await configure(port);
    await app.register(mailRoutes);
    await expect(app.ready()).resolves.toBeDefined();
    await new Promise((r) => taken.close(r));
  });
});
