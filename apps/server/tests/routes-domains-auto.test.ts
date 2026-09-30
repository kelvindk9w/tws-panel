/**
 * routes-domains-auto.test.ts — domínio do projeto online.
 *
 * Validação real (30/09/2026): o assistente sugeria "nome.localhost", que só
 * funciona no computador de desenvolvimento; e o "Verificar DNS" comparava o
 * domínio com o IP do CONTAINER (172.x), então um domínio certo apontando
 * para a VPS saía como "não aponta para esta máquina". Agora o painel usa o IP
 * público da VPS (o mesmo do endereço sslip.io dele) e sugere um endereço
 * automático por projeto: <projeto>.<ip-com-hífens>.sslip.io, com HTTPS.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";

const { resolve4 } = vi.hoisted(() => ({ resolve4: vi.fn<(name: string) => Promise<string[]>>() }));
vi.mock("node:dns/promises", () => ({ default: { resolve4 } }));

import domainsRoutes from "../src/routes/domains.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
let ctx: AuthTestContext;
let app: FastifyInstance;
let saved: string | undefined;

async function montar(panelDomain: string | null) {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { panelDomain } as never);
  await app.register(domainsRoutes);
}

beforeEach(() => {
  saved = process.env.PAAS_PUBLIC_IP;
  delete process.env.PAAS_PUBLIC_IP;
  resolve4.mockReset();
});

afterEach(async () => {
  if (saved === undefined) delete process.env.PAAS_PUBLIC_IP;
  else process.env.PAAS_PUBLIC_IP = saved;
  await closeAuthTestApp(ctx);
});

describe("endereço automático do projeto", () => {
  it("painel em HTTPS (sslip.io): sugere <projeto>.<ip>.sslip.io e informa o IP público", async () => {
    await montar("203-0-113-10.sslip.io");
    const res = await app.inject({ method: "GET", url: "/api/domains/suggest?name=Dev%20Links", headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ auto: "dev-links.203-0-113-10.sslip.io", publicIp: "203.0.113.10" });
  });

  it("sem endereço público (desenvolvimento local): sugere .localhost e não inventa IP", async () => {
    await montar(null);
    const res = await app.inject({ method: "GET", url: "/api/domains/suggest?name=site", headers: auth });
    expect(res.json()).toEqual({ auto: "site.localhost", publicIp: null });
  });
});

describe("Verificar DNS usa o IP público da VPS", () => {
  it("domínio apontando para o IP da VPS → ok, mesmo sem PAAS_PUBLIC_IP", async () => {
    await montar("203-0-113-10.sslip.io");
    resolve4.mockResolvedValue(["203.0.113.10"]);
    const res = await app.inject({ method: "GET", url: "/api/domains/check?domain=site.meusite.com.br", headers: auth });
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().machineIps).toContain("203.0.113.10");
  });

  it("não aponta: a mensagem diz qual registro criar, com o IP certo", async () => {
    await montar("203-0-113-10.sslip.io");
    resolve4.mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/api/domains/check?domain=site.meusite.com.br", headers: auth });
    expect(res.json().ok).toBe(false);
    expect(res.json().message).toContain("203.0.113.10");
  });
});
