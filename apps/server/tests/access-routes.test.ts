/**
 * access-routes.test.ts — Segurança → Acesso: chaves SSH, senha do usuário Linux, fail2ban e kit.
 *
 * Contra uma app Fastify real (inject) com um host bridge FALSO que entende os comandos que os
 * construtores de @paas/security montam (authorized_keys em memória). Confere o que o usuário vê/faz:
 * reautenticação (senha + 2FA obrigatório + código por e-mail quando ligado), que nunca remove a
 * última chave, que a senha do Linux não aparece em comando nem em auditoria, e os erros em português.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import {
  PASSWORD_WINDOW_COMMAND,
  buildChpasswdCommand,
  FAIL2BAN_LIST_COMMAND,
  SSH_FACTS_COMMAND,
  buildSshKeyAddCommand,
  buildSshKeyRemoveCommand,
  buildSshKeysListCommand,
  buildUnbanCommand,
  isAllowedHostCommand,
  parseAuthorizedKeys,
} from "@paas/security";
import accessRoutes from "../src/routes/access.js";
import authRoutes from "../src/routes/auth.js";
import emailCodeRoutes from "../src/routes/email-code.js";
import setupRoutes from "../src/routes/setup.js";
import { AccessService, type AccessRunner } from "../src/services/access-service.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { ed25519Line, rsaLine } from "./ssh-fixture.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const LINUX_PASSWORD = "uma-senha-linux-bem-longa";
const USER = "admin";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;

interface FakeHost {
  keys: string;
  commands: string[];
  stdin: Array<{ cmd: string; input: string }>;
  fail2ban: string;
  unbanOk: boolean;
  chpasswd: { code: number; stderr: string };
  failList: boolean;
  noUser: boolean;
  throwOn: string | null;
  window: string;
}
let host: FakeHost;
let sent: string[];

function fakeRunner(): AccessRunner {
  return {
    ensureReady: async () => undefined,
    exec: async (cmd) => {
      expect(isAllowedHostCommand(cmd, "/opt/paas-hardening"), `fora da allowlist: ${cmd.slice(0, 80)}`).toBe(true);
      host.commands.push(cmd);
      if (host.throwOn && cmd.includes(host.throwOn)) throw new Error("docker caiu");
      if (cmd === buildSshKeysListCommand(USER)) {
        if (host.noUser) return { code: 3, stdout: "::sem-usuario\n", stderr: "" };
        if (host.failList) return { code: 1, stdout: "", stderr: "permissão negada\noutra linha" };
        return { code: 0, stdout: host.keys, stderr: "" };
      }
      if (cmd === FAIL2BAN_LIST_COMMAND) return { code: 0, stdout: host.fail2ban, stderr: "" };
      if (cmd === PASSWORD_WINDOW_COMMAND) return { code: 0, stdout: host.window, stderr: "" };
      if (cmd === SSH_FACTS_COMMAND) return { code: 0, stdout: "256 SHA256:abc host (ED25519)\n::porta\nport 22\n", stderr: "" };
      const add = /^u='admin'; k='([^']+)'; /.exec(cmd);
      if (add) {
        if (cmd !== buildSshKeyAddCommand(USER, add[1]!)) throw new Error("add fora do construtor");
        const blob = add[1]!.split(" ")[1]!;
        if (host.keys.includes(blob)) return { code: 0, stdout: "::ja-existe\n", stderr: "" };
        host.keys += `${add[1]}\n`;
        return { code: 0, stdout: "::adicionada\n", stderr: "" };
      }
      const rem = /^u='admin'; b='([^']+)'; /.exec(cmd);
      if (rem) {
        if (cmd !== buildSshKeyRemoveCommand(USER, rem[1]!)) throw new Error("remove fora do construtor");
        const lines = host.keys.split("\n").filter(Boolean);
        const left = lines.filter((l) => !l.includes(rem[1]!));
        if (left.length === lines.length) return { code: 6, stdout: "::nao-encontrada\n", stderr: "" };
        if (left.length === 0) return { code: 5, stdout: "::ultima\n", stderr: "" };
        host.keys = `${left.join("\n")}\n`;
        return { code: 0, stdout: "::removida\n", stderr: "" };
      }
      if (cmd.startsWith("ok=0; ")) {
        const ip = /unbanip '([^']+)'/.exec(cmd)![1]!;
        if (cmd !== buildUnbanCommand(ip)) throw new Error("unban fora do construtor");
        return host.unbanOk ? { code: 0, stdout: "::desbloqueado\n", stderr: "" } : { code: 6, stdout: "::nao-bloqueado\n", stderr: "" };
      }
      throw new Error(`comando inesperado: ${cmd.slice(0, 80)}`);
    },
    execWithInput: async (cmd, input) => {
      expect(cmd).toBe(buildChpasswdCommand(USER));
      expect(isAllowedHostCommand(cmd, "/opt/paas-hardening")).toBe(true);
      host.stdin.push({ cmd, input });
      return { code: host.chpasswd.code, stdout: "", stderr: host.chpasswd.stderr };
    },
  };
}

async function build(access: { runner: AccessRunner | null; user: string | null }) {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  app.decorate("accessService", new AccessService({ ...access, audit: ctx.auditService }));
  app.decorate("panelDomainService", {
    facts: async () => ({ ipAddress: "203.0.113.7", domain: "painel.example.com", active: true, certificateValid: true }),
  } as never);
  ctx.emailCode.setMailer({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
    send: async (msg) => void sent.push(msg.text),
    isHostedAddress: async () => false,
  });
  await app.register(authRoutes);
  await app.register(emailCodeRoutes);
  await app.register(accessRoutes);
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
  nowMs = Date.UTC(2026, 9, 27, 12, 0, 0);
  sent = [];
  host = {
    keys: `${ed25519Line("notebook-antigo")}\n`,
    commands: [],
    stdin: [],
    fail2ban: "",
    unbanOk: true,
    chpasswd: { code: 0, stderr: "" },
    failList: false,
    noUser: false,
    throwOn: null,
    window: "::fechada\n",
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

const post = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: { cookie }, payload });
const get = (cookie: string, url: string) => app.inject({ method: "GET", url, headers: { cookie } });

/** Sessão com 2FA ligado; devolve uma função que gera as credenciais de cada ação (um passo novo a cada uso). */
async function ready() {
  const cookie = await loginCookie();
  const secret = await enable2fa(cookie);
  const creds = (extra: Record<string, unknown> = {}) => {
    nextStep();
    return { currentPassword: PASSWORD, code: codeNow(secret), ...extra };
  };
  return { cookie, secret, creds };
}

describe("GET /api/security/access", () => {
  it("lista as chaves do usuário de administração com impressão digital", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    const res = await get(cookie, "/api/security/access");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ available: true, reason: null, user: USER, twoFactorEnabled: false, emailCodeEnabled: false, keysError: null });
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ type: "ssh-ed25519", comment: "notebook-antigo", hasOptions: false });
    expect(body.keys[0].fingerprint).toMatch(/^SHA256:/);
  });

  it("avisa quando a janela de SSH por senha (console do provedor) está aberta", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    expect((await get(cookie, "/api/security/access")).json().passwordWindow).toEqual({ open: false, expiresAt: null });
    host.window = `::aberta\n${Math.floor(nowMs / 1000) + 600}\n`;
    const open = (await get(cookie, "/api/security/access")).json().passwordWindow;
    expect(open.open).toBe(true);
    expect(open.expiresAt).toBe(new Date(nowMs + 600_000).toISOString());
    host.window = "lixo";
    expect((await get(cookie, "/api/security/access")).json().passwordWindow).toBeNull();
    host.throwOn = "/etc/ssh/sshd_config.d/00-paas-recuperacao.conf";
    expect((await get(cookie, "/api/security/access")).json().passwordWindow).toBeNull();
  });

  it("fora da VPS real, ou com terminal como root: indisponível, com o motivo", async () => {
    await build({ runner: null, user: null });
    const cookie = await loginCookie();
    let body = (await get(cookie, "/api/security/access")).json();
    expect(body).toMatchObject({ available: false, user: null, keys: [] });
    expect(body.reason).toMatch(/só existe no painel instalado na VPS/);
    await closeAuthTestApp(ctx);
    await build({ runner: fakeRunner(), user: "root" });
    body = (await get(await loginCookie(), "/api/security/access")).json();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/abre o terminal como root/);
    // a escrita também recusa
    const { cookie: c2, creds } = await ready();
    const res = await post(c2, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("access_unavailable");
  });

  it("falha ao ler as chaves não derruba a tela: keysError explica", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    host.failList = true;
    let body = (await get(cookie, "/api/security/access")).json();
    expect(body.available).toBe(true);
    expect(body.keysError).toMatch(/Não foi possível ler as chaves: permissão negada/);
    host.failList = false;
    host.noUser = true;
    body = (await get(cookie, "/api/security/access")).json();
    expect(body.keysError).toMatch(/usuário admin não existe/);
  });

  it("exige sessão", async () => {
    await build({ runner: fakeRunner(), user: USER });
    expect((await app.inject({ method: "GET", url: "/api/security/access" })).statusCode).toBe(401);
  });
});

describe("adicionar chave", () => {
  it("exige a verificação em duas etapas ligada (409) e a senha certa (401)", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    let res = await post(cookie, "/api/security/access/keys", { currentPassword: PASSWORD, publicKey: ed25519Line() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    const { cookie: c2, creds } = await ready();
    res = await post(c2, "/api/security/access/keys", { ...creds(), currentPassword: "errada", publicKey: ed25519Line() });
    expect(res.statusCode).toBe(401);
    res = await post(c2, "/api/security/access/keys", { currentPassword: PASSWORD, publicKey: ed25519Line() });
    expect(res.statusCode).toBe(400); // sem o código do app
    expect(host.commands.filter((c) => c.includes("k='"))).toHaveLength(0);
  });

  it("adiciona, devolve a lista nova e audita sem a chave inteira", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    const line = ed25519Line("notebook-novo");
    const res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: `  ${line}  ` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.key).toMatchObject({ type: "ssh-ed25519", comment: "notebook-novo" });
    expect(body.keys).toHaveLength(2);
    expect(parseAuthorizedKeys(host.keys)).toHaveLength(2);
    await ctx.auditService.flush();
    const entry = (await ctx.auditService.list()).entries.find((e) => e.action === "auth.ssh_key_added")!;
    expect(entry.detail).toContain(body.key.fingerprint);
    expect(entry.detail).not.toContain(line.split(" ")[1]);
  });

  it("recusa chave inválida, RSA fraca, com opções e repetida", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    let res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: "isto não é uma chave" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_public_key" });
    res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: `command="rm -rf /" ${ed25519Line()}` });
    expect(res.json().error).toBe("invalid_public_key");
    res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: rsaLine(2048) });
    expect(res.json().message).toMatch(/Chave RSA fraca \(2048 bits\)/);
    const dup = host.keys.trim();
    res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: dup });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("key_exists");
    expect(parseAuthorizedKeys(host.keys)).toHaveLength(1);
  });

  it("falha do host vira 502 com o motivo; erro inesperado vira 500 genérico", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    const runner = (app.accessService as unknown as { opts: { runner: AccessRunner } }).opts.runner;
    const original = runner.exec;
    runner.exec = async (cmd, o) => (cmd.includes("k='") ? { code: 4, stdout: "", stderr: "disco cheio\n" } : original(cmd, o));
    let res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line() });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/disco cheio/);
    runner.exec = async (cmd, o) => (cmd.includes("k='") ? { code: 3, stdout: "::sem-usuario\n", stderr: "" } : original(cmd, o));
    res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line() });
    expect(res.json().error).toBe("user_not_found");
    runner.exec = original;
    host.throwOn = "k='";
    res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line() });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "Não foi possível concluir agora. Tente de novo em instantes." });
  });
});

describe("remover chave", () => {
  async function withTwoKeys() {
    await build({ runner: fakeRunner(), user: USER });
    const s = await ready();
    const second = ed25519Line("reserva");
    expect((await post(s.cookie, "/api/security/access/keys", { ...s.creds(), publicKey: second })).statusCode).toBe(200);
    const keys = parseAuthorizedKeys(host.keys);
    return { ...s, keys };
  }

  it("remove pela impressão digital e devolve a lista", async () => {
    const { cookie, creds, keys } = await withTwoKeys();
    const res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().keys).toHaveLength(1);
    expect(res.json().keys[0].comment).toBe("reserva");
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.ssh_key_removed")).toBe(true);
  });

  it("não remove a última chave (você não fica trancado fora)", async () => {
    const { cookie, creds, keys } = await withTwoKeys();
    await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    const res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[1]!.fingerprint });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "last_key" });
    expect(res.json().message).toMatch(/única chave/);
    expect(parseAuthorizedKeys(host.keys)).toHaveLength(1);
  });

  it("não deixa só uma chave com restrição (from=/command=): ela pode não servir de onde o dono está", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    const free = ed25519Line("livre");
    const restricted = ed25519Line("restrita");
    host.keys = `${free}\nfrom="192.0.2.1",restrict ${restricted}\n`;
    const keys = parseAuthorizedKeys(host.keys);
    expect(keys.map((k) => k.hasOptions)).toEqual([false, true]);
    const res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last_key");
    expect(res.json().message).toMatch(/sem restrição/);
    expect(host.commands.some((c) => c.includes("b='"))).toBe(false);
  });

  it("pasta ~/.ssh insegura (link simbólico, outro dono): 409 ssh_dir_unsafe, nada é gravado", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds, keys } = await (async () => {
      const s = await ready();
      return { ...s, keys: parseAuthorizedKeys(host.keys) };
    })();
    const runner = (app.accessService as unknown as { opts: { runner: AccessRunner } }).opts.runner;
    const original = runner.exec;
    runner.exec = async (cmd, o) => (cmd.includes("runuser -u") && cmd.includes("sh -c") ? { code: 7, stdout: "", stderr: "" } : original(cmd, o));
    let res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line("nova") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ssh_dir_unsafe");
    res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect([404, 409]).toContain(res.statusCode);
  });

  it("impressão digital desconhecida: 404; o host recusando a última ou não achando: mesmos erros", async () => {
    const { cookie, creds, keys } = await withTwoKeys();
    let res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: "SHA256:naoexistenaoexiste" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("key_not_found");
    const runner = (app.accessService as unknown as { opts: { runner: AccessRunner } }).opts.runner;
    const original = runner.exec;
    runner.exec = async (cmd, o) => (cmd.startsWith("u='admin'; b=") ? { code: 5, stdout: "::ultima\n", stderr: "" } : original(cmd, o));
    res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect(res.json().error).toBe("last_key");
    runner.exec = async (cmd, o) => (cmd.startsWith("u='admin'; b=") ? { code: 6, stdout: "::nao-encontrada\n", stderr: "" } : original(cmd, o));
    res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect(res.json().error).toBe("key_not_found");
    runner.exec = async (cmd, o) => (cmd.startsWith("u='admin'; b=") ? { code: 4, stdout: "", stderr: "" } : original(cmd, o));
    res = await post(cookie, "/api/security/access/keys/remove", { ...creds(), fingerprint: keys[0]!.fingerprint });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/código 4/);
  });
});

describe("senha do usuário Linux", () => {
  it("troca pelo chpasswd com a senha só na entrada padrão — nunca no comando nem na auditoria", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    const res = await post(cookie, "/api/security/access/linux-password", { ...creds(), newLinuxPassword: LINUX_PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(host.stdin).toEqual([{ cmd: buildChpasswdCommand(USER), input: `${LINUX_PASSWORD}\n` }]);
    expect(host.commands.join("\n")).not.toContain(LINUX_PASSWORD);
    await ctx.auditService.flush();
    const all = JSON.stringify((await ctx.auditService.list()).entries);
    expect(all).not.toContain(LINUX_PASSWORD);
    expect(all).toContain("auth.linux_password_changed");
    expect(JSON.stringify(res.json())).not.toContain(LINUX_PASSWORD);
  });

  it("recusa senha curta ou com quebra de linha; a VPS recusando vira 502 sem repetir a senha", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    let res = await post(cookie, "/api/security/access/linux-password", { ...creds(), newLinuxPassword: "curta" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/pelo menos 12 caracteres/);
    res = await post(cookie, "/api/security/access/linux-password", { ...creds(), newLinuxPassword: "senha comprida\ncom quebra" });
    expect(res.json().error).toBe("weak_linux_password");
    expect(host.stdin).toHaveLength(0);
    host.chpasswd = { code: 1, stderr: `BAD PASSWORD: ${LINUX_PASSWORD} é muito simples\n` };
    res = await post(cookie, "/api/security/access/linux-password", { ...creds(), newLinuxPassword: LINUX_PASSWORD });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("BAD PASSWORD: ***");
    expect(res.json().message).not.toContain(LINUX_PASSWORD);
    host.chpasswd = { code: 1, stderr: "" };
    res = await post(cookie, "/api/security/access/linux-password", { ...creds(), newLinuxPassword: LINUX_PASSWORD });
    expect(res.json().message).toMatch(/\(código 1\)/);
  });
});

describe("bloqueios do fail2ban", () => {
  const SSHD_OUT = [
    "::jail sshd",
    "Status for the jail: sshd",
    "   `- Banned IP list:\t203.0.113.9 198.51.100.4",
    "::jail recidive",
    "   `- Banned IP list:\t",
  ].join("\n");

  it("lista os IPs bloqueados por jail", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    host.fail2ban = SSHD_OUT;
    const body = (await get(cookie, "/api/security/access/bans")).json();
    expect(body).toMatchObject({ available: true, reason: null });
    expect(body.jails).toEqual([
      { jail: "sshd", ips: ["203.0.113.9", "198.51.100.4"] },
      { jail: "recidive", ips: [] },
    ]);
    expect(typeof body.yourIp === "string" || body.yourIp === null).toBe(true);
  });

  it("sem fail2ban: indisponível, com o motivo; fora da VPS também", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    host.fail2ban = "::jail sshd\nbash: fail2ban-client: command not found\n";
    let body = (await get(cookie, "/api/security/access/bans")).json();
    expect(body).toMatchObject({ available: false, jails: [] });
    expect(body.reason).toMatch(/fail2ban não está ativo/);
    await closeAuthTestApp(ctx);
    await build({ runner: null, user: null });
    body = (await get(await loginCookie(), "/api/security/access/bans")).json();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/só existe no painel instalado na VPS/);
  });

  it("desbloqueia com reautenticação e devolve a lista atualizada", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    host.fail2ban = SSHD_OUT;
    const res = await post(cookie, "/api/security/access/bans/unban", { ...creds(), ip: "203.0.113.9" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jails).toHaveLength(2);
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.fail2ban_unban")).toBe(true);
    const wrongPassword = await post(cookie, "/api/security/access/bans/unban", { ...creds(), currentPassword: "errada", ip: "203.0.113.9" });
    expect(wrongPassword.statusCode).toBe(401);
  });

  it("IP inválido: 400; IP que não estava bloqueado: 404; falha do host: 502; sem VPS real: 409", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    let res = await post(cookie, "/api/security/access/bans/unban", { ...creds(), ip: "não-é-ip" });
    expect(res.json().error).toBe("invalid_ip");
    host.unbanOk = false;
    res = await post(cookie, "/api/security/access/bans/unban", { ...creds(), ip: "203.0.113.9" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_banned");
    const runner = (app.accessService as unknown as { opts: { runner: AccessRunner } }).opts.runner;
    const original = runner.exec;
    runner.exec = async (cmd, o) => (cmd.startsWith("ok=0;") ? { code: 255, stdout: "", stderr: "fail2ban parado\n" } : original(cmd, o));
    res = await post(cookie, "/api/security/access/bans/unban", { ...creds(), ip: "203.0.113.9" });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/fail2ban parado/);
    await closeAuthTestApp(ctx);
    await build({ runner: null, user: null });
    const s = await ready();
    res = await post(s.cookie, "/api/security/access/bans/unban", { ...s.creds(), ip: "203.0.113.9" });
    expect(res.statusCode).toBe(409);
  });
});

describe("kit de recuperação", () => {
  it("devolve os dados sem nenhum segredo e audita", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    const res = await post(cookie, "/api/security/access/kit", creds());
    expect(res.statusCode, res.body).toBe(200);
    const kit = res.json();
    expect(kit).toMatchObject({
      panelAddress: "painel.example.com",
      panelAddressIp: "203.0.113.7",
      linuxUser: USER,
      sshPort: 22,
      recoveryCodesLeft: 10,
      emailCodeEnabled: false,
      installDir: "/opt/tws-panel",
    });
    expect(kit.keys).toHaveLength(1);
    expect(kit.hostKeys).toEqual(["256 SHA256:abc host (ED25519)"]);
    const text = JSON.stringify(kit);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/passwordHash|secret|recoveryHashes/i);
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.recovery_kit")).toBe(true);
  });

  it("sem VPS real: o kit sai sem chaves nem porta; sem domínio ativo usa o IP", async () => {
    await build({ runner: null, user: null });
    (app.panelDomainService as unknown as { facts: () => Promise<unknown> }).facts = async () => ({
      ipAddress: "203.0.113.7",
      domain: null,
      active: false,
      certificateValid: false,
    });
    const { cookie, creds } = await ready();
    const kit = (await post(cookie, "/api/security/access/kit", creds())).json();
    expect(kit).toMatchObject({ panelAddress: "203.0.113.7", linuxUser: null, sshPort: null, keys: [], hostKeys: [] });
  });

  it("exige 2FA e senha", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const cookie = await loginCookie();
    expect((await post(cookie, "/api/security/access/kit", { currentPassword: PASSWORD })).statusCode).toBe(409);
  });
});

describe("com o código por e-mail ligado, todas as ações pedem o código", () => {
  it("chaves, senha do Linux, desbloqueio e kit: sem o código recusa, com o código vale uma vez", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
    const { cookie, creds } = await ready();
    const requestCode = async () => {
      nowMs += 31_000;
      const r = await app.inject({ method: "POST", url: "/api/auth/email-code/send", headers: { cookie } });
      expect(r.statusCode, r.body).toBe(200);
      return /\b(\d{6})\b/.exec(sent.at(-1)!)![1]!;
    };
    const first = await requestCode();
    const on = await post(cookie, "/api/auth/email-code/enable", { ...creds(), emailCode: first });
    expect(on.statusCode, on.body).toBe(200);

    host.fail2ban = "::jail sshd\n   `- Banned IP list:\t203.0.113.9\n";
    const actions: Array<[string, Record<string, unknown>]> = [
      ["/api/security/access/keys", { publicKey: ed25519Line("a") }],
      ["/api/security/access/linux-password", { newLinuxPassword: LINUX_PASSWORD }],
      ["/api/security/access/bans/unban", { ip: "203.0.113.9" }],
      ["/api/security/access/kit", {}],
    ];
    for (const [url, extra] of actions) {
      const refused = await post(cookie, url, { ...creds(), ...extra });
      expect(refused.statusCode, url).toBe(400);
      expect(refused.json().error, url).toBe("email_code_required");
      const code = await requestCode();
      const ok = await post(cookie, url, { ...creds({ emailCode: code }), ...extra });
      expect(ok.statusCode, `${url} ${ok.body}`).toBe(200);
      // o mesmo código não vale duas vezes
      const reuse = await post(cookie, url, { ...creds({ emailCode: code }), ...extra });
      expect(reuse.json().error, url).toBe("email_code_required");
    }
  });
});

describe("bordas de cobertura", () => {
  it("o kit sai mesmo se a lista de chaves falhar", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    host.failList = true;
    const res = await post(cookie, "/api/security/access/kit", creds());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().keys).toEqual([]);
  });

  it("2FA bloqueado por excesso de erros vira 429 two_factor_locked na reautenticação", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    app.twoFactor.verifyDetailed = async () => ({ status: "locked", retryAfterSec: 120 }) as never;
    const res = await post(cookie, "/api/security/access/keys", { ...creds(), publicKey: ed25519Line("x") });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("two_factor_locked");
    expect(res.headers["retry-after"]).toBe("120");
  });

  it("erros repetidos no código por e-mail estouram o limite de tentativas (429)", async () => {
    await build({ runner: fakeRunner(), user: USER });
    const { cookie, creds } = await ready();
    app.emailCode.isEnabled = () => true;
    app.emailCode.check = () => ({ status: "invalid", attemptsLeft: 1 });
    let last = 0;
    for (let i = 0; i < 20 && last !== 429; i += 1) {
      last = (await post(cookie, "/api/security/access/keys", { ...creds({ emailCode: "000000" }), publicKey: ed25519Line("x") })).statusCode;
    }
    expect(last).toBe(429);
  });
});
