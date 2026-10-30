/**
 * Rotas do diagnóstico de e-mail: exigem login, validam a consulta, resolvem o projeto, não devolvem segredo e o
 * teste de conexão tem erro traduzido, resposta sem cache e limite de pedidos por minuto. Serviços em dublê.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type MailProbeResult, type MailRefusalsResponse, type ProjectMailDiagnosis } from "@paas/core";
import { mailDiagnosisRoutes } from "../src/routes/mail-diagnosis-routes.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { httpError } from "../src/services/http-error.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;
const refusals = vi.fn();
const refresh = vi.fn(async () => undefined);
const diagnose = vi.fn();
const probe = vi.fn();

const EMPTY: MailRefusalsResponse = { items: [], total: 0, retentionDays: 30, collectedAt: null, serverCreated: true };
const DIAGNOSIS: ProjectMailDiagnosis = { windowHours: 24, noSendsRecent: true, hints: [{ code: "needs_restart", severity: "problem" }], notices: [], lastAttempt: null };
const OK: MailProbeResult = { ok: true, host: "mail.example.com", port: 587, passed: ["connect", "ehlo", "starttls", "certificate", "auth"], failedStep: null, failure: null, detail: null, elapsedMs: 10 };

beforeEach(async () => {
  refusals.mockReset().mockResolvedValue(EMPTY);
  diagnose.mockReset().mockResolvedValue(DIAGNOSIS);
  probe.mockReset().mockResolvedValue(OK);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("deployService", { getProject: async (id: string) => (id === "p1" ? { id: "p1", name: "Loja", slug: "loja" } : null) } as never);
  await app.register(async (scope) => {
    registerErrorHandler(scope);
    mailDiagnosisRoutes(scope, { refusals, refresh, diagnose, probe });
  });
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers });

describe("autenticação", () => {
  it.each([
    ["GET", "/api/mail/envios/recusas"],
    ["GET", "/api/projects/p1/email/recusas"],
    ["GET", "/api/projects/p1/email/diagnostico"],
    ["POST", "/api/projects/p1/email/testar-conexao"],
  ])("%s %s sem credencial = 401", async (method, url) => {
    expect((await app.inject({ method: method as "GET", url })).statusCode).toBe(401);
  });
});

describe("recusas", () => {
  it("global: filtro por projeto e limite chegam ao serviço; pede a leitura do registro", async () => {
    const res = await get("/api/mail/envios/recusas?projectId=p1&limit=20");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY);
    expect(refusals).toHaveBeenCalledWith({ projectId: "p1", limit: 20 });
    expect(refresh).toHaveBeenCalled();
    await get("/api/mail/envios/recusas");
    expect(refusals).toHaveBeenLastCalledWith({});
  });

  it("do projeto: só as dele; inexistente = 404", async () => {
    expect((await get("/api/projects/p1/email/recusas?limit=5")).statusCode).toBe(200);
    expect(refusals).toHaveBeenLastCalledWith({ projectId: "p1", limit: 5 });
    await get("/api/projects/p1/email/recusas");
    expect(refusals).toHaveBeenLastCalledWith({ projectId: "p1" });
    const missing = await get("/api/projects/zzz/email/recusas");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("project_not_found");
  });

  it("consulta inválida: 400", async () => {
    for (const q of ["limit=0", "limit=1000", "limit=abc", "foo=1"]) {
      expect((await get(`/api/mail/envios/recusas?${q}`)).statusCode, q).toBe(400);
      expect((await get(`/api/projects/p1/email/recusas?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("a leitura do registro que falha não atrapalha a lista", async () => {
    refresh.mockRejectedValueOnce(new Error("stalwart fora"));
    expect((await get("/api/mail/envios/recusas")).statusCode).toBe(200);
  });
});

describe("diagnóstico", () => {
  it("devolve o diagnóstico do projeto", async () => {
    const res = await get("/api/projects/p1/email/diagnostico");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DIAGNOSIS);
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it("projeto inexistente = 404", async () => {
    expect((await get("/api/projects/zzz/email/diagnostico")).statusCode).toBe(404);
    expect(diagnose).not.toHaveBeenCalled();
  });
});

describe("testar conexão", () => {
  it("devolve o resultado sem cache e passa quem pediu", async () => {
    const res = await post("/api/projects/p1/email/testar-conexao");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(OK);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "operador");
  });

  it("erro do serviço vira a resposta com o código; erro inesperado = 500 sem detalhe", async () => {
    probe.mockRejectedValueOnce(httpError(409, "email_not_enabled", "Ligue o e-mail."));
    const res = await post("/api/projects/p1/email/testar-conexao");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_not_enabled", message: "Ligue o e-mail." });
    probe.mockRejectedValueOnce(new Error("detalhe interno"));
    const boom = await post("/api/projects/p1/email/testar-conexao");
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("detalhe interno");
  });

  it("projeto inexistente = 404", async () => {
    expect((await post("/api/projects/zzz/email/testar-conexao")).statusCode).toBe(404);
  });
});
