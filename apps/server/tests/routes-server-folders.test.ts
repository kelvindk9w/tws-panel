/**
 * routes-server-folders.test.ts — rota da navegação de pastas do servidor:
 * sessão obrigatória; fora da pasta de projetos → 400.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import serverFolderRoutes from "../src/routes/server-folders.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let projectsDir: string;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-routes-upload-"));
  app.decorate("config", { projectsDir } as never);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(serverFolderRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: "MinhaSenha123" },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "MinhaSenha123" } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
  await rm(projectsDir, { recursive: true, force: true });
});

describe("rota de pastas do servidor", () => {
  it("navegar nas pastas: raiz = pasta de projetos; fora dela → 400", async () => {
    await mkdir(path.join(projectsDir, "meu-site"), { recursive: true });
    const raiz = await app.inject({ method: "GET", url: "/api/fs/dirs", headers: { cookie } });
    expect(raiz.statusCode).toBe(200);
    expect((raiz.json() as { dirs: Array<{ name: string }> }).dirs.map((d) => d.name)).toEqual(["meu-site"]);
    const fora = await app.inject({ method: "GET", url: "/api/fs/dirs?path=%2Fetc", headers: { cookie } });
    expect(fora.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/fs/dirs" })).statusCode).toBe(401);
  });
});
