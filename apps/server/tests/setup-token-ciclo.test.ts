/**
 * setup-token-ciclo.test.ts — lote 7, achado M3.
 *
 * - estado do setup ilegível NÃO reabre a API ao setup token (falha fechada);
 * - o token só vale em query no WebSocket do terminal (o resto, só cabeçalho);
 * - concluir o setup invalida o token (arquivo apagado, memória limpa);
 * - o token do arquivo vale mais que o da variável de ambiente, e setup
 *   concluído não carrega token nenhum no boot.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { loadSetupToken } from "../src/services/setup-token.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.get("/api/protegida", async () => ({ ok: true }));
  app.get("/api/terminal/ws", async () => ({ ok: true }));
  app.get("/api/healthz", async () => ({ ok: true }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeAuthTestApp(ctx);
});

describe("estado do setup ilegível: falha fechada", () => {
  const estado = () => path.join(ctx.dir, "setup-state.json");

  it.each([
    ["JSON truncado", async () => writeFile(estado(), '{"currentStep": 1, "compl')],
    ["erro de leitura (é uma pasta)", async () => mkdir(estado())],
  ])("%s: o setup token NÃO é aceito e a resposta é 503", async (_nome, quebrar) => {
    await quebrar();
    const res = await app.inject({ method: "GET", url: "/api/protegida", headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("setup_state_unavailable");
    // sem caminho de arquivo nem jargão do sistema na resposta
    expect(res.body).not.toContain(ctx.dir);
  });

  it("a sessão do admin também não passa por engano (nem 401 enganoso): 503", async () => {
    await ctx.setupState.complete();
    const user = await ctx.userStore.create("admin", "hash");
    const { cookieValue } = await ctx.sessionStore.create(user, { ip: "1.1.1.1", userAgent: null });
    await writeFile(estado(), "{quebrado");
    const res = await app.inject({
      method: "GET",
      url: "/api/protegida",
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it("/api/setup/* e /api/auth/* também falham fechado", async () => {
    await writeFile(estado(), "{quebrado");
    await app.register(setupRoutes);
    await app.register(authRoutes);
    for (const url of ["/api/setup/status", "/api/auth/me"]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(res.statusCode, url).toBe(503);
    }
  });

  it("arquivo que não existe é instalação nova: o token continua valendo", async () => {
    const res = await app.inject({ method: "GET", url: "/api/protegida", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("healthz continua público mesmo com o estado ilegível", async () => {
    await writeFile(estado(), "{quebrado");
    expect((await app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
  });
});

describe("setup token na URL só no WebSocket do terminal", () => {
  it("?token= em rota comum não autentica; no cabeçalho, sim", async () => {
    expect((await app.inject({ method: "GET", url: `/api/protegida?token=${TOKEN}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/protegida", headers: auth })).statusCode).toBe(200);
  });

  it("?token= no /api/terminal/ws autentica (o navegador não põe cabeçalho em WebSocket)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/terminal/ws?token=${TOKEN}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/terminal/ws?token=errado" })).statusCode).toBe(401);
  });
});

describe("concluir o setup invalida o token", () => {
  it("cria o admin: arquivo do token apagado e token da memória descartado", async () => {
    const tokenFile = path.join(ctx.dir, "setup-token");
    await writeFile(tokenFile, TOKEN);
    app.decorate("config", { setupTokenFile: tokenFile, allowedOrigins: [] } as never);
    await app.register(setupRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "MinhaSenha123" },
    });
    expect(res.statusCode).toBe(201);
    expect(existsSync(tokenFile)).toBe(false);
    expect(app.setupToken).toBeNull();
  });

  it("arquivo do token já ausente não atrapalha a conclusão", async () => {
    app.decorate("config", { setupTokenFile: path.join(ctx.dir, "nao-existe"), allowedOrigins: [] } as never);
    await app.register(setupRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "MinhaSenha123" },
    });
    expect(res.statusCode).toBe(201);
    expect(app.setupToken).toBeNull();
  });

  it("não consegue apagar o arquivo: o setup conclui mesmo assim, o token em memória cai e o fato é auditado", async () => {
    // o "arquivo" é uma pasta com conteúdo: unlink falha com EISDIR/EPERM
    const tokenFile = path.join(ctx.dir, "token-dir");
    await mkdir(tokenFile);
    await writeFile(path.join(tokenFile, "x"), "x");
    app.decorate("config", { setupTokenFile: tokenFile, allowedOrigins: [] } as never);
    await app.register(setupRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "MinhaSenha123" },
    });
    expect(res.statusCode).toBe(201);
    expect(app.setupToken).toBeNull();
    const entries = (await ctx.auditService.list()).entries;
    expect(entries.some((e) => e.action === "setup.token_cleanup_failed")).toBe(true);
  });
});

describe("loadSetupToken — prioridade e setup concluído", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-token-ciclo-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("o arquivo vale mais que a variável de ambiente (token novo do 'recomeçar' não perde para o antigo)", async () => {
    const file = path.join(dir, "token");
    await writeFile(file, "token-novo\n");
    vi.stubEnv("SETUP_TOKEN", "token-antigo-do-ambiente");
    expect(await loadSetupToken(file)).toBe("token-novo");
  });

  it("sem arquivo, a variável de ambiente é o fallback", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-env");
    expect(await loadSetupToken(path.join(dir, "nao-existe"))).toBe("token-da-env");
  });

  it("setup concluído: nenhum token é carregado, nem do arquivo nem do ambiente", async () => {
    const file = path.join(dir, "token");
    await writeFile(file, "token-novo\n");
    vi.stubEnv("SETUP_TOKEN", "token-da-env");
    expect(await loadSetupToken(file, { setupCompleted: true })).toBeNull();
  });
});
