/**
 * setup-restart.test.ts — "Recomeçar do zero" pelo painel (Setup concluído).
 *
 * Pedido do dono do produto: refazer o assistente pelo painel, mas não para
 * qualquer um — com orientação na tela e confirmação forte. Aqui: senha atual,
 * digitar "recomeçar" e o código da verificação em duas etapas. Sem 2FA
 * ativo, o painel não tem como confirmar que é você por um segundo fator
 * (envio de e-mail ainda não existe): recusa e aponta o caminho.
 *
 * Efeito (igual ao scripts/reset-setup.sh --full): apaga a conta, as sessões e
 * o progresso do assistente; gera um token de setup NOVO (o antigo morre) e
 * devolve o link para continuar direto no assistente. Projetos ficam.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import setupRestartRoutes from "../src/routes/setup-restart.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  app.decorate("config", { setupTokenFile: path.join(ctx.dir, "setup-token") } as never);
  await writeFile(path.join(ctx.dir, "setup-token"), `${TOKEN}\n`);
  await writeFile(path.join(ctx.dir, "projects.json"), '{"projects":[{"id":"p1"}]}');
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(setupRestartRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  cookie = sessionCookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } }));
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

async function ativar2fa(): Promise<string> {
  const { secret } = (await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } })).json() as { secret: string };
  const code = totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
  await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code } });
  nowMs += TOTP_STEP_SECONDS * 1000;
  return secret;
}

function restart(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/settings/restart-setup", headers: { cookie }, payload });
}

describe("recomeçar do zero pelo painel", () => {
  it("sem 2FA ativo: recusa (409) e diz o caminho — nada é apagado", async () => {
    const res = await restart({ currentPassword: PASSWORD, confirm: "recomeçar" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    expect(res.json().message).toMatch(/verificação em duas etapas/);
    expect(res.json().message).toMatch(/reset-setup\.sh --full/);
    expect(await ctx.userStore.hasAdmin()).toBe(true);
  });

  it("confirmação errada, senha errada ou código errado: nada é apagado", async () => {
    const secret = await ativar2fa();
    const code = () => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
    expect((await restart({ currentPassword: PASSWORD, confirm: "sim", code: code() })).statusCode).toBe(400);
    expect((await restart({ currentPassword: "Errada12345X", confirm: "recomeçar", code: code() })).statusCode).toBe(401);
    expect((await restart({ currentPassword: PASSWORD, confirm: "recomeçar", code: "000000" })).statusCode).toBe(400);
    expect(await ctx.userStore.hasAdmin()).toBe(true);
  });

  it("tudo certo: apaga conta, sessões e progresso; gera token NOVO; projetos ficam; audita", async () => {
    const secret = await ativar2fa();
    const res = await restart({
      currentPassword: PASSWORD,
      confirm: "recomeçar",
      code: totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { setupUrl } = res.json() as { setupUrl: string };
    const novo = new URL(setupUrl, "http://x").searchParams.get("token")!;
    expect(novo).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(novo).not.toBe(TOKEN);

    expect(await ctx.userStore.hasAdmin()).toBe(false);
    expect((await ctx.setupState.load()).completed).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await readFile(path.join(ctx.dir, "setup-token"), "utf8")).trim()).toBe(novo);
    // token antigo morto, novo vale
    const velho = await app.inject({ method: "GET", url: "/api/setup/status", headers: { [SETUP_TOKEN_HEADER]: TOKEN } });
    expect(velho.statusCode).toBe(401);
    const bom = await app.inject({ method: "GET", url: "/api/setup/status", headers: { [SETUP_TOKEN_HEADER]: novo } });
    expect(bom.statusCode).toBe(200);
    expect(await readFile(path.join(ctx.dir, "projects.json"), "utf8")).toContain("p1");
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "setup.restarted")).toBe(true);
  });
});
