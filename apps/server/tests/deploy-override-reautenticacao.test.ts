/**
 * deploy-override-reautenticacao.test.ts — liberar os bloqueios de segurança do deploy (privilegiado,
 * namespaces do host, montar pastas do servidor) é, na prática, root na VPS. Só com a mesma prova de
 * habilitar o terminal: senha + 2FA (+ código por e-mail preso à ação "deploy.override"), só por pessoa,
 * com alerta por e-mail ao dono. Deploy comum não pede nada e nada herda um override anterior.
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
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let sent: string[];
const startDeploy = vi.fn(async () => ({ id: "job-1", projectId: "p1", status: "queued" }));

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 29, 12, 0, 0);
  sent = [];
  startDeploy.mockClear();
  ctx = await buildAuthTestApp(SETUP, { now: () => nowMs });
  app = ctx.app;
  app.decorate("deployService", { startDeploy } as unknown as DeployService);
  // simula a sessão sintética de um token chegando à rota: vem DEPOIS do hook de auth
  app.addHook("preHandler", async (request) => {
    if (request.headers["x-teste-token"]) {
      request.session = { id: "tok", userId: "u", username: "token:x", createdAt: "", expiresAt: new Date(Date.now() + 1e6).toISOString(), ip: null, userAgent: null, token: { id: "t", scope: "admin", reach: { kind: "all" }, mcp: {} } } as never;
    }
  });
  ctx.emailCode.setMailer({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
    send: async (msg) => void sent.push(msg.text),
    isHostedAddress: async () => false,
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
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);
const deploy = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/projects/p1/deploy", headers: { cookie }, payload });

async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

async function ready() {
  const cookie = await login();
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const on = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: codeNow(secret) } });
  expect(on.statusCode, on.body).toBe(200);
  const creds = (extra: Record<string, unknown> = {}) => {
    nextStep();
    return { guardrailOverride: true, acceptedBlocks: ["privileged-container|app|serviço app"], currentPassword: PASSWORD, code: codeNow(secret), ...extra };
  };
  return { cookie, creds };
}

describe("deploy com override dos bloqueios", () => {
  it("deploy comum não pede prova nenhuma e roda sem override", async () => {
    const cookie = await login();
    for (const payload of [{}, { guardrailOverride: false }]) {
      const res = await deploy(cookie, payload);
      expect(res.statusCode).toBe(202);
    }
    expect(startDeploy).toHaveBeenCalledTimes(2);
    expect(startDeploy).toHaveBeenLastCalledWith("p1", { guardrailOverride: false });
  });

  it("sem 2FA ligado: recusado com mensagem que aponta Configurações, e nada roda", async () => {
    const cookie = await login();
    const res = await deploy(cookie, { guardrailOverride: true, acceptedBlocks: ["x|y|z"], currentPassword: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    expect(res.json().message).toContain("Configurações");
    expect(startDeploy).not.toHaveBeenCalled();
  });

  it("override sem a lista de bloqueios aceitos é recusado (400) antes de gastar a reautenticação", async () => {
    const { cookie, creds } = await ready();
    const { acceptedBlocks: _a, ...semLista } = creds();
    void _a;
    const res = await deploy(cookie, semLista);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("accepted_blocks_required");
    expect(res.json().message).toContain("Revise os bloqueios");
    expect(startDeploy).not.toHaveBeenCalled();
    // o código do app não foi gasto: a mesma prova ainda vale com a lista
    const retry = await deploy(cookie, { ...semLista, acceptedBlocks: [] });
    expect(retry.statusCode, retry.body).toBe(202);
  });

  it("só a sessão (sem senha, com senha errada, sem código ou com código errado): recusado", async () => {
    const { cookie, creds } = await ready();
    const noPassword = await deploy(cookie, { guardrailOverride: true, acceptedBlocks: ["x|y|z"] });
    expect(noPassword.statusCode).toBe(401);
    expect((await deploy(cookie, { ...creds(), currentPassword: "errada" })).statusCode).toBe(401);
    const noCode = await deploy(cookie, { guardrailOverride: true, acceptedBlocks: ["x|y|z"], currentPassword: PASSWORD });
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().error).toBe("invalid_two_factor_code");
    expect((await deploy(cookie, { guardrailOverride: true, acceptedBlocks: ["x|y|z"], currentPassword: PASSWORD, code: "000000" })).statusCode).toBe(400);
    expect(startDeploy).not.toHaveBeenCalled();
  });

  it("com senha + código do app: roda COM override e o dono é avisado por e-mail (ou o aviso diz por quê)", async () => {
    const { cookie, creds } = await ready();
    const res = await deploy(cookie, creds());
    expect(res.statusCode, res.body).toBe(202);
    expect(startDeploy).toHaveBeenCalledWith("p1", { guardrailOverride: true, acceptedBlocks: ["privileged-container|app|serviço app"] });
    expect(res.json().alertWarning).toMatch(/Alerta por e-mail não enviado/); // sem e-mail no perfil
    await ctx.auditService.flush();
  });

  it("com e-mail cadastrado o alerta sai, sem segredo, dizendo o que foi liberado", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
    const { cookie, creds } = await ready();
    const res = await deploy(cookie, creds());
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().alertWarning).toBeUndefined();
    await ctx.emailCode.idle();
    expect(sent.at(-1)).toMatch(/bloqueios de segurança liberados/);
    expect(sent.at(-1)).not.toContain(PASSWORD);
  });

  it("com o código por e-mail ligado ele é exigido e fica preso à ação 'deploy.override'", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
    const { cookie, creds } = await ready();
    const requestCode = async (action: string) => {
      nowMs += 31_000;
      const r = await app.inject({ method: "POST", url: "/api/auth/email-code/send", headers: { cookie }, payload: { action } });
      expect(r.statusCode, r.body).toBe(200);
      return /\b(\d{6})\b/.exec(sent.at(-1)!)![1]!;
    };
    const { guardrailOverride: _g, acceptedBlocks: _a, ...forToggle } = creds({ emailCode: await requestCode("email.toggle") });
    void _g;
    void _a;
    const on = await app.inject({ method: "POST", url: "/api/auth/email-code/enable", headers: { cookie }, payload: forToggle });
    expect(on.statusCode, on.body).toBe(200);

    const refused = await deploy(cookie, creds());
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("email_code_required");

    const wrong = await deploy(cookie, creds({ emailCode: await requestCode("terminal.enable") }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("email_code_wrong_action");
    expect(startDeploy).not.toHaveBeenCalled();

    const code = await requestCode("deploy.override");
    expect(sent.at(-1)).toContain("liberar os bloqueios de segurança de um deploy");
    const ok = await deploy(cookie, creds({ emailCode: code }));
    expect(ok.statusCode, ok.body).toBe(202);
    expect(startDeploy).toHaveBeenCalledWith("p1", { guardrailOverride: true, acceptedBlocks: ["privileged-container|app|serviço app"] });
    expect((await deploy(cookie, creds({ emailCode: code }))).json().error).toBe("email_code_required");
  });

  it("token de API (qualquer escopo) nunca pede override", async () => {
    const { cookie, creds } = await ready();
    const made = await app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers: { cookie },
      payload: { name: "ia", scope: "admin", currentPassword: PASSWORD, code: (creds() as { code: string }).code },
    });
    expect(made.statusCode, made.body).toBe(201);
    const token = made.json().token as string;
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: { authorization: `Bearer ${token}` },
      payload: { guardrailOverride: true, currentPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    expect(startDeploy).not.toHaveBeenCalled();
  });

  it("sessão sintética de token que chegasse à rota também é recusada (defesa em profundidade)", async () => {
    const cookie = await login();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: { cookie, "x-teste-token": "1" },
      payload: { guardrailOverride: true, currentPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(startDeploy).not.toHaveBeenCalled();
  });
});
