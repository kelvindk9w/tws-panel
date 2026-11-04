/**
 * POST /api/projects/check-git-access — "Testar acesso" do assistente.
 *
 * Autenticada (sessão ou setup token), protegida contra escrita de outro site
 * (CSRF) e com limite de taxa. O token do corpo NUNCA volta na resposta, não
 * vai para a auditoria nem para o log da requisição.
 */
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SETUP_TOKEN_HEADER } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import type { DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const SEGREDO = "ghp_SEGREDOdoTESTEsupersecreto0005";
const OK = { ok: true, defaultBranch: "main", branches: ["main", "dev"], totalBranches: 2, branchFound: null, message: "Acesso confirmado." };

let ctx: AuthTestContext;
let app: FastifyInstance;
let checkGitAccess: ReturnType<typeof vi.fn>;
const logs: string[] = [];

async function build(result: unknown = OK, withRateLimit = false): Promise<void> {
  checkGitAccess = vi.fn(async () => result);
  ctx = await buildAuthTestApp(TOKEN, {
    logger: { level: "trace", stream: { write: (s: string) => void logs.push(s) } },
  });
  app = ctx.app;
  if (withRateLimit) await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  app.decorate("deployService", { checkGitAccess } as unknown as DeployService);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  logs.length = 0;
  await closeAuthTestApp(ctx);
});

const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const url = "/api/projects/check-git-access";

describe("POST /api/projects/check-git-access", () => {
  it("devolve o resultado do teste e repassa url, branch, token e useAccount", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { source: "https://github.com/dono/repo.git", branch: "dev", token: SEGREDO },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(OK);
    expect(checkGitAccess).toHaveBeenCalledWith({ source: "https://github.com/dono/repo.git", branch: "dev", token: SEGREDO });
  });

  it("falha do teste continua 200 com ok:false e o motivo (não é erro do pedido)", async () => {
    await build({ ok: false, reason: "invalid_token", message: "O servidor do repositório recusou o token." });
    const res = await app.inject({ method: "POST", url, headers: auth, payload: { source: "https://github.com/dono/repo.git", token: SEGREDO } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("o token não aparece na resposta, na auditoria nem no log da requisição", async () => {
    await build();
    await app.inject({ method: "POST", url, headers: auth, payload: { source: "https://github.com/dono/repo.git", token: SEGREDO } });
    await ctx.auditService.flush();
    const audit = JSON.stringify(await ctx.auditService.list(1, 100));
    expect(audit).not.toContain(SEGREDO);
    expect(logs.join("")).not.toContain(SEGREDO);
  });

  it("exige a URL e recusa campo desconhecido, URL gigante e token vazio (400 de schema)", async () => {
    await build();
    for (const payload of [{}, { source: "x", extra: 1 }, { source: "x".repeat(501) }, { source: "x", token: "" }, { source: "x", useAccount: "sim" }]) {
      const res = await app.inject({ method: "POST", url, headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(checkGitAccess).not.toHaveBeenCalled();
  });

  it("exige autenticação", async () => {
    await build();
    const res = await app.inject({ method: "POST", url, payload: { source: "https://github.com/dono/repo.git" } });
    expect(res.statusCode).toBe(401);
    expect(checkGitAccess).not.toHaveBeenCalled();
  });

  it("com sessão: recusa pedido marcado como vindo de outro site (CSRF) e aceita o do próprio painel", async () => {
    await build();
    await ctx.setupState.complete();
    const user = await ctx.userStore.create("admin", "hash-qualquer");
    const created = await ctx.sessionStore.create(user, { ip: "1.1.1.1", userAgent: null });
    const cookie = `${SESSION_COOKIE}=${created.cookieValue}`;
    const payload = { source: "https://github.com/dono/repo.git" };
    const cross = await app.inject({
      method: "POST",
      url,
      headers: { host: "painel.exemplo.com", cookie, "sec-fetch-site": "cross-site" },
      payload,
    });
    expect(cross.statusCode).toBe(403);
    expect(checkGitAccess).not.toHaveBeenCalled();
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { host: "painel.exemplo.com", cookie, origin: "https://painel.exemplo.com" },
      payload,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("limite de taxa: a 11ª consulta no mesmo minuto leva 429", async () => {
    await build(OK, true);
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await app.inject({ method: "POST", url, headers: auth, payload: { source: "https://github.com/dono/repo.git" } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("erro inesperado do serviço vira resposta de erro sem o token", async () => {
    await build();
    checkGitAccess.mockRejectedValueOnce(new Error(`quebrou com ${SEGREDO}`));
    const res = await app.inject({ method: "POST", url, headers: auth, payload: { source: "https://github.com/dono/repo.git", token: SEGREDO } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SEGREDO);
  });
});
