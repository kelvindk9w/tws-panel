/**
 * Rotas do nome de exibição das caixas: PUT /api/mail/mailboxes/:id/display-name e o campo displayName
 * na criação (global, aba do projeto) e na ativação do e-mail do projeto. O MailService é espiado.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type Project } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const PROJECT: Project = {
  id: "p1",
  name: "Loja",
  slug: "loja",
  ingestMode: "git",
  source: "https://github.com/usuario/repo.git",
  branch: "main",
  domain: "loja.localhost",
  websocket: false,
  detection: null,
  proxyService: null,
  proxyPort: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastDeployAt: null,
  lastDeployStatus: null,
  deployedBranch: null,
  deployedSource: null,
};


function makeConfig(dir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    projectsDir: `${dir}/projects`,
    webDist: dir,
    allowedOrigins: [],
    setupTokenFile: `${dir}/setup-token`,
    securityTarget: "container",
    securityTargetContainer: "paas-target-test",
    hardeningScriptsDir: dir,
    hostHelperImage: "alpine:3",
    hostRepoDir: dir,
    caddyHttpPort: 8080,
    caddyHttpsPort: 8443,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: null,
    publicIpv6: null,
    monitorIntervalMs: 60_000,
    dockerSocketPath: "/var/run/docker.sock",
    terminalIdleTimeoutMs: 1_800_000,
    terminalEnableWindowMs: 1_800_000,
    terminalEnableIdleMs: 900_000,
    terminalSudoPasswordTimeoutMs: 120_000,
    panelDomain: null,
    terminalUser: null,
    terminalRootMode: null,
  };
}

let ctx: AuthTestContext;
let app: FastifyInstance;
let deployService: Record<string, ReturnType<typeof vi.fn>>;
let spies: MockInstance[];

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", makeConfig(ctx.dir));
  deployService = {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    setProjectRemovedListener: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(async () => PROJECT),
  };
  app.decorate("deployService", deployService as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
  spies = [];
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await closeAuthTestApp(ctx);
});

/** Espiona um método do MailService (evita tocar Docker/Stalwart reais). */
function spyOn<M extends keyof MailService>(method: M) {
  const spy = vi.spyOn(MailService.prototype, method as never) as unknown as MockInstance;
  spies.push(spy);
  return spy;
}


const box = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  localPart: id.split("@")[0]!,
  domain: "exemplo.com",
  kind: "user" as const,
  createdAt: new Date(0).toISOString(),
  ...extra,
});

const url = (id = "contato@exemplo.com") => `/api/mail/mailboxes/${encodeURIComponent(id)}/display-name`;

describe("PUT /api/mail/mailboxes/:id/display-name", () => {
  it("altera o nome, devolve a caixa e não faz deploy", async () => {
    const set = spyOn("setMailboxDisplayName").mockResolvedValue({ mailbox: box("contato@exemplo.com", { displayName: "Contato" }) });
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload: { displayName: "Contato" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().mailbox.displayName).toBe("Contato");
    expect(set).toHaveBeenCalledWith("contato@exemplo.com", "Contato", expect.objectContaining({ projectName: expect.any(Function) }));
    expect(deployService).not.toHaveProperty("deploy");
  });

  it("devolve o aviso de próximo deploy quando é a caixa de envio e o nome do projeto dono", async () => {
    spyOn("setMailboxDisplayName").mockResolvedValue({
      mailbox: box("loja@exemplo.com", { displayName: "Loja", projectId: "p1" }),
      projectEmail: { projectId: "p1", appliesOnNextDeploy: true },
    });
    const res = await app.inject({ method: "PUT", url: url("loja@exemplo.com"), headers: auth, payload: { displayName: "Loja" } });
    expect(res.json()).toMatchObject({ projectEmail: { projectId: "p1", appliesOnNextDeploy: true }, mailbox: { projectName: "Loja" } });
  });

  it("projectId: confere que o projeto existe (404) e repassa o escopo ao service", async () => {
    const set = spyOn("setMailboxDisplayName").mockResolvedValue({ mailbox: box("a@exemplo.com") });
    deployService.getProject!.mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "PUT", url: url("a@exemplo.com"), headers: auth, payload: { displayName: "A", projectId: "nao-existe" } });
    expect(missing.statusCode).toBe(404);
    expect(set).not.toHaveBeenCalled();
    await app.inject({ method: "PUT", url: url("a@exemplo.com"), headers: auth, payload: { displayName: "A", projectId: "p1" } });
    expect(set).toHaveBeenCalledWith("a@exemplo.com", "A", expect.objectContaining({ projectId: "p1" }));
  });

  it("caixa de outro projeto: o 403 do service chega como 403", async () => {
    spyOn("setMailboxDisplayName").mockRejectedValue(Object.assign(new Error("não é deste projeto"), { statusCode: 403, code: "mailbox_not_in_project" }));
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload: { displayName: "X", projectId: "p1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("mailbox_not_in_project");
  });

  it("aceita nome vazio (remover)", async () => {
    const set = spyOn("setMailboxDisplayName").mockResolvedValue({ mailbox: box("contato@exemplo.com") });
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload: { displayName: "" } });
    expect(res.statusCode).toBe(200);
    expect(set).toHaveBeenCalledWith("contato@exemplo.com", "", expect.anything());
  });

  it.each([
    ["sem o campo", {}],
    ["CRLF", { displayName: "Oi\r\nBcc: x@evil.test" }],
    ["LF", { displayName: "Oi\nX" }],
    ["TAB", { displayName: "Oi\tX" }],
    ["< >", { displayName: "Oi <a@b.c>" }],
    ["aspas", { displayName: 'Oi "X"' }],
    ["barra invertida", { displayName: "Oi\\X" }],
    ["81 caracteres", { displayName: "x".repeat(81) }],
    ["zero-width", { displayName: "Oi​X" }],
    ["marca LRM", { displayName: "Oi‎X" }],
    ["marca ALM", { displayName: "Oi؜X" }],
    ["BOM", { displayName: "Oi﻿X" }],
    ["surrogate solto", { displayName: "Oi\ud800" }],
    ["não é texto", { displayName: 42 }],
    ["campo a mais", { displayName: "Oi", password: "x".repeat(20) }],
    ["projectId enorme", { displayName: "Oi", projectId: "x".repeat(65) }],
  ])("recusa corpo %s (400) sem chamar o service", async (_why, payload) => {
    const set = spyOn("setMailboxDisplayName");
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("aceita 80 caracteres com acento e emoji (conta caracteres, não bytes)", async () => {
    const set = spyOn("setMailboxDisplayName").mockResolvedValue({ mailbox: box("contato@exemplo.com") });
    const name = "ã".repeat(79) + "😀";
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload: { displayName: name } });
    expect(res.statusCode, res.body).toBe(200);
    expect(set).toHaveBeenCalledWith("contato@exemplo.com", name, expect.anything());
  });

  it("exige sessão (sem credencial: 401) e id enorme é recusado", async () => {
    const set = spyOn("setMailboxDisplayName");
    const anon = await app.inject({ method: "PUT", url: url(), payload: { displayName: "X" } });
    expect(anon.statusCode).toBe(401);
    const big = await app.inject({ method: "PUT", url: url("a".repeat(95) + "@exemplo.com"), headers: auth, payload: { displayName: "X" } });
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("falha do service sem código vira erro sem vazar detalhes internos", async () => {
    spyOn("setMailboxDisplayName").mockRejectedValue(new Error("Stalwart fora"));
    const res = await app.inject({ method: "PUT", url: url(), headers: auth, payload: { displayName: "X" } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});

describe("displayName na criação e fromName na ativação", () => {
  it("criar: o nome (aparado) vai ao service; vazio não vai", async () => {
    const create = spyOn("createMailbox").mockResolvedValue({ mailbox: box("vendas@exemplo.com", { displayName: "Vendas" }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "senha-forte-de-teste", displayName: "Vendas" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(create).toHaveBeenCalledWith("exemplo.com", "vendas", "senha-forte-de-teste", { displayName: "Vendas" });
    create.mockClear();
    await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "senha-forte-de-teste", displayName: "" },
    });
    expect(create).toHaveBeenCalledWith("exemplo.com", "vendas", "senha-forte-de-teste");
  });

  it("criar pela aba do projeto: nome e dono juntos", async () => {
    const create = spyOn("createMailbox").mockResolvedValue({ mailbox: box("suporte@exemplo.com", { projectId: "p1" }) });
    await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "suporte", generatePassword: true, projectId: "p1", displayName: "Suporte" },
    });
    expect(create).toHaveBeenCalledWith("exemplo.com", "suporte", undefined, { generate: true, projectId: "p1", displayName: "Suporte" });
  });

  it.each(["Oi\r\nBcc: x@evil.test", "Oi <x@y.z>", "x".repeat(81)])("criar com nome inválido %j: 400", async (displayName) => {
    const create = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "senha-forte-de-teste", displayName },
    });
    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("ativar o e-mail do projeto: fromName com CRLF é recusado; vazio é aceito (vale o nome do projeto)", async () => {
    const enable = spyOn("enableProjectEmail").mockResolvedValue({ email: { enabled: true, domain: "exemplo.com", mailbox: "loja@exemplo.com", mailFrom: "loja@exemplo.com", env: {} } });
    const bad = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", password: "senha-forte-de-teste", fromName: "Oi\r\nBcc: x@evil.test" },
    });
    expect(bad.statusCode).toBe(400);
    expect(enable).not.toHaveBeenCalled();
    const ok = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", password: "senha-forte-de-teste", fromName: "" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(enable).toHaveBeenCalledWith(PROJECT, "exemplo.com", { password: "senha-forte-de-teste" });
  });
});
