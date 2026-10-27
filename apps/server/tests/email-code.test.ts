/**
 * email-code.test.ts — código por e-mail como fator EXTRA opcional (Configurações → Segurança).
 *
 * Fluxo real contra uma app Fastify (inject) com e-mail falso: ligar (senha + código do app + código
 * recebido), valer nas ações sensíveis (trocar senha, desligar o 2FA, códigos de recuperação novos),
 * uso único, validade, limite de tentativas e de envios, preso à sessão, aviso de caixa na própria VPS.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_MAX_SENDS_PER_HOUR, EMAIL_CODE_TTL_MS, SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import emailCodeRoutes from "../src/routes/email-code.js";
import setupRoutes from "../src/routes/setup.js";
import { EmailCodeService, maskEmail, type EmailCodeMailer } from "../src/services/email-code.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const ADDRESS = "dono@example.com";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let sent: Array<{ to: string; subject: string; text: string; html: string }>;
let mailer: EmailCodeMailer;
let mailState: { ready: boolean; reason: string | null; hosted: boolean | null; failSend: boolean; failReadiness: boolean };

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 27, 12, 0, 0);
  sent = [];
  mailState = { ready: true, reason: null, hosted: false, failSend: false, failReadiness: false };
  mailer = {
    readiness: async () => {
      if (mailState.failReadiness) throw new Error("boom");
      return { ready: mailState.ready, reason: mailState.reason, from: "postmaster@example.com" };
    },
    send: async (msg) => {
      if (mailState.failSend) throw new Error("recusado pelo servidor");
      sent.push(msg);
    },
    isHostedAddress: async () => mailState.hosted,
  };
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  ctx.emailCode.setMailer(mailer);
  await app.register(authRoutes);
  await app.register(emailCodeRoutes);
  await app.register(setupRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);

async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

/** Login que já passa pelo 2FA (depois de ativado). */
async function loginWith2fa(secret: string): Promise<string> {
  nextStep();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: PASSWORD, code: codeNow(secret) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookieOf(res);
}

async function enable2fa(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    headers: { cookie },
    payload: { currentPassword: PASSWORD, code: codeNow(secret) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { secret, recoveryCodes: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
}

const post = (cookie: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

/** Pede o código e devolve os 6 dígitos que "chegaram" no e-mail. */
async function requestCode(cookie: string): Promise<string> {
  const before = sent.length;
  const res = await post(cookie, "/api/auth/email-code/send");
  expect(res.statusCode, res.body).toBe(200);
  expect(sent).toHaveLength(before + 1);
  return /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1]!;
}

/** Usuário com e-mail, 2FA ligado e (opcionalmente) o fator por e-mail ligado. */
async function prepare(opts: { emailFactor?: boolean } = {}) {
  const user = (await ctx.userStore.findByUsername("admin"))!;
  await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
  const first = await login();
  const { secret, recoveryCodes } = await enable2fa(first);
  let cookie = first;
  if (opts.emailFactor) {
    const code = await requestCode(cookie);
    nextStep();
    const res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true });
    nowMs += EMAIL_CODE_RESEND_GAP;
    cookie = first;
  }
  return { cookie, secret, recoveryCodes, userId: user.id };
}
const EMAIL_CODE_RESEND_GAP = 31_000;

describe("situação (GET /api/auth/email-code)", () => {
  it("começa desligado; mostra o que falta para ligar", async () => {
    const cookie = await login();
    let status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status).toMatchObject({ enabled: false, twoFactorEnabled: false, address: null, canEnable: false, mailReady: true });
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    mailState.hosted = true;
    await enable2fa(cookie);
    status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status).toMatchObject({ enabled: false, twoFactorEnabled: true, address: "d***@example.com", hostedHere: true, canEnable: true });
  });

  it("avisa quando o envio de e-mail do painel não está pronto, falha ao conferir ou não existe", async () => {
    const cookie = await login();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    await enable2fa(cookie);
    mailState.ready = false;
    mailState.reason = "Nenhum domínio de e-mail está com o DNS conferido.";
    let status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status).toMatchObject({ mailReady: false, mailReason: "Nenhum domínio de e-mail está com o DNS conferido.", canEnable: false });
    mailState.reason = null;
    status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status.mailReason).toMatch(/não está pronto/);
    mailState.failReadiness = true;
    status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status.mailReason).toMatch(/Não foi possível conferir/);
    ctx.emailCode.setMailer(null);
    status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status).toMatchObject({ mailReady: false, hostedHere: null });
    expect(status.mailReason).toMatch(/não está disponível/);
  });

  it("não derruba a tela se a conferência da caixa hospedada falhar", async () => {
    const cookie = await login();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    mailer.isHostedAddress = async () => {
      throw new Error("x");
    };
    const status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status.hostedHere).toBeNull();
  });

  it("exige sessão", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/email-code" })).statusCode).toBe(401);
  });
});

describe("envio do código", () => {
  it("sem e-mail cadastrado, sem envio configurado ou envio não pronto: 409 com o motivo", async () => {
    const cookie = await login();
    let res = await post(cookie, "/api/auth/email-code/send");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_missing");
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    mailState.ready = false;
    mailState.reason = "O servidor de e-mail está parado.";
    res = await post(cookie, "/api/auth/email-code/send");
    expect(res.json()).toMatchObject({ error: "email_unavailable", message: "O servidor de e-mail está parado." });
    mailState.failReadiness = true;
    res = await post(cookie, "/api/auth/email-code/send");
    expect(res.json().message).toMatch(/Não foi possível conferir/);
    ctx.emailCode.setMailer(null);
    res = await post(cookie, "/api/auth/email-code/send");
    expect(res.json().error).toBe("email_unavailable");
    expect(sent).toHaveLength(0);
  });

  it("manda o código por e-mail, mascarado na resposta, sem o código no log de auditoria", async () => {
    const cookie = await login();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    const res = await post(cookie, "/api/auth/email-code/send");
    expect(res.json()).toEqual({ sentTo: "d***@example.com", expiresInSec: 600, resendAfterSec: 30 });
    expect(sent[0]!.to).toBe(ADDRESS);
    expect(sent[0]!.text).toMatch(/10 minutos/);
    const code = /\b(\d{6})\b/.exec(sent[0]!.text)![1]!;
    expect(sent[0]!.html).toContain(code);
    await ctx.auditService.flush();
    const audit = await ctx.auditService.list();
    const entry = audit.entries.find((e) => e.action === "auth.email_code_sent")!;
    expect(entry.detail).not.toContain(code);
    expect(entry.detail).toContain("d***@example.com");
  });

  it("limita o intervalo (30 s) e o total por hora (5)", async () => {
    const cookie = await login();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    await requestCode(cookie);
    const quick = await post(cookie, "/api/auth/email-code/send");
    expect(quick.statusCode).toBe(429);
    expect(quick.json()).toMatchObject({ error: "email_code_rate_limited", retryAfterSec: 30 });
    expect(quick.headers["retry-after"]).toBe("30");
    for (let i = 1; i < EMAIL_CODE_MAX_SENDS_PER_HOUR; i += 1) {
      nowMs += 31_000;
      await requestCode(cookie);
    }
    nowMs += 31_000;
    const capped = await post(cookie, "/api/auth/email-code/send");
    expect(capped.statusCode).toBe(429);
    expect(capped.json().message).toMatch(/5 códigos por hora/);
    nowMs += 60 * 60_000;
    await requestCode(cookie);
  });

  it("falha do servidor de e-mail vira 502, sem guardar código e com auditoria", async () => {
    const cookie = await login();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    mailState.failSend = true;
    const res = await post(cookie, "/api/auth/email-code/send");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("email_send_failed");
    expect(res.json().message).not.toContain("recusado pelo servidor"); // o detalhe do SMTP não vai para a tela
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.email_code_send_failed")).toBe(true);
    mailState.failSend = false;
    await requestCode(cookie); // o intervalo só conta envio que deu certo
  });
});

describe("ligar e desligar", () => {
  it("ligar exige 2FA, e-mail cadastrado e envio pronto", async () => {
    const cookie = await login();
    const body = { currentPassword: PASSWORD, code: "123456", emailCode: "123456" };
    let res = await post(cookie, "/api/auth/email-code/enable", body);
    expect(res.json()).toMatchObject({ error: "cannot_enable" });
    expect(res.json().message).toMatch(/ative antes a verificação em duas etapas/);
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await enable2fa(cookie);
    res = await post(cookie, "/api/auth/email-code/enable", body);
    expect(res.json().message).toMatch(/Cadastre o seu e-mail/);
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    mailState.ready = false;
    mailState.reason = "Servidor parado.";
    res = await post(cookie, "/api/auth/email-code/enable", body);
    expect(res.json().message).toBe("Servidor parado.");
  });

  it("liga com senha + código do app + código recebido e audita; ligar de novo é 409", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    const status = (await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).json();
    expect(status.enabled).toBe(true);
    expect(status.enabledAt).toBeTruthy();
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.email_code_enabled")).toBe(true);
    nextStep();
    const again = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: "123456" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_enabled");
  });

  it("não liga sem pedir o código, com código errado ou com senha errada", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    const cookie = await login();
    const { secret } = await enable2fa(cookie);
    nextStep();
    let res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: "123456" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("email_code_required");
    const real = await requestCode(cookie);
    const wrong = real === "000000" ? "111111" : "000000";
    res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: wrong });
    expect(res.json()).toMatchObject({ error: "invalid_email_code", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - 1 });
    res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: "errada", code: codeNow(secret), emailCode: real });
    expect(res.statusCode).toBe(401);
    expect((await ctx.userStore.findById(user.id))!.emailCodeEnabledAt ?? null).toBeNull();
    // o código certo continua valendo: erro de senha não o consome
    res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: real });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("código do app errado não consome o código do e-mail (ele continua valendo)", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    const cookie = await login();
    const { secret } = await enable2fa(cookie);
    const real = await requestCode(cookie);
    nextStep();
    let res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: "000000", emailCode: real });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_two_factor_code");
    res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: real });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("desligar exige senha + código do app + código por e-mail; sem o fator ligado é 409", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    nextStep();
    let res = await post(cookie, "/api/auth/email-code/disable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: "123456" });
    expect(res.json().error).toBe("email_code_required");
    const code = await requestCode(cookie);
    res = await post(cookie, "/api/auth/email-code/disable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().enabled).toBe(false);
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.email_code_disabled")).toBe(true);
    nextStep();
    res = await post(cookie, "/api/auth/email-code/disable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_enabled");
  });
});

describe("as regras do código", () => {
  it("uso único: depois de usado, pedir de novo", async () => {
    const { cookie, secret, recoveryCodes } = await prepare({ emailFactor: true });
    const code = await requestCode(cookie);
    nextStep();
    const ok = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
    const novos = ok.json().recoveryCodes as string[];
    expect(novos).toHaveLength(10);
    expect(novos.some((c) => recoveryCodes.includes(c))).toBe(false);
    nextStep();
    const reuse = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe("email_code_required");
  });

  it("vence em 10 minutos", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    const code = await requestCode(cookie);
    nowMs += EMAIL_CODE_TTL_MS + 1000;
    const res = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.json().error).toBe("email_code_expired");
    // vencido some: o próximo pedido cai em "pedir o código"
    const next = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(next.json().error).toBe("email_code_required");
  });

  it("cada erro conta (restam menos tentativas) e fica auditado", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    const real = await requestCode(cookie);
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 1; i < EMAIL_CODE_MAX_ATTEMPTS; i += 1) {
      nextStep();
      const res = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: wrong });
      expect(res.json()).toMatchObject({ error: "invalid_email_code", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - i });
    }
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.filter((e) => e.action === "auth.email_code_failed")).toHaveLength(EMAIL_CODE_MAX_ATTEMPTS - 1);
  });

  it("o código é preso à sessão que o pediu", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    const code = await requestCode(cookie);
    const other = await loginWith2fa(secret);
    nextStep();
    const res = await post(other, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.json().error).toBe("email_code_required");
  });

  it("aceita o código com espaço no meio e recusa formato que não é de 6 dígitos", async () => {
    const { cookie, secret } = await prepare({ emailFactor: true });
    const code = await requestCode(cookie);
    nextStep();
    const bad = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: "abcdef" });
    expect(bad.json().error).toBe("invalid_email_code");
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const ok = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: spaced });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe("ações que passam a pedir o código por e-mail", () => {
  it("trocar a senha do painel", async () => {
    const { cookie } = await prepare({ emailFactor: true });
    const semCodigo = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NovaSenha456" });
    expect(semCodigo.statusCode).toBe(400);
    expect(semCodigo.json().error).toBe("email_code_required");
    const code = await requestCode(cookie);
    const ok = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NovaSenha456", emailCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("desligar a verificação em duas etapas — e o código por e-mail desliga junto", async () => {
    const { cookie, secret, userId } = await prepare({ emailFactor: true });
    nextStep();
    const semCodigo = await post(cookie, "/api/auth/2fa/disable", { currentPassword: PASSWORD, code: codeNow(secret) });
    expect(semCodigo.json().error).toBe("email_code_required");
    const code = await requestCode(cookie);
    const ok = await post(cookie, "/api/auth/2fa/disable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
    const user = (await ctx.userStore.findById(userId))!;
    expect(user.twoFactor ?? null).toBeNull();
    expect(user.emailCodeEnabledAt ?? null).toBeNull();
  });

  it("gerar códigos de recuperação novos sem o fator ligado só pede senha + código do app", async () => {
    const { cookie, secret, recoveryCodes } = await prepare();
    nextStep();
    const res = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: codeNow(secret) });
    expect(res.statusCode, res.body).toBe(200);
    const novos = res.json().recoveryCodes as string[];
    // os antigos morreram; os novos funcionam no login
    const old = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: PASSWORD, code: recoveryCodes[0]! },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: PASSWORD, code: novos[0]! },
    });
    expect(fresh.statusCode).toBe(200);
    await ctx.auditService.flush();
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.2fa_recovery_codes_regenerated")).toBe(true);
  });

  it("códigos novos sem 2FA ligado: 409 two_factor_required; com senha errada: 401", async () => {
    const cookie = await login();
    let res = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: PASSWORD, code: "123456" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    res = await post(cookie, "/api/auth/2fa/recovery-codes", { currentPassword: "errada", code: "123456" });
    expect(res.statusCode).toBe(401);
  });
});

describe("EmailCodeService (unidade)", () => {
  it("5 erros seguidos cancelam o código (mesmo o certo deixa de valer) e ficam auditados", async () => {
    const recorded: string[] = [];
    let issued = "";
    const svc = new EmailCodeService(
      { record: async (e) => void recorded.push(e.action) },
      { now: () => nowMs, generate: () => (issued = "424242") },
    );
    svc.setMailer(mailer);
    const user = { id: "u", username: "u", usernameLower: "u", passwordHash: "h", email: ADDRESS, createdAt: "", updatedAt: "" };
    await svc.send(user, "s");
    expect(issued).toBe("424242");
    for (let i = 1; i < EMAIL_CODE_MAX_ATTEMPTS; i += 1) {
      expect(svc.check(user, "s", "000000")).toEqual({ status: "invalid", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - i });
    }
    expect(svc.check(user, "s", "000000")).toEqual({ status: "exhausted" });
    expect(svc.check(user, "s", "424242")).toEqual({ status: "none" });
    expect(recorded).toContain("auth.email_code_exhausted");
    expect(EmailCodeService.failureMessage({ status: "exhausted" })!.error).toBe("email_code_exhausted");
  });

  it("máscara de endereço", () => {
    expect(maskEmail("dono@example.com")).toBe("d***@example.com");
    expect(maskEmail("semarroba")).toBe("***");
    expect(maskEmail("@x.com")).toBe("***");
  });

  it("sem auditoria injetada nem mailer, o serviço continua funcionando e check sem pendência é 'none'", async () => {
    const svc = new EmailCodeService(null);
    const user = { id: "u", username: "u", usernameLower: "u", passwordHash: "h", createdAt: "", updatedAt: "" };
    expect(svc.isEnabled(user)).toBe(false);
    expect(svc.check(user, "s", "123456")).toEqual({ status: "none" });
    await expect(svc.send({ ...user, email: ADDRESS }, "s")).rejects.toMatchObject({ code: "email_unavailable" });
    expect((await svc.status(user)).mailReady).toBe(false);
    expect(EmailCodeService.failureMessage({ status: "ok" })).toBeNull();
    svc.forget("u");
  });
});

describe("código preso à ação e envios atômicos", () => {
  const sendFor = (cookie: string, action: string) => post(cookie, "/api/auth/email-code/send", { action });
  const digits = () => /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1]!;

  it("o e-mail diz para qual ação foi pedido e o código não vale para outra ação", async () => {
    const { cookie } = await prepare({ emailFactor: true });
    expect((await sendFor(cookie, "access.kit")).statusCode).toBe(200);
    expect(sent.at(-1)!.text).toContain("gerar o kit de recuperação");
    const code = digits();
    const wrong = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NovaSenha456", emailCode: code });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("email_code_wrong_action");
    // não gastou tentativa nem o código: na ação certa ele ainda vale
    nowMs += EMAIL_CODE_RESEND_GAP;
    expect((await sendFor(cookie, "auth.password")).statusCode).toBe(200);
    const ok = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NovaSenha456", emailCode: digits() });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("ação desconhecida no pedido é recusada", async () => {
    const cookie = await login();
    expect((await sendFor(cookie, "qualquer.coisa")).statusCode).toBe(400);
  });

  it("pedidos paralelos não furam o intervalo: só um envia", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: ADDRESS });
    const cookie = await login();
    const [a, b] = await Promise.all([post(cookie, "/api/auth/email-code/send"), post(cookie, "/api/auth/email-code/send")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 429]);
    expect(sent).toHaveLength(1);
  });

  it("trocar a senha esquece os códigos pendentes de todas as sessões", async () => {
    const { cookie, userId } = await prepare({ emailFactor: true });
    const code = await requestCode(cookie);
    const ok = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NovaSenha456", emailCode: code });
    expect(ok.statusCode, ok.body).toBe(200);
    const user = (await ctx.userStore.findById(userId))!;
    expect(ctx.emailCode.check(user, "qualquer", code).status).toBe("none");
    // o mesmo código não vale uma segunda vez
    const again = await post(cookie, "/api/auth/change-password", { currentPassword: "NovaSenha456", newPassword: "OutraSenha789", emailCode: code });
    expect(again.json().error).toBe("email_code_required");
  });
});

describe("cobertura das bordas do código por e-mail", () => {
  it("auditoria que falha não derruba o envio; mailer não pronto devolve o intervalo reservado", async () => {
    const svc = new EmailCodeService(
      { record: async () => Promise.reject(new Error("auditoria fora")) },
      { now: () => nowMs, generate: () => "111111" },
    );
    svc.setMailer(mailer);
    const user = { id: "u", username: "u", usernameLower: "u", passwordHash: "h", email: ADDRESS, createdAt: "", updatedAt: "" };
    mailState.ready = false;
    await expect(svc.send(user, "s")).rejects.toMatchObject({ code: "email_unavailable" });
    mailState.ready = true;
    await expect(svc.send(user, "s", "access.kit")).resolves.toMatchObject({ sentTo: "d***@example.com" });
    expect(EmailCodeService.failureMessage({ status: "wrong_action", asked: null })!.error).toBe("email_code_wrong_action");
    expect(EmailCodeService.failureMessage({ status: "wrong_action", asked: "access.kit" })!.message).toMatch(/kit de recuperação/);
    mailState.failSend = true;
    nowMs += EMAIL_CODE_RESEND_GAP;
    await expect(svc.send(user, "s")).rejects.toMatchObject({ code: "email_send_failed" });
    svc.forget("u");
    expect(svc.check(user, "s", "111111").status).toBe("none");
  });

  it("erro inesperado vira 500 genérico nas rotas; sessão sem usuário vira 401", async () => {
    const cookie = await login();
    const original = ctx.emailCode.send.bind(ctx.emailCode);
    ctx.emailCode.send = async () => {
      throw new Error("falha interna");
    };
    const res = await post(cookie, "/api/auth/email-code/send");
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
    ctx.emailCode.send = original;
    await ctx.userStore.removeAll();
    expect((await post(cookie, "/api/auth/email-code/send")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/email-code", headers: { cookie } })).statusCode).toBe(401);
  });

  it("falha ao gravar o estado do fator vira erro tratado", async () => {
    const { cookie, secret } = await prepare();
    const original = ctx.userStore.setEmailCode.bind(ctx.userStore);
    ctx.userStore.setEmailCode = async () => {
      throw new Error("disco cheio");
    };
    const code = await requestCode(cookie);
    nextStep();
    const res = await post(cookie, "/api/auth/email-code/enable", { currentPassword: PASSWORD, code: codeNow(secret), emailCode: code });
    expect(res.statusCode).toBe(500);
    ctx.userStore.setEmailCode = original;
  });
});
