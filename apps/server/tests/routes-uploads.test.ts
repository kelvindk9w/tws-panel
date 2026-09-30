/**
 * routes-uploads.test.ts — as rotas do envio de pasta pelo navegador e da
 * navegação de pastas do servidor: sessão obrigatória, arquivo cru no corpo
 * (sem biblioteca de upload), caminho relativo na query, limites.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import uploadRoutes from "../src/routes/uploads.js";
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
  await app.register(uploadRoutes);
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

describe("rotas de envio de pasta", () => {
  it("abre o envio, recebe os arquivos crus e devolve a pasta para usar como origem do projeto", async () => {
    const begin = await app.inject({ method: "POST", url: "/api/uploads", headers: { cookie } });
    expect(begin.statusCode, begin.body).toBe(200);
    const { id, dir } = begin.json() as { id: string; dir: string };
    const put = await app.inject({
      method: "PUT",
      url: `/api/uploads/${id}/file?path=${encodeURIComponent("css/style.css")}`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("h1{color:red}"),
    });
    expect(put.statusCode, put.body).toBe(204);
    expect(await readFile(path.join(dir, "css", "style.css"), "utf8")).toBe("h1{color:red}");
  });

  it("caminho que tenta escapar → 400; sem sessão → 401", async () => {
    const { id } = (await app.inject({ method: "POST", url: "/api/uploads", headers: { cookie } })).json() as { id: string };
    const fuga = await app.inject({
      method: "PUT",
      url: `/api/uploads/${id}/file?path=${encodeURIComponent("../../fora.txt")}`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(fuga.statusCode).toBe(400);
    const anon = await app.inject({ method: "POST", url: "/api/uploads" });
    expect(anon.statusCode).toBe(401);
  });

  it("navegar nas pastas: raiz = pasta de projetos; fora dela → 400", async () => {
    await mkdir(path.join(projectsDir, "meu-site"), { recursive: true });
    const raiz = await app.inject({ method: "GET", url: "/api/fs/dirs", headers: { cookie } });
    expect(raiz.statusCode).toBe(200);
    expect((raiz.json() as { dirs: Array<{ name: string }> }).dirs.map((d) => d.name)).toEqual(["meu-site"]);
    const fora = await app.inject({ method: "GET", url: "/api/fs/dirs?path=%2Fetc", headers: { cookie } });
    expect(fora.statusCode).toBe(400);
  });
});
