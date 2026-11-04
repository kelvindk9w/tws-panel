/**
 * Por que a checagem de blacklist nunca rodava, e a prova de que agora ela
 * mora no lugar certo.
 *
 * O Fastify isola cada plugin: o que o plugin de e-mail decora
 * (`app.mailService`) não aparece num plugin irmão. O gancho antigo do
 * Monitoramento lia `app.mailService` de lá — undefined —, o TypeError era
 * engolido como "best-effort" e nada era conferido. As rotas e o agendamento
 * da página Envios são registrados DENTRO do plugin de e-mail.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, SETUP_TOKEN_HEADER } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(),
    listProjects: vi.fn(async () => []),
  } as unknown as FastifyInstance["deployService"]);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("ligação da página Envios", () => {
  it("causa do bug antigo: um plugin irmão não enxerga o mailService", async () => {
    let seen: unknown = "não rodou";
    await app.register(mailRoutes);
    await app.register(async (sibling) => {
      seen = (sibling as unknown as { mailService?: unknown }).mailService;
    });
    await app.ready();
    expect(seen).toBeUndefined();
  });

  it("as rotas de Envios vêm junto com as do e-mail", async () => {
    await app.register(mailRoutes);
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/reputation", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lastCheck: null, checking: false, dqs: { configured: false, hint: null } });
    const queue = await app.inject({ method: "GET", url: "/api/mail/envios/queue", headers: auth });
    expect(queue.json()).toMatchObject({ available: false, message: expect.stringContaining("não foi criado") });
  });
});
