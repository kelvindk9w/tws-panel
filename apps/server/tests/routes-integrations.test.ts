/**
 * routes-integrations.test.ts — rotas da conta do GitHub conectada. O token
 * nunca volta pela API nem vai para a auditoria (só o login e o fato).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import integrationRoutes from "../src/routes/integrations.js";
import setupRoutes from "../src/routes/setup.js";
import { CredentialVault } from "../src/services/credential-vault.js";
import { GithubIntegration } from "../src/services/github-integration.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const GH_TOKEN = "github_pat_SEGREDO_9876";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let dir: string;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  dir = await mkdtemp(path.join(tmpdir(), "paas-routes-int-"));
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/user")
      ? new Response(JSON.stringify({ login: "kelvin" }), { status: 200 })
      : new Response(JSON.stringify([{ full_name: "kelvin/site", private: true, clone_url: "https://github.com/kelvin/site.git", html_url: "", default_branch: "main", description: null, updated_at: "x" }]), { status: 200 }),
  );
  app.decorate("deployService", { github: new GithubIntegration(new CredentialVault(dir), fetchMock as unknown as typeof fetch) } as never);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(integrationRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: "MinhaSenha123" },
  });
  cookie = sessionCookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "MinhaSenha123" } }));
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
  await rm(dir, { recursive: true, force: true });
});

describe("rotas da conta do GitHub", () => {
  it("conectar, listar e desconectar — o token nunca volta nem vai para a auditoria", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/integrations/github", headers: { cookie }, payload: { token: GH_TOKEN } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ connected: true, login: "kelvin", hint: "9876" });
    expect(put.body).not.toContain(GH_TOKEN);

    const repos = await app.inject({ method: "GET", url: "/api/integrations/github/repos", headers: { cookie } });
    expect(repos.json().repos[0]).toMatchObject({ fullName: "kelvin/site", private: true });

    const del = await app.inject({ method: "DELETE", url: "/api/integrations/github", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/integrations/github", headers: { cookie } })).json().connected).toBe(false);

    const audit = await ctx.auditService.list();
    const acoes = audit.entries.map((e) => e.action);
    expect(acoes).toEqual(expect.arrayContaining(["integration.github_connected", "integration.github_disconnected"]));
    expect(JSON.stringify(audit.entries)).not.toContain(GH_TOKEN);
  });

  it("sem sessão → 401; corpo sem token → 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/integrations/github" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/integrations/github", headers: { cookie }, payload: {} })).statusCode).toBe(400);
  });
});
