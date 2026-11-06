/**
 * guardrail-dispensas-rotas.test.ts — as rotas do "Não procede — não avisar mais": só a sessão da pessoa
 * dispensa e volta a avisar (token nunca, nem com escopo admin), aviso dispensa só com a sessão, BLOQUEIO dispensa
 * com a mesma prova do override (senha + 2FA) e avisa o dono, e a leitura segue a dos guardrails do projeto.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import apiTokenRoutes from "../src/routes/api-tokens.js";
import authRoutes from "../src/routes/auth.js";
import emailCodeRoutes from "../src/routes/email-code.js";
import projectsRoutes from "../src/routes/projects.js";
import setupRoutes from "../src/routes/setup.js";
import type { DeployService } from "../src/services/deploy-service.js";
import { httpError } from "../src/services/http-error.js";
import { classifyRoute } from "../src/services/token-policy.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const DISMISSAL = { id: "d1", rule: "secret-in-code", service: null, match: "target", value: "app.js", title: "t", reason: null, by: "admin", at: "2026-11-06T12:00:00.000Z" };

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
const dismissGuardrail = vi.fn(async (..._args: unknown[]) => DISMISSAL);
const restoreGuardrail = vi.fn(async (..._args: unknown[]) => undefined);
const guardrailDismissals = vi.fn(async (..._args: unknown[]) => [DISMISSAL]);

beforeEach(async () => {
  nowMs = Date.UTC(2026, 10, 6, 12, 0, 0);
  for (const f of [dismissGuardrail, restoreGuardrail, guardrailDismissals]) f.mockClear();
  ctx = await buildAuthTestApp(SETUP, { now: () => nowMs });
  app = ctx.app;
  app.decorate("deployService", { dismissGuardrail, restoreGuardrail, guardrailDismissals } as unknown as DeployService);
  // sessão sintética de token chegando à rota (defesa em profundidade: a tabela de tokens já nega antes)
  app.addHook("preHandler", async (request) => {
    if (request.headers["x-teste-token"]) {
      request.session = { id: "tok", userId: "u", username: "token:x", createdAt: "", expiresAt: new Date(Date.now() + 1e6).toISOString(), ip: null, userAgent: null, token: { id: "t", scope: "admin", reach: { kind: "all" }, mcp: {} } } as never;
    }
  });
  await app.register(authRoutes);
  await app.register(emailCodeRoutes);
  await app.register(setupRoutes);
  await app.register(apiTokenRoutes);
  await app.register(projectsRoutes);
  const res = await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(201);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));

async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

async function withTwoFactor(): Promise<{ cookie: string; code: () => string }> {
  const cookie = await login();
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const on = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: codeNow(secret) } });
  expect(on.statusCode, on.body).toBe(200);
  return {
    cookie,
    code: () => {
      nowMs += TOTP_STEP_SECONDS * 1000;
      return codeNow(secret);
    },
  };
}

const post = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/projects/p1/guardrails/dismissals", headers, payload });
const warnFinding = { rule: "secret-in-code", title: "Possível secret comitado", evidence: "app.js:3", target: "app.js" };
const blockFinding = { rule: "weak-credentials", title: "Credencial fraca", service: "api", target: "CACHE_SALT", evidence: "e" };

describe("tabela de tokens", () => {
  it("dispensar e voltar a avisar: nenhum token; ler a lista: como a leitura dos guardrails", () => {
    expect(classifyRoute("POST", "/api/projects/:id/guardrails/dismissals").kind).toBe("denied");
    expect(classifyRoute("DELETE", "/api/projects/:id/guardrails/dismissals/:dismissalId").kind).toBe("denied");
    expect(classifyRoute("GET", "/api/projects/:id/guardrails/dismissals")).toEqual(classifyRoute("GET", "/api/projects/:id/guardrails"));
  });
});

describe("rotas", () => {
  it("lista as dispensas do projeto", async () => {
    const cookie = await login();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/guardrails/dismissals", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissals: [DISMISSAL] });
    guardrailDismissals.mockRejectedValueOnce(httpError(404, "project_not_found", "Projeto não encontrado."));
    expect((await app.inject({ method: "GET", url: "/api/projects/p2/guardrails/dismissals", headers: { cookie } })).statusCode).toBe(404);
  });

  it("aviso: a sessão basta; quem dispensou é o usuário da sessão", async () => {
    const cookie = await login();
    const res = await post({ cookie }, { finding: warnFinding, scope: "project", reason: "chave de exemplo da documentação" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ dismissal: DISMISSAL });
    expect(dismissGuardrail).toHaveBeenCalledWith("p1", { finding: warnFinding, scope: "project", reason: "chave de exemplo da documentação" }, "admin");
    // erro do serviço (ex.: abrangência sem serviço) volta como veio
    dismissGuardrail.mockRejectedValueOnce(httpError(400, "service_required", "x"));
    expect((await post({ cookie }, { finding: warnFinding, scope: "service" })).json().error).toBe("service_required");
  });

  it("regra inegociável: recusada antes de pedir prova, sem chamar o serviço", async () => {
    const cookie = await login();
    const res = await post({ cookie }, { finding: { rule: "privileged-container", title: "x", service: "web", evidence: "e" }, scope: "project" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_dismissible");
    expect(dismissGuardrail).not.toHaveBeenCalled();
  });

  it("bloqueio: sem 2FA ou sem a prova é recusado; com senha + código do app grava e o aviso ao dono vai junto", async () => {
    const plain = await login();
    const no2fa = await post({ cookie: plain }, { finding: blockFinding, scope: "project", currentPassword: PASSWORD });
    expect(no2fa.statusCode).toBe(409);
    expect(no2fa.json().error).toBe("two_factor_required");
    const { cookie, code } = await withTwoFactor();
    expect((await post({ cookie }, { finding: blockFinding, scope: "project" })).statusCode).toBe(401);
    expect((await post({ cookie }, { finding: blockFinding, scope: "project", currentPassword: "errada", code: code() })).statusCode).toBe(401);
    expect(dismissGuardrail).not.toHaveBeenCalled();
    const ok = await post({ cookie }, { finding: blockFinding, scope: "service", currentPassword: PASSWORD, code: code() });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(dismissGuardrail).toHaveBeenCalledWith("p1", { finding: blockFinding, scope: "service" }, "admin");
    expect(ok.json().alertWarning).toMatch(/Alerta por e-mail não enviado/); // sem e-mail no perfil
    // falha do serviço depois da prova: o erro volta como veio
    dismissGuardrail.mockRejectedValueOnce(httpError(409, "too_many_dismissals", "cheio"));
    const full = await post({ cookie }, { finding: blockFinding, scope: "project", currentPassword: PASSWORD, code: code() });
    expect(full.statusCode).toBe(409);
  });

  it("corpo com campo desconhecido ou abrangência inválida: 400", async () => {
    const cookie = await login();
    expect((await post({ cookie }, { finding: warnFinding, scope: "tudo" })).statusCode).toBe(400);
    expect((await post({ cookie }, { finding: { ...warnFinding, level: "warn" }, scope: "project" })).statusCode).toBe(400);
  });

  it("voltar a avisar: 204; dispensa que não existe: 404", async () => {
    const cookie = await login();
    const res = await app.inject({ method: "DELETE", url: "/api/projects/p1/guardrails/dismissals/d1", headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(restoreGuardrail).toHaveBeenCalledWith("p1", "d1", "admin");
    restoreGuardrail.mockRejectedValueOnce(httpError(404, "dismissal_not_found", "x"));
    expect((await app.inject({ method: "DELETE", url: "/api/projects/p1/guardrails/dismissals/d9", headers: { cookie } })).statusCode).toBe(404);
  });

  it("token de API (escopo admin) não dispensa nem volta a avisar", async () => {
    const { cookie, code } = await withTwoFactor();
    const made = await app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: { cookie }, payload: { name: "ia", scope: "admin", currentPassword: PASSWORD, code: code() } });
    expect(made.statusCode, made.body).toBe(201);
    const auth = { authorization: `Bearer ${made.json().token as string}` };
    expect((await post(auth, { finding: warnFinding, scope: "project" })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/projects/p1/guardrails/dismissals/d1", headers: auth })).statusCode).toBe(403);
    expect(dismissGuardrail).not.toHaveBeenCalled();
    expect(restoreGuardrail).not.toHaveBeenCalled();
  });

  it("sessão sintética de token que chegasse às rotas também é recusada", async () => {
    const cookie = await login();
    const res = await post({ cookie, "x-teste-token": "1" }, { finding: warnFinding, scope: "project" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    const del = await app.inject({ method: "DELETE", url: "/api/projects/p1/guardrails/dismissals/d1", headers: { cookie, "x-teste-token": "1" } });
    expect(del.statusCode).toBe(403);
    expect(dismissGuardrail).not.toHaveBeenCalled();
    expect(restoreGuardrail).not.toHaveBeenCalled();
  });
});
