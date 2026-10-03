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
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "senha-forte-de-teste" },
    });
    expect(res.statusCode).toBe(201);
    expect(createMailbox).toHaveBeenCalledOnce();
    // a senha nunca volta pela API (pedido do dono do produto, 02/10/2026)
    expect(res.body).not.toContain("senha-forte-de-teste");
    expect(res.json()).not.toHaveProperty("password");
  });

  it("recusa criar caixa sem senha: a pessoa define a senha (o painel não mostra senha gerada)", async () => {
    const createMailbox = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas" },
    });
    expect(res.statusCode).toBe(400);
    expect(createMailbox).not.toHaveBeenCalled();
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

  it("recusa senha com menos de 12 caracteres", async () => {
    const createMailbox = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", password: "12345678901" },
    });
    expect(res.statusCode).toBe(400);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("aceita senha longa (>= 200 chars)", async () => {
    const createMailbox = spyOn("createMailbox").mockResolvedValue({
      mailbox: { id: "vendas@exemplo.com", localPart: "vendas", domain: "exemplo.com", kind: "user", createdAt: new Date().toISOString() },
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
      payload: { localPart: "vendas", password: "senha-forte-de-teste", admin: true },
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
      email: { enabled: true, domain: "exemplo.com", mailbox: "loja@exemplo.com", mailFrom: "loja@exemplo.com", env: {} },
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

const VENDAS = {
  id: "vendas@exemplo.com",
  localPart: "vendas",
  domain: "exemplo.com",
  kind: "user" as const,
  createdAt: new Date().toISOString(),
};

describe("PUT /api/mail/mailboxes/:id/password — trocar senha", () => {
  it("'gerar senha forte': repassa ao serviço e devolve a senha gerada UMA vez (sem guardar em cache)", async () => {
    const change = spyOn("changeMailboxPassword").mockResolvedValue({ mailbox: VENDAS, generatedPassword: "Gerada-Forte_123abcXYZ.9" });
    const res = await app.inject({
      method: "PUT",
      url: "/api/mail/mailboxes/vendas%40exemplo.com/password",
      headers: auth,
      payload: { generate: true },
    });
    expect(res.statusCode).toBe(200);
    expect(change).toHaveBeenCalledWith("vendas@exemplo.com", undefined, { generate: true });
    expect(res.json()).toMatchObject({ mailbox: { id: "vendas@exemplo.com" }, generatedPassword: "Gerada-Forte_123abcXYZ.9" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("recusa generate=false sem senha", async () => {
    const change = spyOn("changeMailboxPassword");
    const res = await app.inject({
      method: "PUT",
      url: "/api/mail/mailboxes/vendas%40exemplo.com/password",
      headers: auth,
      payload: { generate: false },
    });
    expect(res.statusCode).toBe(400);
    expect(change).not.toHaveBeenCalled();
  });

  it("troca com senha forte, registra auditoria sem a senha e não devolve a senha", async () => {
    const change = spyOn("changeMailboxPassword").mockResolvedValue({ mailbox: VENDAS });
    const res = await app.inject({
      method: "PUT",
      url: "/api/mail/mailboxes/vendas%40exemplo.com/password",
      headers: auth,
      payload: { password: "nova-senha-forte-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(change).toHaveBeenCalledWith("vendas@exemplo.com", "nova-senha-forte-123");
    expect(res.body).not.toContain("nova-senha-forte-123");
  });

  it("recusa senha curta, ausente ou com campo extra", async () => {
    const change = spyOn("changeMailboxPassword");
    for (const payload of [{ password: "curta" }, {}, { password: "nova-senha-forte-123", x: 1 }]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/mail/mailboxes/vendas%40exemplo.com/password",
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(change).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:id/email — remetente escolhido", () => {
  it("repassa endereço e nome de exibição ao serviço", async () => {
    const enable = spyOn("enableProjectEmail").mockResolvedValue({
      email: {
        enabled: true,
        domain: "exemplo.com",
        mailbox: "nao-responda@exemplo.com",
        mailFrom: "nao-responda@exemplo.com",
        fromName: "Loja Exemplo",
        env: {},
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", fromLocalPart: "nao-responda", fromName: "Loja Exemplo" },
    });
    expect(res.statusCode).toBe(200);
    expect(enable).toHaveBeenCalledWith(expect.anything(), "exemplo.com", { fromLocalPart: "nao-responda", fromName: "Loja Exemplo" });
  });

  it.each([
    ["nome com quebra de linha (injeção de cabeçalho)", { fromName: "Loja\r\nBcc: x@y.com" }],
    ["nome com < >", { fromName: "Loja <x@y.com>" }],
    ["nome com aspas", { fromName: 'Loja "X"' }],
    ["nome longo demais", { fromName: "x".repeat(81) }],
    ["endereço com @", { fromLocalPart: "a@b" }],
    ["endereço com espaço", { fromLocalPart: "nao responda" }],
    ["senha curta", { password: "curta" }],
    ["senha longa demais", { password: "x".repeat(201) }],
    ["generatePassword que não é booleano", { generatePassword: "sim" }],
  ])("%s: 400 e nada muda", async (_label, extra) => {
    const enable = spyOn("enableProjectEmail");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", ...extra },
    });
    expect(res.statusCode).toBe(400);
    expect(enable).not.toHaveBeenCalled();
  });
});

/**
 * Caixa do projeto com senha (02/10/2026): a senha digitada ou "gerar uma
 * forte" chega ao serviço; a gerada volta UMA vez na resposta.
 */
describe("POST /api/projects/:id/email — senha da caixa do projeto", () => {
  it("repassa a senha digitada", async () => {
    const enable = spyOn("enableProjectEmail").mockResolvedValue({
      email: { enabled: true, domain: "exemplo.com", mailbox: "loja@exemplo.com", mailFrom: "loja@exemplo.com", env: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", password: "senha-forte-da-pessoa" },
    });
    expect(res.statusCode).toBe(200);
    expect(enable).toHaveBeenCalledWith(expect.anything(), "exemplo.com", { password: "senha-forte-da-pessoa" });
    expect(res.body).not.toContain("senha-forte-da-pessoa");
  });

  it("'gerar senha forte': devolve a gerada uma vez, sem cache", async () => {
    const enable = spyOn("enableProjectEmail").mockResolvedValue({
      email: { enabled: true, domain: "exemplo.com", mailbox: "loja@exemplo.com", mailFrom: "loja@exemplo.com", env: {} },
      generatedPassword: "Gerada-Forte_123abcXYZ.9",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", generatePassword: true },
    });
    expect(res.statusCode).toBe(200);
    expect(enable).toHaveBeenCalledWith(expect.anything(), "exemplo.com", { generatePassword: true });
    expect(res.json()).toMatchObject({ email: { mailbox: "loja@exemplo.com" }, generatedPassword: "Gerada-Forte_123abcXYZ.9" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

/**
 * Ligar valores do e-mail às variáveis do app (02/10/2026): o painel guarda
 * só o mapeamento (nome da variável → valor do e-mail).
 */
describe("PUT /api/projects/:id/email/links", () => {
  it("repassa o mapeamento ao serviço", async () => {
    const set = spyOn("setProjectEmailLinks").mockResolvedValue({
      enabled: true,
      domain: "exemplo.com",
      mailbox: "loja@exemplo.com",
      mailFrom: "loja@exemplo.com",
      env: {},
      envLinks: { SMTP_SENHA: "SMTP_PASS" },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/email/links",
      headers: auth,
      payload: { links: { SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM" } },
    });
    expect(res.statusCode).toBe(200);
    expect(set).toHaveBeenCalledWith("p1", { SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM" });
    expect(res.json()).toMatchObject({ email: { envLinks: { SMTP_SENHA: "SMTP_PASS" } } });
  });

  it.each([
    ["valor que não é do e-mail", { links: { SENHA: "ADMIN_SECRET" } }],
    ["nome com hífen", { links: { "SMTP-SENHA": "SMTP_PASS" } }],
    ["nome começando com número", { links: { "1X": "SMTP_PASS" } }],
    ["sem links", {}],
    ["campo extra", { links: {}, x: 1 }],
  ])("%s: 400 e nada muda", async (_label, payload) => {
    const set = spyOn("setProjectEmailLinks");
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/email/links", headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it("projeto inexistente: 404", async () => {
    deployService.getProject!.mockResolvedValueOnce(null);
    const set = spyOn("setProjectEmailLinks");
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/nada/email/links",
      headers: auth,
      payload: { links: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/domains/:domain/mailboxes — senha gerada", () => {
  it("aceita generatePassword sem senha e devolve a senha gerada só nesta resposta", async () => {
    const create = spyOn("createMailbox").mockResolvedValue({
      mailbox: { id: "vendas@exemplo.com", localPart: "vendas", domain: "exemplo.com", kind: "user", createdAt: new Date().toISOString() },
      generatedPassword: "Gerada-Forte_123.abcXYZ",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas", generatePassword: true },
    });
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith("exemplo.com", "vendas", undefined, { generate: true });
    expect(res.json().generatedPassword).toBe("Gerada-Forte_123.abcXYZ");
  });

  it("sem senha e sem generatePassword: 400", async () => {
    const create = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "vendas" },
    });
    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
