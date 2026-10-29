/**
 * apply-chave-ssh-sessao.test.ts — fase 01 do hardening com chave SSH E sessão aberta: a mesma regra da
 * tela Acesso à VPS (senha + 2FA obrigatório + código por e-mail quando ligado), a chave só no usuário de
 * administração configurado e aviso por e-mail ao dono. (Revisão de segurança do lote recuperação de acesso.)
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import authRoutes from "../src/routes/auth.js";
import securityRoutes from "../src/routes/security.js";
import setupRoutes from "../src/routes/setup.js";
import { AccessService } from "../src/services/access-service.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT dono";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  restoreJobsFromDisk: vi.fn(),
}));

vi.mock("../src/services/security-service.js", () => ({
  SecurityService: vi.fn().mockImplementation(function () {
    return mocks;
  }),
}));

const JOB = {
  id: "job1",
  phase: "01",
  phaseKey: "ssh",
  title: "Acesso SSH",
  dryRun: false,
  status: "queued",
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
  steps: [],
  log: "",
  rollbackScheduled: false,
  rollbackDeadline: null,
  error: null,
};

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let sent: string[];

async function build(adminUser: string | null) {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  app.decorate("config", { securityTarget: "container" } as ServerConfig);
  app.decorate(
    "accessService",
    new AccessService({
      runner: adminUser ? ({ ensureReady: async () => undefined, exec: async () => ({ code: 0, stdout: "", stderr: "" }), execWithInput: async () => ({ code: 0, stdout: "", stderr: "" }) }) : null,
      user: adminUser,
    }),
  );
  ctx.emailCode.setMailer({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
    send: async (msg) => void sent.push(msg.text),
    isHostedAddress: async () => false,
  });
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(securityRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apply.mockResolvedValue(JOB);
  nowMs = Date.UTC(2026, 9, 28, 12, 0, 0);
  sent = [];
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));

async function loginCookie(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

async function enable2fa(cookie: string): Promise<string> {
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    headers: { cookie },
    payload: { currentPassword: PASSWORD, code: codeNow(secret) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return secret;
}

const apply = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/security/apply", headers: { cookie }, payload: { phase: "01", dryRun: false, sshPublicKey: KEY, ...payload } });

describe("fase 01 com chave SSH e sessão aberta", () => {
  it("sem 2FA ligado recusa (409 two_factor_required), mesmo com a senha certa", async () => {
    await build("admin");
    const cookie = await loginCookie();
    const res = await apply(cookie, { sshUser: "admin", currentPassword: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("com 2FA e a senha, instala no usuário de administração e avisa o dono por e-mail", async () => {
    await build("admin");
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
    const cookie = await loginCookie();
    const secret = await enable2fa(cookie);
    nowMs += TOTP_STEP_SECONDS * 1000;
    const semCodigo = await apply(cookie, { sshUser: "admin", currentPassword: PASSWORD });
    expect(semCodigo.statusCode).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
    const ok = await apply(cookie, { sshUser: "admin", currentPassword: PASSWORD, code: codeNow(secret) });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(mocks.apply.mock.calls[0]![2]).toMatchObject({ sshUser: "admin", sshPublicKey: KEY });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/fase 01 do hardening \(usuário admin\)/);
    expect(sent[0]).not.toContain(KEY);
  });

  it("só aceita o usuário de administração configurado (e 'deploy' só se for ele)", async () => {
    await build("admin");
    const cookie = await loginCookie();
    const secret = await enable2fa(cookie);
    nowMs += TOTP_STEP_SECONDS * 1000;
    const outro = await apply(cookie, { sshUser: "outro", currentPassword: PASSWORD, code: codeNow(secret) });
    expect(outro.statusCode).toBe(400);
    expect(outro.json().error).toBe("ssh_user_not_admin");
    const omitido = await apply(cookie, { currentPassword: PASSWORD, code: codeNow(secret) });
    expect(omitido.json().error).toBe("ssh_user_not_admin");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("sem usuário de administração configurado ainda vale a 2FA (o usuário é o que a fase cria)", async () => {
    await build(null);
    const cookie = await loginCookie();
    const semDoisFatores = await apply(cookie, { sshUser: "deploy", currentPassword: PASSWORD });
    expect(semDoisFatores.json().error).toBe("two_factor_required");
    const secret = await enable2fa(cookie);
    nowMs += TOTP_STEP_SECONDS * 1000;
    const ok = await apply(cookie, { sshUser: "deploy", currentPassword: PASSWORD, code: codeNow(secret) });
    expect(ok.statusCode, ok.body).toBe(202);
  });
});
