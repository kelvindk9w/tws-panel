/**
 * routes-onboarding.test.ts — API do roteiro "Deixe o painel pronto".
 *  GET  /api/onboarding                 status de cada passo + progresso da conta
 *  POST /api/onboarding/start           "comecei" (o Dashboard passa a mostrar o roteiro compacto)
 *  PUT  /api/onboarding/steps/:id       "Não vou usar" / desfazer (só passos opcionais)
 *
 * O progresso é da CONTA (data/users.json, ao lado das preferências): vale
 * em qualquer computador. As conferências são injetadas (sem Docker).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER, type OnboardingResponse } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import onboardingRoutes from "../src/routes/onboarding.js";
import setupRoutes from "../src/routes/setup.js";
import type { OnboardingChecks, StepState } from "../src/services/onboarding.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let emailState: StepState;

const fixed = (state: StepState) => async () => state;

beforeEach(async () => {
  emailState = { status: "pending", detail: "Servidor de e-mail não iniciado." };
  const checks: OnboardingChecks = {
    hardening: fixed({ status: "done", detail: "Todas as 8 fases resolvidas." }),
    "two-factor": fixed({ status: "pending", detail: "Desligada." }),
    "panel-domain": fixed({ status: "soon", detail: "Em breve." }),
    email: async () => emailState,
    notifications: fixed({ status: "soon", detail: "Em breve." }),
  };
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { projectsDir: "/opt/tws-projects" } as FastifyInstance["config"]);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(onboardingRoutes, { checks });
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

async function get(): Promise<OnboardingResponse> {
  const res = await app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OnboardingResponse;
}

function skip(id: string, skipped: unknown) {
  return app.inject({
    method: "PUT",
    url: `/api/onboarding/steps/${id}`,
    headers: { cookie },
    payload: { skipped } as Record<string, unknown>,
  });
}

async function storedOnboarding(): Promise<unknown> {
  const raw = JSON.parse(await readFile(path.join(ctx.dir, "users.json"), "utf8")) as { users: Array<{ onboarding?: unknown }> };
  return raw.users[0]!.onboarding;
}

describe("GET /api/onboarding", () => {
  it("conta nova: passos na ordem, roteiro ainda não começado, pasta dos projetos informada", async () => {
    const res = await get();
    expect(res.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      "hardening:done",
      "two-factor:pending",
      "panel-domain:soon",
      "email:pending",
      "notifications:soon",
    ]);
    expect(res.started).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.projectsDir).toBe("/opt/tws-projects");
  });

  it("sem sessão → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/onboarding/start", () => {
  it("marca o roteiro como começado, grava na conta e não muda a data numa segunda vez", async () => {
    const first = await app.inject({ method: "POST", url: "/api/onboarding/start", headers: { cookie } });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as OnboardingResponse).started).toBe(true);
    const saved = (await storedOnboarding()) as { startedAt: string; skipped: string[] };
    expect(saved.startedAt).toEqual(expect.any(String));
    expect(saved.skipped).toEqual([]);

    await app.inject({ method: "POST", url: "/api/onboarding/start", headers: { cookie } });
    expect(((await storedOnboarding()) as { startedAt: string }).startedAt).toBe(saved.startedAt);
    expect((await get()).started).toBe(true);
  });
});

describe("PUT /api/onboarding/steps/:id", () => {
  it("'Não vou usar' no e-mail: passo pulado, roteiro começado, auditado; desfazer volta ao status real", async () => {
    const res = await skip("email", true);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as OnboardingResponse;
    expect(body.steps.find((s) => s.id === "email")?.status).toBe("skipped");
    expect(body.started).toBe(true);
    expect(await storedOnboarding()).toMatchObject({ skipped: ["email"] });

    // Marcar de novo não duplica.
    await skip("email", true);
    expect(await storedOnboarding()).toMatchObject({ skipped: ["email"] });

    const undo = await skip("email", false);
    expect((undo.json() as OnboardingResponse).steps.find((s) => s.id === "email")?.status).toBe("pending");
    expect(await storedOnboarding()).toMatchObject({ skipped: [] });

    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list(1, 50);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("settings.onboarding_step_skipped");
    expect(actions).toContain("settings.onboarding_step_unskipped");
  });

  it("e-mail configurado de verdade vence o 'Não vou usar'", async () => {
    await skip("email", true);
    emailState = { status: "done", detail: "Servidor ligado." };
    expect((await get()).steps.find((s) => s.id === "email")?.status).toBe("done");
  });

  it("passo obrigatório, passo inexistente ou corpo inválido → 400", async () => {
    expect((await skip("two-factor", true)).statusCode).toBe(400);
    expect((await skip("hardening", true)).statusCode).toBe(400);
    expect((await skip("backups", true)).statusCode).toBe(400);
    expect((await skip("email", "sim")).statusCode).toBe(400);
    const extra = await app.inject({
      method: "PUT",
      url: "/api/onboarding/steps/email",
      headers: { cookie },
      payload: { skipped: true, outro: 1 },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("sessão de conta que não existe mais → 401", async () => {
    await ctx.userStore.removeAll();
    expect((await skip("email", true)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/onboarding/start", headers: { cookie } })).statusCode).toBe(401);
  });
});
