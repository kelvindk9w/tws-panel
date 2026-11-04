/**
 * sessao-cookie.test.ts — lote 7, achados M1 (endurecer o cookie) e B13.
 *
 * Como `sslip.io` não está na lista de sufixos públicos, um `x.sslip.io` do
 * atacante consegue gravar um cookie `paas_session` com `Domain=sslip.io`
 * (cookie tossing) e manter o operador deslogado. Em HTTPS o cookie passa a
 * ser `__Host-paas_session` (só o próprio host o grava) e SameSite=Strict.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const PASSWORD = "MinhaSenha123";
const HTTPS = { "x-forwarded-proto": "https" };
let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp("token-de-teste", { trustProxy: true });
  app = ctx.app;
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { "x-setup-token": "token-de-teste" },
    payload: { username: "admin", password: PASSWORD },
  });
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function login(headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers,
    payload: { username: "admin", password: PASSWORD },
  });
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : [String(raw)]) as string[];
}

describe("cookie de sessão", () => {
  it("em HTTPS: __Host-paas_session, Secure, Path=/, sem Domain, SameSite=Strict", async () => {
    const res = await login(HTTPS);
    expect(res.statusCode).toBe(200);
    const cookie = setCookies(res)[0]!;
    expect(cookie).toMatch(/^__Host-paas_session=/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("em HTTP simples (IP:porta antes do SSL): paas_session sem Secure, SameSite=Strict", async () => {
    const cookie = setCookies(await login())[0]!;
    expect(cookie).toMatch(/^paas_session=/);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("em HTTPS o cookie sem prefixo NÃO vale (é o que um irmão *.sslip.io consegue plantar)", async () => {
    const plain = (await login()).headers["set-cookie"] as string; // sessão válida, mas nome sem prefixo
    const value = /^paas_session=([^;]+)/.exec(plain)![1]!;
    const comPrefixo = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { ...HTTPS, cookie: `__Host-paas_session=${value}` },
    });
    expect(comPrefixo.statusCode).toBe(200);
    const semPrefixo = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { ...HTTPS, cookie: `paas_session=${value}` },
    });
    expect(semPrefixo.statusCode).toBe(401);
  });

  it("cookie plantado sem prefixo não atrapalha o válido com prefixo", async () => {
    const value = /^__Host-paas_session=([^;]+)/.exec(setCookies(await login(HTTPS))[0]!)![1]!;
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { ...HTTPS, cookie: `paas_session=lixo-plantado; __Host-paas_session=${value}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("logout em HTTPS apaga o cookie com prefixo (Secure, Path=/)", async () => {
    const value = /^__Host-paas_session=([^;]+)/.exec(setCookies(await login(HTTPS))[0]!)![1]!;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...HTTPS, cookie: `__Host-paas_session=${value}` },
    });
    expect(res.statusCode).toBe(200);
    const apagado = setCookies(res).find((c) => c.startsWith("__Host-paas_session="))!;
    expect(apagado).toContain("Secure");
    expect(apagado).toContain("Path=/");
    expect(apagado).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
