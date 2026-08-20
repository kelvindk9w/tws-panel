/**
 * Testes da rota /api/domains/check (domains.ts): validação do parâmetro,
 * atalho dev de *.localhost e a decisão ok/mensagem conforme o DNS aponta
 * (ou não) para esta máquina. O DNS real é substituído por um resolvedor
 * controlado — rede externa não é determinística em teste unitário; a
 * integração real é exercitada pelos E2E.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";

const { resolve4 } = vi.hoisted(() => ({
  resolve4: vi.fn<(name: string) => Promise<string[]>>(),
}));

vi.mock("node:dns/promises", () => ({
  default: { resolve4 },
}));

import domainsRoutes from "../src/routes/domains.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PUBLIC_IP = "203.0.113.10";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;
let savedPublicIp: string | undefined;

beforeEach(async () => {
  savedPublicIp = process.env.PAAS_PUBLIC_IP;
  process.env.PAAS_PUBLIC_IP = PUBLIC_IP; // IP da máquina determinístico
  resolve4.mockReset();
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  await app.register(domainsRoutes);
});

afterEach(async () => {
  if (savedPublicIp === undefined) delete process.env.PAAS_PUBLIC_IP;
  else process.env.PAAS_PUBLIC_IP = savedPublicIp;
  await closeAuthTestApp(ctx);
});

function check(domain?: string) {
  return app.inject({
    method: "GET",
    url: domain === undefined ? "/api/domains/check" : `/api/domains/check?domain=${encodeURIComponent(domain)}`,
    headers: auth,
  });
}

describe("GET /api/domains/check", () => {
  it("sem ?domain= → 400 invalid_domain", async () => {
    for (const res of [await check(), await check("   ")]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_domain");
    }
  });

  it("localhost e *.localhost → devLocal sem consultar DNS", async () => {
    for (const domain of ["localhost", "loja.localhost"]) {
      const res = await check(domain);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ domain, devLocal: true, ok: true });
    }
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("domínio que resolve para o IP da máquina → ok com mensagem de pronto", async () => {
    resolve4.mockResolvedValue([PUBLIC_IP]);
    const res = await check("app.exemplo.com");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.devLocal).toBe(false);
    expect(body.machineIps).toContain(PUBLIC_IP);
    expect(body.message).toContain("aponta para esta máquina");
  });

  it("domínio que resolve para OUTRO IP → ok=false com orientação de ajuste", async () => {
    resolve4.mockResolvedValue(["198.51.100.99"]);
    const res = await check("app.exemplo.com");
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.resolvedIps).toEqual(["198.51.100.99"]);
    expect(body.message).toContain("não aponta para esta máquina");
  });

  it("domínio sem registro A (NXDOMAIN) → ok=false orientando criar o registro", async () => {
    resolve4.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    const res = await check("inexistente.exemplo.com");
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.resolvedIps).toEqual([]);
    expect(body.message).toContain("não resolveu nenhum registro A");
  });

  it("normaliza o domínio (maiúsculas/espaços) antes de consultar", async () => {
    resolve4.mockResolvedValue([PUBLIC_IP]);
    const res = await check("  APP.Exemplo.COM ");
    expect(res.json().domain).toBe("app.exemplo.com");
    expect(resolve4).toHaveBeenCalledWith("app.exemplo.com");
  });
});
