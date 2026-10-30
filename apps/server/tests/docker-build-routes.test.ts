/**
 * docker-build-routes.test.ts — Saúde da VPS → Docker e BuildKit: leitura do buildx (painel e VPS) e a correção
 * de um clique, com a mesma reautenticação das ações de acesso à VPS (senha + 2FA obrigatório).
 *
 * Contra uma app Fastify real (inject) com um host bridge FALSO que só aceita comandos da allowlist.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { HOST_BUILDX_STATUS_COMMAND, buildBuildxInstallCommand, isAllowedHostCommand } from "@paas/security";
import dockerBuildRoutes from "../src/routes/docker-build.js";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { DockerBuildService, type PanelBuildxCheck } from "../src/services/docker-build-service.js";
import type { AccessRunner } from "../src/services/access-service.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;

interface FakeHost {
  buildx: boolean;
  origin: string;
  statusCode: number;
  statusStderr: string;
  statusOut: string | null;
  installCode: number;
  installStderr: string;
  throwOnStatus: boolean;
  commands: string[];
}
let host: FakeHost;
let panel: PanelBuildxCheck;

function fakeRunner(): AccessRunner {
  return {
    ensureReady: async () => undefined,
    exec: async (cmd) => {
      expect(isAllowedHostCommand(cmd, "/opt/paas-hardening"), `fora da allowlist: ${cmd.slice(0, 80)}`).toBe(true);
      host.commands.push(cmd);
      if (cmd === HOST_BUILDX_STATUS_COMMAND) {
        if (host.throwOnStatus) throw new Error("docker caiu\noutra linha");
        return { code: host.statusCode, stdout: host.statusOut ?? `buildx=${host.buildx ? 1 : 0}\norigin=${host.origin}\n`, stderr: host.statusStderr };
      }
      if (host.origin === "docker-ce" && cmd === buildBuildxInstallCommand("docker-ce")) {
        if (host.installCode === 0) host.buildx = true;
        return { code: host.installCode, stdout: "", stderr: host.installStderr };
      }
      if (host.origin === "docker.io" && cmd === buildBuildxInstallCommand("docker.io")) {
        if (host.installCode === 0) host.buildx = true;
        return { code: host.installCode, stdout: "", stderr: host.installStderr };
      }
      throw new Error(`comando inesperado: ${cmd.slice(0, 80)}`);
    },
    execWithInput: async () => {
      throw new Error("não deveria usar entrada padrão");
    },
  };
}

async function build(runner: AccessRunner | null) {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  app.decorate("dockerBuildService", new DockerBuildService({ runner, panelCheck: async () => panel, audit: ctx.auditService }));
  await app.register(authRoutes);
  await app.register(dockerBuildRoutes);
  await app.register(setupRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
}

beforeEach(() => {
  nowMs = Date.UTC(2026, 9, 30, 12, 0, 0);
  panel = { ok: true, version: "docker/buildx v0.38.1" };
  host = {
    buildx: false,
    origin: "docker-ce",
    statusCode: 0,
    statusStderr: "",
    statusOut: null,
    installCode: 0,
    installStderr: "",
    throwOnStatus: false,
    commands: [],
  };
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);

async function loginCookie(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

async function ready() {
  const cookie = await loginCookie();
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const en = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: codeNow(secret) } });
  expect(en.statusCode, en.body).toBe(200);
  const creds = () => {
    nextStep();
    return { currentPassword: PASSWORD, code: codeNow(secret) };
  };
  return { cookie, creds };
}

const get = (cookie: string) => app.inject({ method: "GET", url: "/api/health/docker-build", headers: { cookie } });
const fix = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/health/docker-build/fix", headers: { cookie }, payload });

describe("GET /api/health/docker-build", () => {
  it("tudo com buildx: ok, sem comandos manuais", async () => {
    host.buildx = true;
    await build(fakeRunner());
    const body = (await get(await loginCookie())).json();
    expect(body).toMatchObject({
      ok: true,
      panel: { buildx: true, version: "docker/buildx v0.38.1", detail: null },
      host: { available: true, buildx: true, origin: "docker-ce", fixable: false, manualCommands: [] },
    });
  });

  it("VPS sem buildx e origem conhecida: corrigível, com o pacote certo nos comandos manuais", async () => {
    await build(fakeRunner());
    let body = (await get(await loginCookie())).json();
    expect(body.ok).toBe(false);
    expect(body.host).toMatchObject({ buildx: false, origin: "docker-ce", fixable: true });
    expect(body.host.manualCommands).toContain("sudo apt-get install -y docker-buildx-plugin");
    host.origin = "docker.io";
    body = (await get(await loginCookie())).json();
    expect(body.host.manualCommands).toContain("sudo apt-get install -y docker-buildx");
  });

  it("origem não reconhecida: não é corrigível pelo painel e mostra os comandos manuais", async () => {
    host.origin = "unknown";
    await build(fakeRunner());
    const body = (await get(await loginCookie())).json();
    expect(body.host).toMatchObject({ buildx: false, origin: "unknown", fixable: false });
    expect(body.host.manualCommands.join("\n")).toContain("docker-buildx-plugin");
    expect(body.host.manualCommands.join("\n")).toContain("docker-buildx\n");
  });

  it("buildx ausente no CLI do painel: aponta o motivo", async () => {
    panel = { ok: false, detail: "docker: unknown command: docker buildx" };
    host.buildx = true;
    await build(fakeRunner());
    const body = (await get(await loginCookie())).json();
    expect(body.ok).toBe(false);
    expect(body.panel).toEqual({ buildx: false, version: null, detail: "docker: unknown command: docker buildx" });
  });

  it("painel sem versão nem detalhe vira null", async () => {
    panel = { ok: true };
    host.buildx = true;
    await build(fakeRunner());
    expect((await get(await loginCookie())).json().panel).toEqual({ buildx: true, version: null, detail: null });
    panel = { ok: false };
    expect((await get(await loginCookie())).json().panel.detail).toBeNull();
  });

  it("fora da VPS real: o lado da VPS fica indisponível, com o motivo", async () => {
    await build(null);
    const body = (await get(await loginCookie())).json();
    expect(body.host).toMatchObject({ available: false, buildx: null, origin: null, fixable: false });
    expect(body.host.reason).toMatch(/só existe no painel instalado na VPS/);
    expect(body.ok).toBe(true);
  });

  it("leitura que falha ou vem ilegível não vira 'ok' nem derruba a tela", async () => {
    await build(fakeRunner());
    const cookie = await loginCookie();
    host.statusCode = 1;
    host.statusStderr = "permissão negada\noutra";
    let body = (await get(cookie)).json();
    expect(body.host).toMatchObject({ available: false, buildx: null });
    expect(body.host.reason).toMatch(/permissão negada/);
    host.statusCode = 0;
    host.statusStderr = "";
    host.statusOut = "lixo";
    body = (await get(cookie)).json();
    expect(body.host.reason).toMatch(/código 0/);
    host.throwOnStatus = true;
    body = (await get(cookie)).json();
    expect(body.host.reason).toMatch(/Não foi possível falar com a VPS: docker caiu/);
  });

  it("exige sessão", async () => {
    await build(fakeRunner());
    expect((await app.inject({ method: "GET", url: "/api/health/docker-build" })).statusCode).toBe(401);
  });
});

describe("POST /api/health/docker-build/fix", () => {
  it("exige 2FA ligado (409), a senha certa (401) e o código do app (400)", async () => {
    await build(fakeRunner());
    const cookie = await loginCookie();
    let res = await fix(cookie, { currentPassword: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    const { cookie: c2, creds } = await ready();
    res = await fix(c2, { ...creds(), currentPassword: "errada" });
    expect(res.statusCode).toBe(401);
    res = await fix(c2, { currentPassword: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(host.commands.some((c) => c.includes("apt-get"))).toBe(false);
  });

  it("sem sessão: 401, e nada roda no host", async () => {
    await build(fakeRunner());
    const res = await app.inject({ method: "POST", url: "/api/health/docker-build/fix", payload: { currentPassword: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(host.commands).toHaveLength(0);
  });

  it("instala o pacote da origem (docker-ce), devolve o estado novo e audita", async () => {
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toMatchObject({ ok: true, host: { buildx: true, fixable: false } });
    expect(host.commands).toContain(buildBuildxInstallCommand("docker-ce"));
    const audit = (await ctx.auditService.list()).entries;
    expect(audit.some((e) => e.action === "docker.buildx_installed" && e.detail.includes("docker-ce"))).toBe(true);
  });

  it("origem docker.io instala docker-buildx", async () => {
    host.origin = "docker.io";
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode, res.body).toBe(200);
    expect(host.commands).toContain(buildBuildxInstallCommand("docker.io"));
  });

  it("origem desconhecida ou snap: recusa (409) e não instala nada", async () => {
    for (const origin of ["unknown", "snap"]) {
      host.origin = origin;
      host.commands = [];
      await build(fakeRunner());
      const { cookie, creds } = await ready();
      const res = await fix(cookie, creds());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("docker_origin_unknown");
      expect(host.commands.some((c) => c.includes("apt-get"))).toBe(false);
      await closeAuthTestApp(ctx);
    }
    await build(fakeRunner());
  });

  it("buildx já presente: 409 sem instalar", async () => {
    host.buildx = true;
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("buildx_present");
  });

  it("instalação que falha: 502 com o motivo e a dica do código por e-mail; audita a falha", async () => {
    host.installCode = 100;
    host.installStderr = "E: Unable to locate package docker-buildx-plugin\noutra";
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("host_failed");
    expect(res.json().message).toMatch(/Unable to locate package/);
    expect(res.json().message).toMatch(/código por e-mail/);
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "docker.buildx_failed")).toBe(true);
  });

  it("falha sem mensagem do apt: cai no código de saída", async () => {
    host.installCode = 1;
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.json().message).toMatch(/código 1/);
  });

  it("leitura prévia que falha: 502 e nada é instalado", async () => {
    host.statusCode = 1;
    host.statusStderr = "sem permissão";
    await build(fakeRunner());
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode).toBe(502);
    expect(host.commands.some((c) => c.includes("apt-get"))).toBe(false);
  });

  it("fora da VPS real: 409", async () => {
    await build(null);
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("docker_build_unavailable");
  });

  it("erro inesperado vira mensagem genérica em português (500)", async () => {
    await build({ ...fakeRunner(), ensureReady: async () => { throw new Error("boom"); } });
    const { cookie, creds } = await ready();
    const res = await fix(cookie, creds());
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/Não foi possível concluir agora/);
  });
});
