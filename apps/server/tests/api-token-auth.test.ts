/**
 * api-token-auth.test.ts — token de API (Authorization: Bearer) no plugin de
 * autenticação e nas rotas de Configurações → Acesso por IA, contra uma app
 * Fastify real (inject). Cada regra tem um teste que reprova se ela sumir:
 * escopo por método, lista de exclusão, cookie ignorado com Bearer, nenhum
 * cookie para token, respostas idênticas (sem oráculo), limite por IP, validade
 * com relógio congelado, revogação, só humano administra tokens, 2FA/senha na
 * criação, auditoria `token:<nome>` e nenhum token em log/auditoria/erro.
 */
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_MAX_ACTIVE, API_TOKEN_PREFIX, SETUP_TOKEN_HEADER } from "@paas/core";
import { loggerOptions } from "../src/log-config.js";
import healthRoutes from "../src/routes/health.js";
import apiTokenRoutes from "../src/routes/api-tokens.js";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { parseAuthorization, tokenInUrl } from "../src/plugins/auth.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const INVALID_BODY = { error: "unauthorized", message: "Token de API inválido, expirado ou revogado." };

let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let logLines: string[];
let nowMs: number;
let terminalCalls: string[] = [];

function logStream() {
  logLines = [];
  return new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 22, 12, 0, 0);
  ctx = await buildAuthTestApp(SETUP, {
    now: () => nowMs,
    logger: { ...loggerOptions("info"), stream: logStream() },
  });
  app = ctx.app;
  // rotas de mentira com os padrões reais, uma de cada classe
  app.get("/api/projects", async (request) => ({
    session: { ...request.session, ip: undefined },
    hasCookieHeader: request.headers.cookie !== undefined,
  }));
  app.post("/api/projects/:id/stop", async () => ({ created: true }));
  app.delete("/api/projects/:id", async () => ({ deleted: true }));
  app.get("/api/projects/:id/env", async () => ({ secrets: "valores" }));
  app.get("/api/terminal/info", async () => ({ terminal: true }));
  app.put("/api/settings/restart-setup", async () => ({ restarted: true }));
  app.get("/api/mail/mailboxes/:id/credentials", async () => ({ password: "x" }));
  // rotas de mentira que, por campo/parâmetro/consulta, precisam de mais que o escopo-base
  const ran = async () => ({ ran: true });
  app.patch("/api/projects/:id", ran);
  app.post("/api/backups/targets/:target/restore", ran);
  app.post("/api/projects/check-git-access", ran);
  app.get("/api/security/scan", ran);
  app.put("/api/projects/:id/email/links", ran);
  app.put("/api/mail/envios/reputation/dqs", ran);
  app.put("/api/notifications/email", ran);
  app.get("/api/rota-nova-sem-decisao", ran);
  app.post("/api/rota-nova-sem-decisao", ran);
  terminalCalls = [];
  const fakeTerminal = {
    runCommand: async (cmd: string) => (terminalCalls.push(cmd), { code: 0, output: "" }),
    runCommandCaptured: async (cmd: string) => (terminalCalls.push(cmd), { code: 0, output: "" }),
  };
  app.decorate("terminalService", fakeTerminal as never);
  app.decorate("config", { securityTarget: "host" } as never);
  await app.register(healthRoutes);
  app.post("/api/alerts/:id/ack", async (request) => {
    await app.auditService.record({ action: "teste.sem_ator", detail: "ação sem ator explícito" });
    return { actor: request.session?.username };
  });
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(apiTokenRoutes);
  const admin = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: SETUP },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(admin.statusCode).toBe(201);
  cookie = await humanLogin();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeAuthTestApp(ctx);
});

async function humanLogin(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return sessionCookieOf(res);
}

async function createToken(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = { cookie },
): Promise<{ status: number; token: string; id: string; json: Record<string, any> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/api-tokens",
    headers,
    payload: { name: "assistente", scope: "read", currentPassword: PASSWORD, ...body },
  });
  const json = res.json() as Record<string, any>;
  return { status: res.statusCode, token: json.token, id: json.info?.id, json };
}

async function newToken(scope: "read" | "write" | "admin", name = `t-${scope}`, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await createToken({ name, scope, ...extra });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.token;
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Record<string, string> = {}, remoteAddress?: string) {
  return app.inject({ method, url, headers, ...(remoteAddress ? { remoteAddress } : {}) });
}

// ---------------------------------------------------------------------------

describe("sessão sintética", () => {
  it("o token vira uma sessão compatível: dono da conta, ator token:<nome>, validade do token, marca de token", async () => {
    const token = await newToken("read", "meu assistente");
    const res = await call("GET", "/api/projects", bearer(token));
    expect(res.statusCode).toBe(200);
    const user = await ctx.userStore.findByUsername("admin");
    const { session } = res.json();
    expect(session).toMatchObject({ userId: user!.id, username: "token:meu assistente", token: { scope: "read" } });
    expect(session.id.startsWith("token:")).toBe(true);
    expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBe(30 * 24 * 3_600_000);
    expect(res.headers["set-cookie"]).toBeUndefined();
    // a sessão sintética não é gravada nem entra no SessionStore
    expect(ctx.sessionStore.isActive(session.id)).toBe(false);
  });

  it("GET /api/auth/me com token funciona (leitura) e não devolve cookie", async () => {
    const token = await newToken("read");
    const res = await call("GET", "/api/auth/me", bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("admin");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("sessão humana continua igual: cookie vale, sem marca de token", async () => {
    const res = await call("GET", "/api/projects", { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.token).toBeUndefined();
    expect(res.json().session.username).toBe("admin");
  });
});

describe("escopo por rota", () => {
  it("read: só GET; write: GET e mudanças; admin: tudo da lista admin", async () => {
    const read = await newToken("read");
    const write = await newToken("write");
    const admin = await newToken("admin");
    const matrix: Array<[string, "GET" | "POST" | "DELETE", string, number, number, number]> = [
      // rota                            método   url                  read write admin
      ["leitura", "GET", "/api/projects", 200, 200, 200],
      ["escrita", "POST", "/api/projects/p1/stop", 403, 200, 200],
      ["administração", "DELETE", "/api/projects/p1", 403, 403, 200],
    ];
    for (const [label, method, url, r, w, a] of matrix) {
      expect((await call(method, url, bearer(read))).statusCode, `read ${label}`).toBe(r);
      expect((await call(method, url, bearer(write))).statusCode, `write ${label}`).toBe(w);
      expect((await call(method, url, bearer(admin))).statusCode, `admin ${label}`).toBe(a);
    }
    const denied = await call("POST", "/api/projects/p1/stop", bearer(read));
    expect(denied.json()).toMatchObject({ error: "insufficient_scope" });
    expect(denied.json().message).toContain('"read"');
  });

  it("HEAD de uma rota GET exige só leitura", async () => {
    const read = await newToken("read");
    const res = await app.inject({ method: "HEAD", url: "/api/projects", headers: bearer(read) });
    expect(res.statusCode).toBe(200);
  });
});

describe("escrita que desvia para segredo ou para código de fora (campos, parâmetros, consulta)", () => {
  const send = (method: "PATCH" | "POST" | "PUT" | "GET", url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: bearer(token), ...(payload === undefined ? {} : { payload: payload as object }) });

  it("PATCH do projeto: trocar repositório, branch, domínio ou proxy exige admin; renomear segue escrita", async () => {
    const write = await newToken("write");
    const admin = await newToken("admin");
    for (const body of [{ source: "https://exemplo.test/a.git" }, { branch: "main" }, { domain: "app.exemplo.test" }, { proxyService: "web" }, { proxyPort: 3000 }]) {
      const w = await send("PATCH", "/api/projects/p1", write, body);
      expect(w.statusCode, JSON.stringify(body)).toBe(403);
      expect(w.json().error).toBe("insufficient_scope");
      expect(w.body).not.toContain('"ran"');
      expect((await send("PATCH", "/api/projects/p1", admin, body)).statusCode, JSON.stringify(body)).toBe(200);
    }
    expect((await send("PATCH", "/api/projects/p1", write, { name: "Novo nome", websocket: true })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: { cookie }, payload: { source: "https://exemplo.test/a.git" } })).statusCode).toBe(200);
  });

  it("restaurar o painel: proibido para qualquer token (até admin); outros alvos seguem admin; humano segue livre", async () => {
    const write = await newToken("write");
    const admin = await newToken("admin");
    const panel = await send("POST", "/api/backups/targets/panel/restore", admin, {});
    expect(panel.statusCode).toBe(403);
    expect(panel.json().error).toBe("token_forbidden");
    expect(panel.body).not.toContain('"ran"');
    const byWrite = await send("POST", "/api/backups/targets/panel/restore", write, {});
    expect(byWrite.statusCode).toBe(403);
    expect(byWrite.body).not.toContain('"ran"');
    expect((await send("POST", "/api/backups/targets/email/restore", admin, {})).statusCode).toBe(200);
    expect((await send("POST", "/api/backups/targets/email/restore", write, {})).json().error).toBe("insufficient_scope");
    expect((await app.inject({ method: "POST", url: "/api/backups/targets/panel/restore", headers: { cookie }, payload: {} })).statusCode).toBe(200);
  });

  it("testar acesso ao Git: com token digitado ou da conta é proibido; só a URL segue escrita", async () => {
    const admin = await newToken("admin");
    const write = await newToken("write");
    const url = "https://exemplo.test/a.git";
    expect((await send("POST", "/api/projects/check-git-access", admin, { source: url, token: "ghp_x" })).json().error).toBe("token_forbidden");
    expect((await send("POST", "/api/projects/check-git-access", admin, { source: url, useAccount: true })).json().error).toBe("token_forbidden");
    expect((await send("POST", "/api/projects/check-git-access", write, { source: url })).statusCode).toBe(200);
  });

  it("varredura de segurança nova (fresh=1) exige admin; a em cache segue leitura", async () => {
    const read = await newToken("read");
    const admin = await newToken("admin");
    expect((await send("GET", "/api/security/scan", read)).statusCode).toBe(200);
    expect((await send("GET", "/api/security/scan?fresh=1", read)).statusCode).toBe(403);
    expect((await send("GET", "/api/security/scan?fresh=1", admin)).statusCode).toBe(200);
  });

  it("ligar variável do projeto à senha da caixa de e-mail e gravar a chave DQS: proibidos até para admin", async () => {
    const admin = await newToken("admin");
    const links = await send("PUT", "/api/projects/p1/email/links", admin, { links: {} });
    expect(links.json().error).toBe("token_forbidden");
    const dqs = await send("PUT", "/api/mail/envios/reputation/dqs", admin, { key: null });
    expect(dqs.json().error).toBe("token_forbidden");
    expect((await send("PUT", "/api/notifications/email", await newToken("write", "w2"), { recipients: [] })).json().error).toBe("insufficient_scope");
    expect((await send("PUT", "/api/notifications/email", admin, { recipients: [] })).statusCode).toBe(200);
  });

  it("rota sem classificação na tabela é negada em execução, mesmo para admin (e para humano segue)", async () => {
    const admin = await newToken("admin");
    for (const method of ["GET", "POST"] as const) {
      const res = await send(method, "/api/rota-nova-sem-decisao", admin, method === "POST" ? {} : undefined);
      expect(res.statusCode, method).toBe(403);
      expect(res.json().error).toBe("token_forbidden");
      expect(res.body).not.toContain('"ran"');
    }
    expect((await app.inject({ method: "GET", url: "/api/rota-nova-sem-decisao", headers: { cookie } })).statusCode).toBe(200);
  });

  it("varredura de saúde por token não digita nada no terminal compartilhado; a do humano espelha", async () => {
    const read = await newToken("read");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    try {
      const viaToken = await app.inject({ method: "GET", url: "/api/health/scan", headers: bearer(read) });
      expect(viaToken.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(terminalCalls).toEqual([]);
      const viaHuman = await app.inject({ method: "GET", url: "/api/health/scan", headers: { cookie } });
      expect(viaHuman.statusCode).toBe(200);
      for (let i = 0; i < 100 && terminalCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(terminalCalls.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

describe("lista de exclusão: nenhum token alcança, nem admin", () => {
  const excluded: Array<["GET" | "POST" | "PUT" | "DELETE", string]> = [
    ["GET", "/api/terminal/info"],
    ["PUT", "/api/settings/restart-setup"],
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/2fa/setup"],
    ["POST", "/api/auth/2fa/disable"],
    ["GET", "/api/auth/2fa"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/projects/p1/env"],
    ["GET", "/api/mail/mailboxes/m1/credentials"],
    ["GET", "/api/settings/api-tokens"],
    ["POST", "/api/settings/api-tokens"],
    ["DELETE", "/api/settings/api-tokens/0123456789abcdef"],
  ];

  it.each(excluded)("%s %s → 403 token_forbidden para admin, e a rota nem roda", async (method, url) => {
    const admin = await newToken("admin");
    const res = await call(method, url, bearer(admin));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    expect(res.body).not.toContain('"secrets"'); // o que a rota devolveria
    expect(res.body).not.toContain('"terminal":true');
    expect(res.body).not.toContain('"password"');
  });

  it("a mesma rota com sessão humana funciona (a exclusão é só para token)", async () => {
    expect((await call("GET", "/api/projects/p1/env", { cookie })).statusCode).toBe(200);
    expect((await call("GET", "/api/terminal/info", { cookie })).statusCode).toBe(200);
    expect((await call("GET", "/api/settings/api-tokens", { cookie })).statusCode).toBe(200);
  });

  it("endereço disfarçado (%-codificado, barra dupla) cai na mesma regra, pelo padrão da rota", async () => {
    const admin = await newToken("admin");
    expect((await call("GET", "/api/projects/p1/%65nv", bearer(admin))).statusCode).toBe(403);
    expect((await call("GET", "/%61pi/terminal/info", bearer(admin))).statusCode).toBe(403);
  });

  it("login com Bearer é recusado e nunca emite cookie, mesmo com a senha certa", async () => {
    const read = await newToken("read");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: bearer(read),
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    expect(res.headers["set-cookie"]).toBeUndefined();
    // até com um Bearer inventado
    const fake = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: bearer(`${API_TOKEN_PREFIX}${"A".repeat(43)}`),
      payload: { username: "admin", password: PASSWORD },
    });
    expect(fake.statusCode).toBe(403);
    expect(fake.headers["set-cookie"]).toBeUndefined();
  });

  it("o assistente de instalação (/api/setup/*) não aceita token", async () => {
    const admin = await newToken("admin");
    const res = await call("GET", "/api/setup/status", bearer(admin));
    expect(res.statusCode).toBe(403);
  });
});

describe("cookie, CSRF e Origin continuam valendo", () => {
  it("com Bearer o cookie é ignorado: Bearer inválido + cookie válido → 401", async () => {
    const res = await call("GET", "/api/projects", { cookie, authorization: `Bearer ${API_TOKEN_PREFIX}${"B".repeat(43)}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(INVALID_BODY);
  });

  it("Bearer só de leitura + cookie de humano: vale o token (403), não o cookie", async () => {
    const read = await newToken("read");
    const res = await call("POST", "/api/projects/p1/stop", { cookie, ...bearer(read) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
  });

  it("o token não vale como cookie (paas_session=<token>) nem em outro cabeçalho", async () => {
    const token = await newToken("admin");
    expect((await call("GET", "/api/projects", { cookie: `paas_session=${token}` })).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", { cookie: `__Host-paas_session=${token}` })).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", { "x-setup-token": token })).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", { "x-api-key": token })).statusCode).toBe(401);
  });

  it("escrita de outro site com token certo é barrada antes de tudo (Origin/Sec-Fetch-Site)", async () => {
    const write = await newToken("write");
    const cross = await call("POST", "/api/projects/p1/stop", { ...bearer(write), "sec-fetch-site": "cross-site" });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error).toBe("forbidden_origin");
    const origin = await call("POST", "/api/projects/p1/stop", { ...bearer(write), origin: "https://outro.example", host: "painel.example" });
    expect(origin.statusCode).toBe(403);
    expect(origin.json().error).toBe("forbidden_origin");
    // cliente que não é navegador (sem Origin) passa só com o token
    expect((await call("POST", "/api/projects/p1/stop", bearer(write))).statusCode).toBe(200);
  });

  it("com 2FA ativo na conta, o token continua sem alcançar login/2FA e a sessão humana pede o código", async () => {
    const { secret } = (await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } })).json();
    const code = totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
    const enable = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code } });
    expect(enable.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(login.json().error).toBe("two_factor_required");
  });
});

describe("falhas de autenticação do Bearer: mesma resposta, sem oráculo", () => {
  async function snapshot(res: Awaited<ReturnType<typeof call>>) {
    return { status: res.statusCode, body: res.json(), www: res.headers["www-authenticate"], cache: res.headers["cache-control"] };
  }

  it("inexistente, adulterado, expirado, revogado e malformado são indistinguíveis", async () => {
    const good = await createToken({ name: "bom", scope: "read", expiresInHours: 1 });
    const revoked = await createToken({ name: "revogado", scope: "read" });
    await app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${revoked.id}`, headers: { cookie } });
    const expired = await createToken({ name: "vencido", scope: "read", expiresInHours: 1 });
    const base = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base + 2 * 3_600_000);
    // com o relógio adiantado, a sessão humana também venceria; os tokens bom/vencido já expiraram
    const attempts: Record<string, string> = {
      inexistente: `Bearer ${API_TOKEN_PREFIX}${"C".repeat(43)}`,
      adulterado: `Bearer ${good.token.slice(0, -1)}${good.token.endsWith("A") ? "B" : "A"}`,
      expirado: `Bearer ${expired.token}`,
      revogado: `Bearer ${revoked.token}`,
      "sem valor": "Bearer",
      "com dois espaços": `Bearer  ${good.token}`,
      "com aspas": `Bearer "${good.token}"`,
      "valor com sobra": `Bearer ${good.token} extra`,
      "token curto": "Bearer abc",
      "token enorme": `Bearer ${"A".repeat(500)}`,
    };
    const results = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    // um IP por tentativa: aqui se compara a RESPOSTA, não o limite
    let n = 0;
    for (const [label, authorization] of Object.entries(attempts)) {
      results.set(label, await snapshot(await call("GET", "/api/projects", { authorization }, `10.20.0.${++n}`)));
    }
    for (const [label, got] of results) {
      expect(got.status, label).toBe(401);
      expect(got.body, label).toEqual(INVALID_BODY);
    }
    expect(new Set([...results.values()].map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("cabeçalho de outro esquema (Basic, de um proxy) é ignorado: vale o cookie", async () => {
    const res = await call("GET", "/api/projects", { cookie, authorization: "Basic dXNlcjpwYXNz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.token).toBeUndefined();
    expect((await call("GET", "/api/projects", { authorization: "Basic dXNlcjpwYXNz" })).json().message).toBe("Sessão inválida ou expirada.");
  });

  it("esquema 'bearer' em minúsculas vale; valor com espaço ao redor, não", async () => {
    const token = await newToken("read");
    expect((await call("GET", "/api/projects", { authorization: `bearer ${token}` })).statusCode).toBe(200);
    expect((await call("GET", "/api/projects", { authorization: `BEARER ${token}` })).statusCode).toBe(200);
    expect((await call("GET", "/api/projects", { authorization: `Bearer ${token} ` }, "10.30.0.1")).statusCode).toBe(401);
  });

  it("token na query string é recusado (400) — mesmo o certo — e nada o repete na resposta", async () => {
    const token = await newToken("admin");
    for (const url of [
      `/api/projects?access_token=${token}`,
      `/api/projects?foo=1&api_token=abc`,
      `/api/projects?x=${token}`,
      `/api/projects?x=${encodeURIComponent(token)}`,
      `/api/projects/${token}`,
      `/api/projects?%61ccess_token=1`,
    ]) {
      const res = await call("GET", url, bearer(token), `10.40.0.${Math.floor(Math.random() * 200) + 1}`);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("token_in_url");
      expect(res.body).not.toContain(token);
    }
  });

  it("sem Authorization e sem cookie: a resposta é a de sempre (Sessão inválida)", async () => {
    const res = await call("GET", "/api/projects");
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Sessão inválida ou expirada.");
  });

  it("setup ainda pendente: Bearer nunca vale", async () => {
    const real = await newToken("admin"); // um token que EXISTE e está dentro da validade
    expect((await call("GET", "/api/projects", bearer(real))).statusCode).toBe(200);
    await ctx.setupState.reset();
    const res = await call("GET", "/api/projects", bearer(real), "10.140.0.1");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(INVALID_BODY);
    expect((await call("GET", "/api/projects", bearer(`${API_TOKEN_PREFIX}${"D".repeat(43)}`), "10.140.0.2")).json()).toEqual(INVALID_BODY);
  });
});

describe("limite de tentativas inválidas por IP", () => {
  const bad = { authorization: `Bearer ${API_TOKEN_PREFIX}${"E".repeat(43)}` };

  it("5 erros do mesmo IP bloqueiam (429 com Retry-After); outro IP e a sessão humana não são afetados", async () => {
    const ip = "198.51.100.7";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call("GET", "/api/projects", bad, ip)).statusCode);
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes[4]).toBe(429);
    const blocked = await call("GET", "/api/projects", bad, ip);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // até um token VÁLIDO fica de fora enquanto o IP está bloqueado (sem confirmar acerto a quem erra)
    const token = await newToken("read");
    expect((await call("GET", "/api/projects", bearer(token), ip)).statusCode).toBe(429);
    // outro IP segue
    expect((await call("GET", "/api/projects", bearer(token), "198.51.100.8")).statusCode).toBe(200);
    // sessão humana do mesmo IP segue (limitador separado do login)
    expect((await call("GET", "/api/projects", { cookie }, ip)).statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD }, remoteAddress: ip });
    expect(login.statusCode).toBe(200);
  });

  it("acerto no meio não zera as falhas (não dá para esconder tentativas atrás de um token válido)", async () => {
    const ip = "198.51.100.9";
    const token = await newToken("read");
    for (let i = 0; i < 3; i++) await call("GET", "/api/projects", bad, ip);
    expect((await call("GET", "/api/projects", bearer(token), ip)).statusCode).toBe(200);
    expect((await call("GET", "/api/projects", bad, ip)).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", bad, ip)).statusCode).toBe(429);
  });

  it("malformado e token-na-URL também contam", async () => {
    const ip = "198.51.100.10";
    for (let i = 0; i < 2; i++) await call("GET", "/api/projects", { authorization: "Bearer" }, ip);
    for (let i = 0; i < 2; i++) await call("GET", `/api/projects?access_token=x`, {}, ip);
    const fifth = await call("GET", "/api/projects", bad, ip);
    expect(fifth.statusCode).toBe(429);
  });

  it("depois do bloqueio vencer (relógio), o IP volta a tentar", async () => {
    const ip = "198.51.100.11";
    const token = await newToken("read");
    const base = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base);
    for (let i = 0; i < 5; i++) await call("GET", "/api/projects", bad, ip);
    expect((await call("GET", "/api/projects", bearer(token), ip)).statusCode).toBe(429);
    vi.setSystemTime(base + 61_000);
    expect((await call("GET", "/api/projects", bearer(token), ip)).statusCode).toBe(200);
  });
});

describe("validade e revogação", () => {
  it("expira no instante certo, com o relógio congelado (padrão de 30 dias e a opção de 24 h)", async () => {
    const day = await createToken({ name: "um-dia", scope: "read", expiresInHours: 24 });
    const month = await createToken({ name: "padrao", scope: "read" });
    expect(Date.parse(day.json.info.expiresAt) - Date.parse(day.json.info.createdAt)).toBe(24 * 3_600_000);
    expect(Date.parse(month.json.info.expiresAt) - Date.parse(month.json.info.createdAt)).toBe(30 * 24 * 3_600_000);

    vi.useFakeTimers({ toFake: ["Date"] });
    const created = Date.parse(day.json.info.createdAt);
    vi.setSystemTime(created + 24 * 3_600_000 - 1000);
    expect((await call("GET", "/api/projects", bearer(day.token), "10.50.0.1")).statusCode).toBe(200);
    vi.setSystemTime(created + 24 * 3_600_000);
    expect((await call("GET", "/api/projects", bearer(day.token), "10.50.0.2")).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", bearer(month.token), "10.50.0.3")).statusCode).toBe(200);
    vi.setSystemTime(Date.parse(month.json.info.createdAt) + 30 * 24 * 3_600_000 - 1);
    expect((await call("GET", "/api/projects", bearer(month.token), "10.50.0.5")).statusCode).toBe(200);
    vi.setSystemTime(Date.parse(month.json.info.createdAt) + 30 * 24 * 3_600_000);
    expect((await call("GET", "/api/projects", bearer(month.token), "10.50.0.4")).statusCode).toBe(401);
  });

  it("revogar vale na hora; a lista mostra revogado; auditoria diz quem revogou, sem o token", async () => {
    const made = await createToken({ name: "revogar", scope: "write" });
    expect((await call("POST", "/api/projects/p1/stop", bearer(made.token))).statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${made.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await call("POST", "/api/projects/p1/stop", bearer(made.token), "10.60.0.1")).statusCode).toBe(401);
    const list = (await app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: { cookie } })).json();
    expect(list.tokens[0]).toMatchObject({ id: made.id, status: "revoked" });
    const audit = (await ctx.auditService.list()).entries.find((e) => e.action === "auth.api_token_revoked")!;
    expect(audit).toMatchObject({ actor: "admin", target: made.id });
    expect(JSON.stringify(audit)).not.toContain(made.token);
    // revogar de novo / id inexistente
    expect((await app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${made.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/settings/api-tokens/zzzz", headers: { cookie } })).statusCode).toBe(400);
  });

  it("revogar no meio de uma rajada de pedidos: nenhum 5xx e, depois da revogação, só 401", async () => {
    const made = await createToken({ name: "rajada", scope: "read" });
    const burst = Array.from({ length: 30 }, (_, i) => call("GET", "/api/projects", bearer(made.token), `10.70.${i}.1`));
    const revoke = app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${made.id}`, headers: { cookie } });
    const during = await Promise.all(burst);
    expect((await revoke).statusCode).toBe(200);
    for (const r of during) expect([200, 401]).toContain(r.statusCode);
    const after = await Promise.all(Array.from({ length: 10 }, (_, i) => call("GET", "/api/projects", bearer(made.token), `10.71.${i}.1`)));
    for (const r of after) expect(r.statusCode).toBe(401);
  });

  it("trocar a senha revoga todos os tokens (e as outras sessões), na mesma hora", async () => {
    const a = await newToken("admin", "a");
    const b = await newToken("read", "b");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "OutraSenha456" },
    });
    expect(res.statusCode).toBe(200);
    expect((await call("GET", "/api/projects", bearer(a), "10.80.0.1")).statusCode).toBe(401);
    expect((await call("GET", "/api/projects", bearer(b), "10.80.0.2")).statusCode).toBe(401);
    const entry = (await ctx.auditService.list()).entries.find((e) => e.action === "auth.password_changed")!;
    expect(entry.detail).toContain("2 token(s) de API");
  });

  it("trocar a senha com o disco dos tokens quebrado: 500 que diz o que fazer; senha trocada", async () => {
    await newToken("read");
    await ctx.apiTokens.flush();
    const spy = vi.spyOn(ctx.apiTokens, "revokeAll").mockRejectedValueOnce(new Error("disco"));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "OutraSenha456" },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("tokens_not_revoked");
    expect(res.json().message).toContain("Acesso por IA");
    expect((await ctx.userStore.findByUsername("admin"))!.passwordHash).toBeTruthy();
  });
});

describe("criar, listar e revogar: só sessão humana", () => {
  it("token (mesmo admin) não cria, não lista e não revoga outro token", async () => {
    const admin = await newToken("admin");
    const before = (await ctx.apiTokens.list()).length;
    const create = await app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers: bearer(admin),
      payload: { name: "filho", scope: "admin", currentPassword: PASSWORD },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toBe("token_forbidden");
    expect((await call("GET", "/api/settings/api-tokens", bearer(admin))).statusCode).toBe(403);
    const other = await createToken({ name: "outro", scope: "read" });
    expect((await call("DELETE", `/api/settings/api-tokens/${other.id}`, bearer(admin))).statusCode).toBe(403);
    expect((await ctx.apiTokens.list()).length).toBe(before + 1); // só o "outro"; nenhum "filho"
    expect((await call("GET", "/api/projects", bearer(other.token), "10.90.0.1")).statusCode).toBe(200); // não foi revogado
  });

  it("sem sessão nenhuma: 401", async () => {
    expect((await call("GET", "/api/settings/api-tokens")).statusCode).toBe(401);
  });

  it("a segunda trava dos handlers: se a lista de exclusão falhar, o handler ainda recusa token", async () => {
    // simula a sessão sintética chegando ao handler (como se a exclusão tivesse sumido)
    const policy = await import("../src/services/token-policy.js");
    const ghost = await newToken("admin");
    const spy = vi.spyOn(policy, "classifyRoute").mockReturnValue({ kind: "scope", scope: "read" });
    try {
      const list = await call("GET", "/api/settings/api-tokens", bearer(ghost));
      const create = await app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: bearer(ghost), payload: { name: "x", scope: "read", currentPassword: PASSWORD } });
      const del = await call("DELETE", "/api/settings/api-tokens/0123456789abcdef", bearer(ghost));
      expect([list.statusCode, create.statusCode, del.statusCode]).toEqual([403, 403, 403]);
      expect(list.json().error).toBe("token_forbidden");
    } finally {
      spy.mockRestore();
    }
  });

  it("criar exige a senha atual (errada → 401) e nada é criado", async () => {
    const res = await createToken({ currentPassword: "senha-errada" });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("invalid_current_password");
    expect(await ctx.apiTokens.list()).toEqual([]);
  });

  it("com 2FA ativo exige o código: sem código e com código errado → 400 e nada é criado; com o certo → 201", async () => {
    const { secret } = (await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } })).json();
    const code = () => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
    await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: code() } });
    nowMs += TOTP_STEP_SECONDS * 1000;
    const none = await createToken();
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("invalid_two_factor_code");
    const wrong = await createToken({ code: "000000" });
    expect(wrong.status).toBe(400);
    expect(await ctx.apiTokens.list()).toEqual([]);
    const ok = await createToken({ code: code() });
    expect(ok.status).toBe(201);
    expect(ok.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
  });

  it("2FA: erros repetidos de código bloqueiam a conta (429 two_factor_locked) e o limite por sessão/IP vale", async () => {
    const { secret } = (await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } })).json();
    const code = totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
    await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code } });
    nowMs += TOTP_STEP_SECONDS * 1000;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await createToken({ code: "111111" })).status);
    expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
    expect(statuses.slice(4).every((s) => s === 429)).toBe(true);
    expect(await ctx.apiTokens.list()).toEqual([]);
  });

  it("validações: nome, escopo, validade (1 h a 1 ano), campos extras", async () => {
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "a".repeat(41) },
      { name: "<script>" },
      { name: "token:forjado/x" },
      { name: "-comeca-com-hifen" },
      { scope: "root" },
      { scope: "superadmin" },
      { expiresInHours: 0 },
      { expiresInHours: 24 * 365 + 1 },
      { expiresInHours: 1.5 },
      { expiresInHours: "24" },
      { extra: true },
    ]) {
      const res = await createToken(body as never);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await createToken({ name: "no-limite", expiresInHours: 24 * 365 })).status).toBe(201);
    expect((await createToken({ name: "no-minimo", expiresInHours: 1 })).status).toBe(201);
    expect((await createToken({ name: "Ação nº 1_ok.v2" })).status).toBe(201);
  });

  it("limite de tokens ativos: o seguinte é recusado com 409; nome repetido também", async () => {
    for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) expect((await createToken({ name: `t${i}` })).status).toBe(201);
    const over = await createToken({ name: "excedente" });
    expect(over.status).toBe(409);
    expect(over.json.error).toBe("too_many_tokens");
    const dup = await createToken({ name: "T0" });
    expect(dup.json.error).toBe("too_many_tokens"); // o teto vem antes do nome
  });

  it("nome repetido entre ativos → 409 token_name_taken", async () => {
    await createToken({ name: "igual" });
    const dup = await createToken({ name: "IGUAL" });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("token_name_taken");
  });

  it("a resposta da criação traz o valor UMA vez; lista, auditoria e logs nunca", async () => {
    const made = await createToken({ name: "uma-vez", scope: "write" });
    expect(made.status).toBe(201);
    expect(made.json.info).toMatchObject({ name: "uma-vez", scope: "write", status: "active", lastUsedAt: null, revokedAt: null });
    expect(JSON.stringify(made.json.info)).not.toContain(made.token);
    await call("POST", "/api/projects/p1/stop", bearer(made.token));
    await call("GET", `/api/projects?access_token=${made.token}`, bearer(made.token), "10.99.0.1");
    const list = await app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: { cookie } });
    expect(list.body).not.toContain(made.token);
    expect(list.body).not.toMatch(/hash/i);
    expect(list.headers["cache-control"]).toBe("no-store");
    const created = await app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: { cookie }, payload: { name: "outro", scope: "read", currentPassword: PASSWORD } });
    expect(created.headers["cache-control"]).toBe("no-store");
    const audit = JSON.stringify((await ctx.auditService.list()).entries);
    expect(audit).not.toContain(made.token);
    expect(audit).toContain("auth.api_token_created");
    expect(audit).not.toContain(PASSWORD);
    await ctx.auditService.flush();
    expect(logLines.join("")).not.toContain(made.token);
    expect(logLines.join("")).not.toContain(made.token.slice(API_TOKEN_PREFIX.length));
    expect(logLines.join("")).not.toContain(PASSWORD);
  });

  it("último uso aparece na lista depois que o token é usado", async () => {
    const made = await createToken({ name: "usado", scope: "read" });
    await call("GET", "/api/projects", bearer(made.token));
    await ctx.apiTokens.flush();
    const list = (await app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: { cookie } })).json();
    expect(list.tokens.find((t: any) => t.id === made.id).lastUsedAt).not.toBeNull();
  });
});

describe("auditoria registra quem agiu", () => {
  it("rota que audita sem ator explícito sai como token:<nome>; a de humano segue 'operador'", async () => {
    const token = await newToken("write", "agente x");
    const viaToken = await call("POST", "/api/alerts/a1/ack", bearer(token));
    expect(viaToken.json().actor).toBe("token:agente x");
    const viaHuman = await call("POST", "/api/alerts/a1/ack", { cookie });
    expect(viaHuman.statusCode).toBe(200);
    const entries = (await ctx.auditService.list()).entries.filter((e) => e.action === "teste.sem_ator");
    expect(entries.map((e) => e.actor).sort()).toEqual(["operador", "token:agente x"]);
  });

  it("pedidos de token e de humano ao mesmo tempo não misturam o ator", async () => {
    const token = await newToken("write", "paralelo");
    const calls = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? call("POST", "/api/alerts/a1/ack", bearer(token), `10.110.0.${i + 1}`) : call("POST", "/api/alerts/a1/ack", { cookie }),
      ),
    );
    for (const c of calls) expect(c.statusCode).toBe(200);
    const actors = (await ctx.auditService.list()).entries.filter((e) => e.action === "teste.sem_ator").map((e) => e.actor);
    expect(actors.filter((a) => a === "token:paralelo")).toHaveLength(10);
    expect(actors.filter((a) => a === "operador")).toHaveLength(10);
  });

  it("criar token audita com o humano como ator (nunca token:*) e o escopo/validade, sem o valor", async () => {
    const made = await createToken({ name: "auditado", scope: "admin", expiresInHours: 48 });
    const entry = (await ctx.auditService.list()).entries.find((e) => e.action === "auth.api_token_created")!;
    expect(entry.actor).toBe("admin");
    expect(entry.target).toBe(made.id);
    expect(entry.detail).toContain('"auditado"');
    expect(entry.detail).toContain("escopo admin");
  });
});

describe("falha fechada do cadastro", () => {
  it("disco ilegível: Bearer recebe 503 (nunca 200), sessão humana segue funcionando, e volta quando o disco volta", async () => {
    const token = await newToken("read");
    await ctx.apiTokens.flush();
    const spy = vi.spyOn(ctx.apiTokens, "resolve").mockRejectedValueOnce(new Error("EIO"));
    const res = await call("GET", "/api/projects", bearer(token), "10.120.0.1");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("token_store_unavailable");
    expect(res.body).not.toContain("EIO");
    spy.mockRestore();
    expect((await call("GET", "/api/projects", { cookie })).statusCode).toBe(200);
    expect((await call("GET", "/api/projects", bearer(token), "10.120.0.1")).statusCode).toBe(200);
    // 503 não conta como tentativa errada do IP
    for (let i = 0; i < 6; i++) {
      const s = vi.spyOn(ctx.apiTokens, "resolve").mockRejectedValueOnce(new Error("EIO"));
      expect((await call("GET", "/api/projects", bearer(token), "10.120.0.2")).statusCode).toBe(503);
      s.mockRestore();
    }
  });

  it("listar com o cadastro ilegível → 503 e mensagem sem detalhe do disco", async () => {
    const spy = vi.spyOn(ctx.apiTokens, "list").mockRejectedValueOnce(new Error("EIO /secreto"));
    const res = await app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: { cookie } });
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("secreto");
  });

  it("criar com falha de gravação → 500 'Nada foi criado' e o token não passa a valer", async () => {
    const err = Object.assign(new Error("x"), { code: "storage_write_failed" });
    const spy = vi.spyOn(ctx.apiTokens, "create").mockRejectedValueOnce(err);
    const res = await createToken({ name: "falha" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.json.error).toBe("storage_write_failed");
    expect(res.json.token).toBeUndefined();
    expect(await ctx.apiTokens.list()).toEqual([]);
  });

  it("criar com cadastro ilegível → 503", async () => {
    const spy = vi.spyOn(ctx.apiTokens, "create").mockRejectedValueOnce(new Error("EIO"));
    const res = await createToken({ name: "falha2" });
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.json.error).toBe("token_store_unavailable");
  });

  it("revogar com falha de gravação → 500 e o token continua valendo (a pessoa é avisada)", async () => {
    const made = await createToken({ name: "firme", scope: "read" });
    const err = Object.assign(new Error("x"), { code: "storage_write_failed" });
    const spy = vi.spyOn(ctx.apiTokens, "revoke").mockRejectedValueOnce(err);
    const res = await app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${made.id}`, headers: { cookie } });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain("continua valendo");
    expect((await call("GET", "/api/projects", bearer(made.token), "10.130.0.1")).statusCode).toBe(200);
  });

  it("revogar com erro inesperado propaga (não vira 'sucesso')", async () => {
    const made = await createToken({ name: "inesperado", scope: "read" });
    const spy = vi.spyOn(ctx.apiTokens, "revoke").mockRejectedValueOnce(new Error("bug"));
    const res = await app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${made.id}`, headers: { cookie } });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
  });

  it("usuário apagado entre a sessão e a criação: 401 e a sessão cai", async () => {
    const spy = vi.spyOn(ctx.userStore, "findById").mockResolvedValueOnce(null);
    const res = await createToken();
    spy.mockRestore();
    expect(res.status).toBe(401);
  });
});

describe("parseAuthorization e tokenInUrl (unidades)", () => {
  it("classifica o cabeçalho", () => {
    const t = `${API_TOKEN_PREFIX}${"A".repeat(43)}`;
    expect(parseAuthorization(undefined)).toEqual({ kind: "none" });
    expect(parseAuthorization("")).toEqual({ kind: "none" });
    expect(parseAuthorization("   ")).toEqual({ kind: "none" });
    expect(parseAuthorization(["Bearer a", "Bearer b"])).toEqual({ kind: "malformed" });
    expect(parseAuthorization("Basic abc")).toEqual({ kind: "other" });
    expect(parseAuthorization("Digest x=1")).toEqual({ kind: "other" });
    expect(parseAuthorization("???")).toEqual({ kind: "malformed" });
    expect(parseAuthorization(`Bearer ${t}`)).toEqual({ kind: "bearer", token: t });
    expect(parseAuthorization(`bearer ${t}`)).toEqual({ kind: "bearer", token: t });
    for (const bad of ["Bearer", "Bearer ", "Bearer a b", "Bearer a.b", `Bearer ${"x".repeat(201)}`, "Bearer\ttoken", "Bearer=abc"]) {
      expect(parseAuthorization(bad).kind, bad).toBe("malformed");
    }
  });

  it("acha token ou parâmetro de token no endereço", () => {
    expect(tokenInUrl("/api/projects")).toBe(false);
    expect(tokenInUrl("/api/projects?a=1&b=2")).toBe(false);
    expect(tokenInUrl("/api/terminal/ws?token=setup-token-comum")).toBe(false);
    expect(tokenInUrl("/api/projects?x=tws_pat_abc")).toBe(true);
    expect(tokenInUrl("/api/projects?x=TWS_PAT_abc")).toBe(true);
    expect(tokenInUrl("/api/projects/tws_pat_abc")).toBe(true);
    expect(tokenInUrl("/api/projects?x=tws%5Fpat%5Fabc")).toBe(true);
    expect(tokenInUrl("/api/projects?access_token=1")).toBe(true);
    expect(tokenInUrl("/api/projects?API_TOKEN=1")).toBe(true);
    expect(tokenInUrl("/api/projects?Bearer=1")).toBe(true);
    expect(tokenInUrl("/api/projects?authorization=1")).toBe(true);
    expect(tokenInUrl("/api/projects?%61ccess_token=1")).toBe(true);
    expect(tokenInUrl("/api/projects?%E0%A4%A=1")).toBe(false); // percent mal formado: não quebra
  });
});

describe("sem os decoradores novos (app antiga/teste enxuto)", () => {
  it("Bearer nunca vale quando o cadastro não existe (falha fechada)", async () => {
    const { default: Fastify } = await import("fastify");
    const authPlugin = (await import("../src/plugins/auth.js")).default;
    const bare = Fastify({ logger: false });
    bare.decorate("setupToken", null);
    bare.decorate("setupState", ctx.setupState);
    bare.decorate("userStore", ctx.userStore);
    bare.decorate("sessionStore", ctx.sessionStore);
    bare.decorate("twoFactor", ctx.twoFactor);
    await bare.register(authPlugin);
    bare.get("/api/x", async () => ({ ok: true }));
    await ctx.setupState.load();
    const res = await bare.inject({ method: "GET", url: "/api/x", headers: bearer(`${API_TOKEN_PREFIX}${"A".repeat(43)}`) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(INVALID_BODY);
    const inUrl = await bare.inject({ method: "GET", url: "/api/x?access_token=1" });
    expect(inUrl.statusCode).toBe(400);
    await bare.close();
  });
});
