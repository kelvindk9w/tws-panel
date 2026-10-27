/**
 * routes-cloudflare.test.ts — rotas da integração com a Cloudflare: reautenticação para
 * trocar/remover o token, token nunca na resposta nem na auditoria, prévia e aplicação.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import cloudflareRoutes, { buildCloudflareDns } from "../src/routes/cloudflare.js";
import setupRoutes from "../src/routes/setup.js";
import { CredentialVault } from "../src/services/credential-vault.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const CF_TOKEN = "cf_SEGREDO_do_token_9876";
const PASSWORD = "MinhaSenha123";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let dir: string;
let records: Array<Record<string, unknown>>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  dir = await mkdtemp(path.join(tmpdir(), "paas-routes-cf-"));
  records = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/user/tokens/verify")) return json({ success: true, result: { status: "active" } });
    if (url.includes("/zones?")) return json({ success: true, result: [{ id: "z1", name: "example.com" }], result_info: { total_pages: 1 } });
    if (url.includes("/dns_records?name=")) {
      const name = decodeURIComponent(/name=([^&]+)/.exec(url)![1]!);
      return json({ success: true, result: records.filter((r) => r.name === name) });
    }
    if (init?.method === "POST") {
      const rec = { id: `r${records.length + 1}`, ...JSON.parse(String(init.body)) };
      records.push(rec);
      return json({ success: true, result: rec });
    }
    return json({ success: false, errors: [] }, 404);
  };
  const config = { dataDir: dir, publicIp: "203.0.113.10", publicIpv6: null, panelDomain: null };
  const cloudflare = buildCloudflareDns(
    { config, deployService: { credentialVault: new CredentialVault(dir) }, auditService: ctx.auditService, log: { warn: () => undefined } } as never,
    { fetchImpl: fetchMock as unknown as typeof fetch },
  );
  app.decorate("cloudflareDns", cloudflare);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(cloudflareRoutes);
  await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } }));
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
  await rm(dir, { recursive: true, force: true });
});

const put = (payload: object) => app.inject({ method: "PUT", url: "/api/integrations/cloudflare", headers: { cookie }, payload });
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/integrations/cloudflare/${url}`, headers: { cookie }, payload });
const pick = (items: Array<{ id: string; status: string; fingerprint: string }>, id: string) =>
  items.filter((i) => i.id === id).map(({ id: itemId, status, fingerprint }) => ({ id: itemId, status, fingerprint }));
const status = () => app.inject({ method: "GET", url: "/api/integrations/cloudflare", headers: { cookie } });

describe("rotas da Cloudflare", () => {
  it("exigem sessão", async () => {
    expect((await app.inject({ method: "GET", url: "/api/integrations/cloudflare" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/integrations/cloudflare/dns/plan", payload: {} })).statusCode).toBe(401);
  });

  it("conectar pede a senha atual; o token nunca volta nem vai para a auditoria", async () => {
    expect((await put({ token: CF_TOKEN })).statusCode).toBe(400);
    const wrong = await put({ token: CF_TOKEN, currentPassword: "errada" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_current_password");
    expect((await status()).json().connected).toBe(false);

    const ok = await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ connected: true, hint: "9876", zones: ["example.com"] });
    expect(ok.body).not.toContain(CF_TOKEN);
    const current = await status();
    expect(current.json()).toMatchObject({ connected: true, hint: "9876" });
    expect(current.body).not.toContain(CF_TOKEN);
    const zones = await app.inject({ method: "GET", url: "/api/integrations/cloudflare/zones", headers: { cookie } });
    expect(zones.json()).toEqual({ zones: ["example.com"] });

    const audit = await ctx.auditService.list();
    expect(audit.entries.map((e) => e.action)).toContain("integration.cloudflare_connected");
    expect(JSON.stringify(audit.entries)).not.toContain(CF_TOKEN);
  });

  it("Global API Key é recusada com mensagem clara (400)", async () => {
    const res = await put({ token: "0123456789abcdef0123456789abcdef01234", currentPassword: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cloudflare_global_key");
  });

  it("remover também pede a senha e audita uma vez", async () => {
    await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    const wrong = await post("disconnect", { currentPassword: "errada" });
    expect(wrong.statusCode).toBe(401);
    expect((await status()).json().connected).toBe(true);
    const res = await post("disconnect", { currentPassword: PASSWORD });
    expect(res.json().connected).toBe(false);
    await post("disconnect", { currentPassword: PASSWORD });
    const removed = (await ctx.auditService.list()).entries.filter((e) => e.action === "integration.cloudflare_disconnected");
    expect(removed).toHaveLength(1);
  });

  it("sem conexão: zonas, prévia e aplicação respondem 409 (não 401)", async () => {
    const scope = { kind: "hosts", hosts: ["app.example.com"] };
    const zones = await app.inject({ method: "GET", url: "/api/integrations/cloudflare/zones", headers: { cookie } });
    const plan = await post("dns/plan", { scope });
    const apply = await post("dns/apply", { scope, items: [] });
    for (const res of [zones, plan, apply]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("cloudflare_not_connected");
    }
  });

  it("prévia e aplicação de nomes: cria só o marcado e audita", async () => {
    await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    const scope = { kind: "hosts", hosts: ["app.example.com", "www.app.example.com"] };
    const plan = await post("dns/plan", { scope });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().items.map((i: { status: string }) => i.status)).toEqual(["create", "create"]);
    const apply = await post("dns/apply", { scope, items: pick(plan.json().items, "A:app.example.com") });
    expect(apply.json()).toMatchObject({ created: 1, failed: 0 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "A", name: "app.example.com", content: "203.0.113.10", proxied: false, comment: "tws-panel" });
    const entry = (await ctx.auditService.list()).entries.find((e) => e.action === "cloudflare.dns_applied")!;
    expect(entry).toMatchObject({ target: "app.example.com, www.app.example.com", actor: "admin" });
  });

  it("e-mail: sem o plugin de e-mail avisa; corpo inválido é 400", async () => {
    await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    const mail = await post("dns/plan", { scope: { kind: "mail", domain: "example.com" } });
    expect(mail.statusCode).toBe(409);
    expect(mail.json().error).toBe("mail_unavailable");
    expect((await post("dns/plan", { scope: { kind: "hosts", hosts: [] } })).statusCode).toBe(400);
    expect((await post("dns/plan", { scope: { kind: "outro" } })).statusCode).toBe(400);
  });

  it("nome inválido é 400 com o código", async () => {
    await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    const res = await post("dns/plan", { scope: { kind: "hosts", hosts: ["nao valido"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_hosts");
  });

  it("o nome do e-mail aparece como alvo da auditoria (domínio normalizado)", async () => {
    await put({ token: CF_TOKEN, currentPassword: PASSWORD });
    app.cloudflareDns.setMailPlanInput(async (domain) => ({
      domain,
      mailHostname: `mail.${domain}`,
      serverHostname: `mail.${domain}`,
      serverIp: "203.0.113.10",
      dkimSelector: "mail",
      dkimPublicKey: "MIIB",
      dmarcStage: "none",
    }));
    const mailScope = { kind: "mail", domain: " Example.com " };
    const preview = await post("dns/plan", { scope: mailScope });
    const apply = await post("dns/apply", { scope: mailScope, items: pick(preview.json().items, "a") });
    expect(apply.statusCode, apply.body).toBe(200);
    const entry = (await ctx.auditService.list()).entries.find((e) => e.action === "cloudflare.dns_applied")!;
    expect(entry.target).toBe("example.com");
  });
});
