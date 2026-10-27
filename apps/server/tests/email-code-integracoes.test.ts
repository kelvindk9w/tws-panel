/**
 * email-code-integracoes.test.ts — o código por e-mail (quando ligado) nas ações que já existiam:
 * criar token de API, "Recomeçar do zero" e trocar o e-mail do perfil (que seria o desvio do código).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import apiTokenRoutes from "../src/routes/api-tokens.js";
import authRoutes from "../src/routes/auth.js";
import emailCodeRoutes from "../src/routes/email-code.js";
import setupRoutes from "../src/routes/setup.js";
import setupRestartRoutes from "../src/routes/setup-restart.js";
import settingsRoutes from "../src/routes/settings.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let sent: string[];
let cookie: string;
let secret: string;

const step = () => (nowMs += TOTP_STEP_SECONDS * 1000);
const totp = () => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: { cookie }, payload });

async function emailCode(action = "auth.password"): Promise<string> {
  nowMs += 31_000;
  const r = await app.inject({ method: "POST", url: "/api/auth/email-code/send", headers: { cookie }, payload: { action } });
  expect(r.statusCode, r.body).toBe(200);
  return /\b(\d{6})\b/.exec(sent.at(-1)!)![1]!;
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 27, 12, 0, 0);
  sent = [];
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  app.decorate("config", { setupTokenFile: path.join(ctx.dir, "setup-token") } as never);
  await writeFile(path.join(ctx.dir, "setup-token"), `${TOKEN}\n`);
  ctx.emailCode.setMailer({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
    send: async (m) => void sent.push(m.text),
    isHostedAddress: async () => false,
  });
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(emailCodeRoutes);
  await app.register(apiTokenRoutes);
  await app.register(setupRestartRoutes);
  await app.register(settingsRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  const user = (await ctx.userStore.findByUsername("admin"))!;
  await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
  cookie = sessionCookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } }));
  const setup = (await post("/api/auth/2fa/setup", {})).json() as { secret: string };
  secret = setup.secret;
  expect((await post("/api/auth/2fa/enable", { currentPassword: PASSWORD, code: totp() })).statusCode).toBe(200);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

async function turnOn() {
  const code = await emailCode("email.toggle");
  step();
  const res = await post("/api/auth/email-code/enable", { currentPassword: PASSWORD, code: totp(), emailCode: code });
  expect(res.statusCode, res.body).toBe(200);
}

describe("criar token de API", () => {
  it("sem o fator ligado segue como antes (senha + código do app)", async () => {
    step();
    const res = await post("/api/settings/api-tokens", { name: "ia", scope: "read", currentPassword: PASSWORD, code: totp() });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("com o fator ligado, pede o código por e-mail", async () => {
    await turnOn();
    step();
    const semCodigo = await post("/api/settings/api-tokens", { name: "ia", scope: "read", currentPassword: PASSWORD, code: totp() });
    expect(semCodigo.statusCode).toBe(400);
    expect(semCodigo.json().error).toBe("email_code_required");
    const code = await emailCode("token.create");
    step();
    const ok = await post("/api/settings/api-tokens", { name: "ia", scope: "read", currentPassword: PASSWORD, code: totp(), emailCode: code });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe("Recomeçar do zero", () => {
  it("com o fator ligado, pede o código por e-mail antes de apagar a conta", async () => {
    await turnOn();
    step();
    const semCodigo = await post("/api/settings/restart-setup", { currentPassword: PASSWORD, confirm: "recomeçar", code: totp() });
    expect(semCodigo.statusCode).toBe(400);
    expect(semCodigo.json().error).toBe("email_code_required");
    expect(await ctx.userStore.hasAdmin()).toBe(true);
    const code = await emailCode("setup.restart");
    step();
    const ok = await post("/api/settings/restart-setup", { currentPassword: PASSWORD, confirm: "recomeçar", code: totp(), emailCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await ctx.userStore.hasAdmin()).toBe(false);
  });
});

describe("trocar o e-mail do perfil", () => {
  it("livre enquanto o fator está desligado", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/settings/profile", headers: { cookie }, payload: { email: "outro@example.com" } });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("com o fator ligado, recusa trocar o endereço (desvio do código); manter o mesmo ou mexer no nome é livre", async () => {
    await turnOn();
    const trocar = await app.inject({ method: "PUT", url: "/api/settings/profile", headers: { cookie }, payload: { email: "invasor@example.net" } });
    expect(trocar.statusCode).toBe(409);
    expect(trocar.json().error).toBe("email_code_enabled");
    const apagar = await app.inject({ method: "PUT", url: "/api/settings/profile", headers: { cookie }, payload: { email: "" } });
    expect(apagar.statusCode).toBe(409);
    const igual = await app.inject({ method: "PUT", url: "/api/settings/profile", headers: { cookie }, payload: { email: "dono@example.com", displayName: "Dono" } });
    expect(igual.statusCode, igual.body).toBe(200);
    expect((await ctx.userStore.findByUsername("admin"))!.email).toBe("dono@example.com");
  });
});
