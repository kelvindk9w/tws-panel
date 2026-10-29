/**
 * terminal-protegido.test.ts — depois do setup o terminal web só abre HABILITADO (senha + 2FA, + código
 * por e-mail quando ligado), por sessão, por uma janela curta. Contra uma app real: rotas de habilitação,
 * WebSocket (inclusive reconexão), expiração, logout/troca de senha, token de API, alerta e auditoria.
 */
import { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER, WS_CLOSE_TERMINAL_DISABLED, type TerminalAccessStatus } from "@paas/core";
import apiTokenRoutes from "../src/routes/api-tokens.js";
import authRoutes from "../src/routes/auth.js";
import emailCodeRoutes from "../src/routes/email-code.js";
import setupRoutes from "../src/routes/setup.js";
import terminalRoutes, { WS_CLOSE_SESSION_ENDED } from "../src/routes/terminal.js";
import terminalAccessRoutes from "../src/routes/terminal-access.js";
import { TerminalService } from "../src/services/terminal-service.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";

class FakePty implements RemotePty {
  readonly inputs: Buffer[] = [];
  killed = false;
  readonly stream: Duplex = new Duplex({
    write: (chunk, _enc, cb) => {
      this.inputs.push(Buffer.from(chunk));
      cb();
    },
    read: () => undefined,
  });
  resize(): void {}
  async kill(): Promise<void> {
    this.killed = true;
    this.stream.push(null);
  }
}

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let ptys: FakePty[];
let sent: string[];
let baseUrl: string;

async function build(gate?: { windowMs?: number; idleMs?: number }): Promise<void> {
  nowMs = Date.UTC(2026, 9, 29, 12, 0, 0);
  sent = [];
  ptys = [];
  ctx = await buildAuthTestApp(SETUP, {
    now: () => nowMs,
    // como no app real: senha/2FA trocados ou sessão revogada matam o shell e limpam o histórico
    gate: { ...gate, wipeShell: () => void app.terminalService.wipe() },
  });
  app = ctx.app;
  app.decorate(
    "terminalService",
    new TerminalService({
      watchSudoPrompt: false,
      openPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return Promise.resolve(pty);
      },
    }),
  );
  ctx.emailCode.setMailer({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
    send: async (msg) => void sent.push(msg.text),
    isHostedAddress: async () => false,
  });
  // simula a sessão sintética de um token chegando às rotas (defesa em profundidade): vem DEPOIS do hook de auth
  app.addHook("preHandler", async (request) => {
    if (request.headers["x-teste-token"]) {
      request.session = {
        id: "tok",
        userId: "u",
        username: "token:x",
        createdAt: "",
        expiresAt: new Date(Date.now() + 1e6).toISOString(),
        ip: null,
        userAgent: null,
        token: { id: "t", scope: "admin", reach: { kind: "all" }, mcp: {} },
      } as never;
    }
  });
  await app.register(authRoutes);
  await app.register(emailCodeRoutes);
  await app.register(setupRoutes);
  await app.register(apiTokenRoutes);
  await app.register(terminalRoutes);
  await app.register(terminalAccessRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("sem porta de teste");
  baseUrl = `ws://127.0.0.1:${address.port}`;
}

async function createAdmin(): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: SETUP },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);

async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return sessionCookieOf(res);
}

/** Outra sessão de login do mesmo usuário (com 2FA ligado o login normal pediria um código). */
async function otherSession(): Promise<string> {
  const user = (await ctx.userStore.findByUsername("admin"))!;
  const { cookieValue } = await ctx.sessionStore.create({ id: user.id, username: user.username });
  return `paas_session=${cookieValue}`;
}

async function enable2fa(cookie: string): Promise<string> {
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const res = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: codeNow(secret) } });
  expect(res.statusCode, res.body).toBe(200);
  return secret;
}

/** Sessão com 2FA; `creds()` gera as credenciais de uma ação (um passo novo de TOTP a cada uso). */
async function ready() {
  const cookie = await login();
  const secret = await enable2fa(cookie);
  const creds = (extra: Record<string, unknown> = {}) => {
    nextStep();
    return { currentPassword: PASSWORD, code: codeNow(secret), ...extra };
  };
  return { cookie, secret, creds };
}

const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload });
const access = async (cookie: string) => (await app.inject({ method: "GET", url: "/api/terminal/access", headers: { cookie } })).json() as TerminalAccessStatus;

function openWs(cookie: string, clientId = "aba-1"): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseUrl}/api/terminal/ws?clientId=${clientId}`, { headers: { cookie } } as unknown as string[]);
    // handshake recusado (401/403): o navegador só dispara "error" (e depois um close 1006)
    const closed = new Promise<{ code: number; reason: string }>((r) => {
      ws.addEventListener("close", (ev) => r({ code: ev.code, reason: ev.reason }), { once: true });
      ws.addEventListener("error", () => r({ code: 1006, reason: "handshake recusado" }), { once: true });
    });
    ws.addEventListener("open", () => resolve({ ws, closed }), { once: true });
    ws.addEventListener("error", () => resolve({ ws, closed }), { once: true });
  });
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const typed = () => ptys.map((p) => Buffer.concat(p.inputs).toString("utf8")).join("");

async function auditText(needle: string): Promise<string> {
  await ctx.auditService.flush();
  const deadline = Date.now() + 5000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readFile(path.join(ctx.dir, "audit.json"), "utf8");
      if (last.includes(needle)) return last;
    } catch {
      // ainda não existe
    }
    await tick(10);
  }
  return last;
}

describe("durante o assistente de instalação o terminal segue como sempre", () => {
  beforeEach(() => build());

  it("o estado diz que a habilitação não é exigida e o WS abre com o setup token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/terminal/access", headers: { [SETUP_TOKEN_HEADER]: SETUP } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ required: false, enabled: true });
    const ws = new WebSocket(`${baseUrl}/api/terminal/ws?token=${SETUP}&clientId=aba-1`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("falha")), { once: true });
    });
    await tick();
    ws.send("durante-o-wizard\n");
    await tick();
    expect(typed()).toContain("durante-o-wizard");
    ws.close();
  });

  it("habilitar antes do fim do setup responde 409 (nada a habilitar)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminal/access/enable", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { currentPassword: "x" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("terminal_gate_not_required");
  });
});

describe("depois do setup: desligado por padrão", () => {
  beforeEach(async () => {
    await build();
    await createAdmin();
  });

  it("o estado mostra exigido e desligado, com os prazos", async () => {
    const { cookie } = await ready();
    expect(await access(cookie)).toMatchObject({ required: true, enabled: false, expiresAt: null, windowMs: 30 * 60_000, idleMs: 15 * 60_000, twoFactorEnabled: true, emailCodeEnabled: false });
  });

  it("o WebSocket é recusado sem habilitação (4403), nenhum shell abre e a reconexão também é recusada", async () => {
    const { cookie } = await ready();
    for (let i = 0; i < 2; i++) {
      const { ws, closed } = await openWs(cookie);
      try {
        ws.send("tentativa\n");
      } catch {
        // já fechado
      }
      const end = await closed;
      expect(end.code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    }
    expect(ptys).toHaveLength(0);
    expect(typed()).toBe("");
  });

  it("sem sessão nenhuma o handshake do WS segue recusado (401) e nenhum shell abre", async () => {
    const res = await fetch(`${baseUrl.replace("ws://", "http://")}/api/terminal/ws`);
    expect(res.status).toBe(401);
    expect(ptys).toHaveLength(0);
  });

  it("recusa de habilitação sem cada fator", async () => {
    const { cookie, creds } = await ready();
    const url = "/api/terminal/access/enable";
    expect((await post(cookie, url, {})).statusCode).toBe(400); // sem senha: o corpo nem é válido
    expect((await post(cookie, url, { ...creds(), currentPassword: "errada" })).statusCode).toBe(401);
    const noCode = await post(cookie, url, { currentPassword: PASSWORD });
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().error).toBe("invalid_two_factor_code");
    const wrongCode = await post(cookie, url, { currentPassword: PASSWORD, code: "000000" });
    expect(wrongCode.statusCode).toBe(400);
    expect((await access(cookie)).enabled).toBe(false);
    const { ws, closed } = await openWs(cookie);
    void ws;
    expect((await closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
  });

  it("sem 2FA ligado não dá para habilitar (409 two_factor_required)", async () => {
    const cookie = await login();
    const res = await post(cookie, "/api/terminal/access/enable", { currentPassword: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    expect((await access(cookie)).twoFactorEnabled).toBe(false);
  });

  it("senha + código do app habilitam: o WS conecta, o input chega ao shell, e a auditoria não leva o que foi digitado", async () => {
    const { cookie, creds } = await ready();
    const res = await post(cookie, "/api/terminal/access/enable", creds());
    expect(res.statusCode, res.body).toBe(200);
    const status = res.json() as TerminalAccessStatus & { alertWarning?: string };
    expect(status).toMatchObject({ required: true, enabled: true, windowMs: 30 * 60_000 });
    expect(status.remainingMs).toBeGreaterThan(29 * 60_000);
    expect(status.alertWarning).toMatch(/Alerta por e-mail não enviado/);

    const { ws } = await openWs(cookie);
    await tick();
    ws.send("ls senha-secreta\n");
    await tick();
    expect(typed()).toContain("ls senha-secreta");
    ws.close();
    const audit = await auditText("terminal.enabled");
    expect(audit).toContain("terminal.enabled");
    expect(audit).toContain("auth.access_alert_skipped");
    expect(audit).not.toContain("senha-secreta");
  });

  it("uma OUTRA sessão do mesmo usuário não herda a habilitação", async () => {
    const { cookie, creds } = await ready();
    expect((await post(cookie, "/api/terminal/access/enable", creds())).statusCode).toBe(200);
    const outra = await otherSession();
    expect(await access(outra)).toMatchObject({ required: true, enabled: false });
    const { ws, closed } = await openWs(outra, "aba-2");
    void ws;
    expect((await closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect((await access(cookie)).enabled).toBe(true);
  });

  it("'Desligar agora' fecha a conexão aberta com a mensagem e o input seguinte não chega ao shell", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws, closed } = await openWs(cookie);
    await tick();
    const messages: string[] = [];
    ws.addEventListener("message", (ev) => messages.push(String(ev.data)));
    ws.send("antes\n");
    await tick();
    const off = await post(cookie, "/api/terminal/access/disable");
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, lastEnd: "manual" });
    expect((await closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    try {
      ws.send("depois\n");
    } catch {
      // fechado
    }
    await tick();
    expect(typed()).toContain("antes");
    expect(typed()).not.toContain("depois");
    expect(messages.join("")).toContain("O terminal foi desligado");
    const audit = await auditText("terminal.disabled");
    expect(audit).toContain("terminal.disabled");
    // reconectar agora é recusado
    const again = await openWs(cookie);
    expect((await again.closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
  });

  it("logout desliga: a conexão cai por sessão encerrada (4401) e uma sessão nova começa desligada", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    expect((await post(cookie, "/api/auth/logout")).statusCode).toBeLessThan(300);
    expect((await closed).code).toBe(WS_CLOSE_SESSION_ENDED);
    const fresh = await otherSession();
    expect((await access(fresh)).enabled).toBe(false);
  });

  it("trocar a senha do painel desliga o terminal desta sessão na hora", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    const res = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "OutraSenha456!xx" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect(await access(cookie)).toMatchObject({ enabled: false, lastEnd: "credentials" });
  });

  it("desligar o 2FA desliga o terminal na hora", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    const res = await post(cookie, "/api/auth/2fa/disable", creds());
    expect(res.statusCode, res.body).toBe(200);
    expect((await closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect(await access(cookie)).toMatchObject({ enabled: false, lastEnd: "credentials", twoFactorEnabled: false });
  });

  it("revogar a sessão (encerrar sessões) desliga e a conexão cai com 4401", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    await ctx.sessionStore.destroyAll();
    expect((await closed).code).toBe(WS_CLOSE_SESSION_ENDED);
    expect(ctx.terminalGate.disableAll("manual")).toBe(0);
  });
});

describe("expiração encerra a conexão aberta", () => {
  it("pela janela: mesmo digitando sempre, ao fim dela o terminal desliga com mensagem e auditoria", async () => {
    await build({ windowMs: 400, idleMs: 400 });
    await createAdmin();
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws, closed } = await openWs(cookie);
    const messages: string[] = [];
    ws.addEventListener("message", (ev) => messages.push(String(ev.data)));
    const typer = setInterval(() => {
      try {
        ws.send("x");
      } catch {
        // fechado
      }
    }, 100);
    const end = await closed;
    clearInterval(typer);
    expect(end.code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect(messages.join("")).toContain("O tempo de");
    expect(await access(cookie)).toMatchObject({ enabled: false, lastEnd: "window" });
    const audit = await auditText("terminal.expired");
    expect(audit).toContain("terminal.expired");
    const reconnect = await openWs(cookie);
    expect((await reconnect.closed).code).toBe(WS_CLOSE_TERMINAL_DISABLED);
  });

  it("pela ociosidade: sem entrada o terminal desliga antes do fim da janela; entrada adia", async () => {
    await build({ windowMs: 5000, idleMs: 400 });
    await createAdmin();
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws, closed } = await openWs(cookie);
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      await tick(200);
      ws.send("ainda aqui\n");
    }
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const end = await closed;
    expect(end.code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect(Date.now() - start).toBeGreaterThan(900); // as entradas adiaram o desligamento
    expect(Date.now() - start).toBeLessThan(4000);
    expect(await access(cookie)).toMatchObject({ enabled: false, lastEnd: "idle" });
  });

  it("respostas automáticas do xterm (posição do cursor, atributos) não seguram o terminal ligado", async () => {
    await build({ windowMs: 5000, idleMs: 400 });
    await createAdmin();
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws, closed } = await openWs(cookie);
    const start = Date.now();
    const replier = setInterval(() => {
      try {
        ws.send("\u001b[24;80R");
        ws.send("\u001b[?1;2c");
      } catch {
        // fechado
      }
    }, 100);
    const end = await closed;
    clearInterval(replier);
    expect(end.code).toBe(WS_CLOSE_TERMINAL_DISABLED);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(await access(cookie)).toMatchObject({ lastEnd: "idle" });
  });

  it("redimensionar a janela não conta como entrada", async () => {
    await build({ windowMs: 5000, idleMs: 400 });
    await createAdmin();
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws, closed } = await openWs(cookie);
    const start = Date.now();
    const resizer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      } catch {
        // fechado
      }
    }, 100);
    await closed;
    clearInterval(resizer);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe("shell vivo depois de desligar", () => {
  beforeEach(async () => {
    await build();
    await createAdmin();
  });

  const output = (text: string) => ptys.at(-1)!.stream.push(text);

  it("trocar a senha mata o shell e limpa o histórico (quem habilitar depois começa limpo)", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    output("saida-que-ficou-na-tela\n");
    await tick();
    const res = await post(cookie, "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "OutraSenha456!xx" });
    expect(res.statusCode, res.body).toBe(200);
    await closed;
    await tick(60);
    expect(ptys[0]!.killed).toBe(true);
    expect((await app.terminalService.connect()).replay).toBe("");
    expect(ptys).toHaveLength(2); // sessão nova
  });

  it("logout (sessão revogada) também mata o shell e limpa o histórico", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    await openWs(cookie);
    await tick();
    output("historico\n");
    await tick();
    await post(cookie, "/api/auth/logout");
    await tick(60);
    expect(ptys[0]!.killed).toBe(true);
    expect((await app.terminalService.connect()).replay).toBe("");
  });

  it("'Desligar agora' mantém o shell e o histórico (uma fase pode estar rodando nele)", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { closed } = await openWs(cookie);
    await tick();
    output("fase-em-andamento\n");
    await tick();
    await post(cookie, "/api/terminal/access/disable");
    await closed;
    await tick(60);
    expect(ptys[0]!.killed).toBe(false);
    expect((await app.terminalService.connect()).replay).toContain("fase-em-andamento");
  });

  it("revogar outra sessão (sem habilitação) não mata o shell desta", async () => {
    const { cookie, creds } = await ready();
    await post(cookie, "/api/terminal/access/enable", creds());
    const { ws } = await openWs(cookie);
    await tick();
    const outra = await ctx.sessionStore.create({ id: "u1", username: "admin" });
    await ctx.sessionStore.destroy(outra.session.id);
    await tick(60);
    expect(ptys[0]!.killed).toBe(false);
    ws.close();
    await tick(100);
  });
});

describe("código por e-mail e alerta", () => {
  beforeEach(async () => {
    await build();
    await createAdmin();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    await ctx.userStore.updateProfile(user.id, { email: "dono@example.com" });
  });

  const requestCode = async (cookie: string, action: string) => {
    nowMs += 31_000;
    const r = await app.inject({ method: "POST", url: "/api/auth/email-code/send", headers: { cookie }, payload: { action } });
    expect(r.statusCode, r.body).toBe(200);
    return /\b(\d{6})\b/.exec(sent.at(-1)!)![1]!;
  };

  it("com o fator ligado, habilitar pede o código preso à ação 'terminal.enable' e avisa o dono", async () => {
    const { cookie, creds } = await ready();
    const on = await post(cookie, "/api/auth/email-code/enable", { ...creds(), emailCode: await requestCode(cookie, "email.toggle") });
    expect(on.statusCode, on.body).toBe(200);
    expect((await access(cookie)).emailCodeEnabled).toBe(true);

    const refused = await post(cookie, "/api/terminal/access/enable", creds());
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("email_code_required");
    expect((await access(cookie)).enabled).toBe(false);

    // código pedido para OUTRA ação não vale
    const other = await requestCode(cookie, "access.keys");
    const wrong = await post(cookie, "/api/terminal/access/enable", creds({ emailCode: other }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("email_code_wrong_action");

    const code = await requestCode(cookie, "terminal.enable");
    expect(sent.at(-1)).toContain("habilitar o terminal web");
    const ok = await post(cookie, "/api/terminal/access/enable", creds({ emailCode: code }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().alertWarning).toBeUndefined();
    await ctx.emailCode.idle();
    expect(sent.at(-1)).toMatch(/terminal web habilitado por até 30 min/);
    expect(sent.at(-1)).toContain("De qual IP");
    const audit = await auditText("auth.access_alert_sent");
    expect(audit).toContain("auth.access_alert_sent");
    // o mesmo código não vale duas vezes
    const reuse = await post(cookie, "/api/terminal/access/enable", creds({ emailCode: code }));
    expect(reuse.json().error).toBe("email_code_required");
  });

  it("alerta que não sai (envio não pronto): a habilitação vale e a resposta traz o aviso", async () => {
    const { cookie, creds } = await ready();
    ctx.emailCode.setMailer({ readiness: async () => ({ ready: false, reason: "sem SMTP", from: null }), send: async () => undefined, isHostedAddress: async () => false });
    const res = await post(cookie, "/api/terminal/access/enable", creds());
    expect(res.statusCode).toBe(200);
    expect(res.json().alertWarning).toContain("não está pronto");
    expect((await access(cookie)).enabled).toBe(true);
    expect(await auditText("auth.access_alert_skipped")).toContain("auth.access_alert_skipped");
  });

  it("falha no envio em segundo plano grava auth.access_alert_failed e não desfaz a habilitação", async () => {
    const { cookie, creds } = await ready();
    ctx.emailCode.setMailer({
      readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
      send: async () => {
        throw new Error("smtp caiu");
      },
      isHostedAddress: async () => false,
    });
    const res = await post(cookie, "/api/terminal/access/enable", creds());
    expect(res.statusCode).toBe(200);
    await ctx.emailCode.idle();
    expect(await auditText("auth.access_alert_failed")).toContain("auth.access_alert_failed");
    expect((await access(cookie)).enabled).toBe(true);
  });
});

describe("token de API", () => {
  beforeEach(async () => {
    await build();
    await createAdmin();
  });

  it("nenhum token (leitura ou admin) alcança o estado, a habilitação, o desligamento nem o WS", async () => {
    const { cookie, creds } = await ready();
    const tokens: string[] = [];
    for (const scope of ["read", "admin"]) {
      const made = await post(cookie, "/api/settings/api-tokens", { ...creds(), name: `t-${scope}`, scope });
      expect(made.statusCode, made.body).toBe(201);
      tokens.push(made.json().token as string);
    }
    for (const token of tokens) {
      const headers = { authorization: `Bearer ${token}` };
      for (const [method, url] of [
        ["GET", "/api/terminal/access"],
        ["POST", "/api/terminal/access/enable"],
        ["POST", "/api/terminal/access/disable"],
      ] as const) {
        const res = await app.inject({ method, url, headers, payload: method === "POST" ? { currentPassword: PASSWORD } : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().error).toBe("token_forbidden");
      }
      const ws = await fetch(`${baseUrl.replace("ws://", "http://")}/api/terminal/ws?clientId=t`, { headers });
      expect(ws.status).toBe(403);
    }
    expect(ptys).toHaveLength(0);
  });

  it("mesmo que uma sessão sintética de token chegue às rotas, elas recusam (defesa em profundidade)", async () => {
    const cookie = await otherSession(); // passa pelo hook de auth; o hook de teste troca a sessão antes da rota
    for (const [method, url] of [
      ["GET", "/api/terminal/access"],
      ["POST", "/api/terminal/access/enable"],
      ["POST", "/api/terminal/access/disable"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie, "x-teste-token": "1" }, payload: method === "POST" ? { currentPassword: PASSWORD } : undefined });
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(403);
      expect(res.json().error).toBe("token_forbidden");
    }
  });
});
