/**
 * Validação de schema das rotas de e-mail (/api/mail/*, /api/projects/:id/email).
 *
 * Sem `schema` no Fastify a API aceita qualquer corpo/param e a validação
 * fica a cargo do MailService — inconsistente e, no caso do param :domain,
 * perigoso (o valor vira nome de diretório e argumento de comando no
 * Stalwart). Estes testes fixam o contrato: entrada malformada é recusada
 * com 400 no formato de erro do painel ({ error, message }) e o
 * MailService nunca chega a ser chamado.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type MailDomainSummary, type Project } from "@paas/core";
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

const DOMAIN_SUMMARY: MailDomainSummary = {
  name: "exemplo.com",
  dkimSelector: "paas",
  dkimPublicKey: "abc",
  dkimKeyBits: 2048,
  dmarcStage: "none",
  createdAt: new Date().toISOString(),
  mailboxCount: 1,
  lastVerify: null,
};

function makeConfig(dir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
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
  };
}

let ctx: AuthTestContext;
let app: FastifyInstance;
let deployService: { setEnvProvider: ReturnType<typeof vi.fn>; getProject: ReturnType<typeof vi.fn> };
let spies: MockInstance[];

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", makeConfig(ctx.dir));
  deployService = {
    setEnvProvider: vi.fn(),
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

describe("POST /api/mail/domains — schema", () => {
  it("aceita corpo válido", async () => {
    const addDomain = spyOn("addDomain").mockResolvedValue(DOMAIN_SUMMARY);
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "exemplo.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(addDomain).toHaveBeenCalledOnce();
  });

  it("recusa corpo sem o campo domain sem chamar o service", async () => {
    const addDomain = spyOn("addDomain");
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(addDomain).not.toHaveBeenCalled();
  });

  it("recusa domínio com caractere inválido (injeção de comando)", async () => {
    const addDomain = spyOn("addDomain");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "exemplo.com; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
    expect(addDomain).not.toHaveBeenCalled();
  });

  it("recusa domínio com path traversal", async () => {
    const addDomain = spyOn("addDomain");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "../../etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(addDomain).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const addDomain = spyOn("addDomain");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "exemplo.com", isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(addDomain).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/mail/domains/:domain — schema", () => {
  it("aceita domínio válido", async () => {
    const removeDomain = spyOn("removeDomain").mockResolvedValue(undefined);
    const res = await app.inject({ method: "DELETE", url: "/api/mail/domains/exemplo.com", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(removeDomain).toHaveBeenCalledOnce();
  });

  it("recusa domínio com caractere inválido no param", async () => {
    const removeDomain = spyOn("removeDomain");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mail/domains/exemplo.com%3Brm",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(removeDomain).not.toHaveBeenCalled();
  });
});

describe("GET /api/mail/domains/:domain/dns — schema", () => {
  it("recusa domínio com espaço no param", async () => {
    const dnsChecklist = spyOn("dnsChecklist");
    const res = await app.inject({
      method: "GET",
      url: "/api/mail/domains/exemplo%20com/dns",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(dnsChecklist).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/domains/:domain/verify — schema", () => {
  it("recusa domínio sem TLD (formato inválido)", async () => {
    const verifyDomain = spyOn("verifyDomain");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/localhost/verify",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(verifyDomain).not.toHaveBeenCalled();
  });
});

describe("GET /api/mail/domains/:domain/mailboxes — schema", () => {
  it("recusa domínio inválido no param", async () => {
    const listMailboxes = spyOn("listMailboxes");
    const res = await app.inject({
      method: "GET",
      url: "/api/mail/domains/exemplo%3Bcom/mailboxes",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(listMailboxes).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/domains/:domain/mailboxes — schema", () => {
  it("aceita corpo válido", async () => {
    const createMailbox = spyOn("createMailbox").mockResolvedValue({
      mailbox: { id: "vendas@exemplo.com", localPart: "vendas", domain: "exemplo.com", kind: "user", createdAt: new Date().toISOString() },
      password: "senha-gerada-123",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas" },
    });
    expect(res.statusCode).toBe(201);
    expect(createMailbox).toHaveBeenCalledOnce();
  });

  it("recusa corpo sem localPart", async () => {
    const createMailbox = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("recusa senha curta demais (abaixo do mínimo exigido pelo service)", async () => {
    const createMailbox = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "1234567" },
    });
    expect(res.statusCode).toBe(400);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("aceita senha longa (>= 200 chars)", async () => {
    const createMailbox = spyOn("createMailbox").mockResolvedValue({
      mailbox: { id: "vendas@exemplo.com", localPart: "vendas", domain: "exemplo.com", kind: "user", createdAt: new Date().toISOString() },
      password: "x".repeat(200),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "x".repeat(200) },
    });
    expect(res.statusCode).toBe(201);
    expect(createMailbox).toHaveBeenCalledOnce();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const createMailbox = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", admin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(createMailbox).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/mail/domains/:domain/mailboxes/:id — schema", () => {
  it("recusa domínio inválido no param mesmo com id válido", async () => {
    const deleteMailbox = spyOn("deleteMailbox");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mail/domains/exemplo%3Bcom/mailboxes/vendas%40exemplo.com",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(deleteMailbox).not.toHaveBeenCalled();
  });
});

describe("GET /api/mail/mailboxes/:id/credentials — schema", () => {
  it("aceita id de tamanho normal (email codificado)", async () => {
    const mailboxCredentials = spyOn("mailboxCredentials").mockResolvedValue({
      email: "vendas@exemplo.com",
      username: "vendas@exemplo.com",
      password: "senha",
      imap: { host: "mail.exemplo.com", port: 993, security: "ssl" },
      imapAlt: { host: "mail.exemplo.com", port: 143, security: "starttls" },
      smtp: { host: "mail.exemplo.com", port: 587, security: "starttls" },
      smtpAlt: { host: "mail.exemplo.com", port: 465, security: "ssl" },
      notes: [],
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/mail/mailboxes/vendas%40exemplo.com/credentials",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(mailboxCredentials).toHaveBeenCalledOnce();
  });

  it("recusa id acima do tamanho máximo do schema (email jamais seria tão longo)", async () => {
    // 95 chars: abaixo do teto interno do Fastify para params (100, que
    // responderia 414 antes de qualquer schema) e acima do maxLength do
    // schema — exercita a validação do schema, não o limite do roteador.
    const mailboxCredentials = spyOn("mailboxCredentials");
    const res = await app.inject({
      method: "GET",
      url: `/api/mail/mailboxes/${"a".repeat(95)}/credentials`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(mailboxCredentials).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/email — schema", () => {
  it("recusa id de projeto acima do tamanho máximo", async () => {
    const projectEmailConfig = spyOn("projectEmailConfig");
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${"p".repeat(65)}/email`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(deployService.getProject).not.toHaveBeenCalled();
    expect(projectEmailConfig).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:id/email — schema", () => {
  it("aceita corpo válido", async () => {
    const enableProjectEmail = spyOn("enableProjectEmail").mockResolvedValue({
      enabled: true,
      domain: "exemplo.com",
      mailbox: "loja@exemplo.com",
      mailFrom: "loja@exemplo.com",
      env: {},
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(enableProjectEmail).toHaveBeenCalledOnce();
  });

  it("recusa corpo sem domain", async () => {
    const enableProjectEmail = spyOn("enableProjectEmail");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(enableProjectEmail).not.toHaveBeenCalled();
  });

  it("recusa domínio malformado no corpo", async () => {
    const enableProjectEmail = spyOn("enableProjectEmail");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
    expect(enableProjectEmail).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const enableProjectEmail = spyOn("enableProjectEmail");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", force: true },
    });
    expect(res.statusCode).toBe(400);
    expect(enableProjectEmail).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/:id/email — schema", () => {
  it("recusa id de projeto acima do tamanho máximo", async () => {
    const disableProjectEmail = spyOn("disableProjectEmail");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${"p".repeat(65)}/email`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(deployService.getProject).not.toHaveBeenCalled();
    expect(disableProjectEmail).not.toHaveBeenCalled();
  });
});
