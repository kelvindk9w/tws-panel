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
import { readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type MailDomainSummary, type Project } from "@paas/core";
import { evaluateMtaStsItem, fetchMtaStsPolicy } from "@paas/mailer";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

// A política MTA-STS não é aberta de verdade (sem rede): o aquecimento da emissão chama esta função.
vi.mock("@paas/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paas/mailer")>()),
  fetchMtaStsPolicy: vi.fn(async () => null),
  // a avaliação do item (DNS público + abertura da política) é trocada: aqui só interessa o que a lista faz com o resultado
  evaluateMtaStsItem: vi.fn(async () => ({ id: "mta_sts", level: "ok", inbox: false, code: "testing", params: { mode: "testing" } })),
}));

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
let pointsHere: ReturnType<typeof vi.fn>;
/** Temporizadores que o plugin de e-mail agendou (a rodada do MTA-STS roda 90 s depois da subida e a cada 30 min). */
let timers: Array<{ kind: "timeout" | "interval"; ms: number; fn: () => void }>;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", makeConfig(ctx.dir));
  timers = [];
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  spies = [
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      timers.push({ kind: "timeout", ms: ms ?? 0, fn });
      return realTimeout(fn, ms, ...(rest as []));
    }) as never) as unknown as MockInstance,
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      timers.push({ kind: "interval", ms: ms ?? 0, fn });
      return realInterval(fn, ms, ...(rest as []));
    }) as never) as unknown as MockInstance,
  ];
  pointsHere = vi.fn(async () => false);
  app.decorate("dynamicDomains", { pointsHere } as unknown as FastifyInstance["dynamicDomains"]);
  vi.mocked(fetchMtaStsPolicy).mockClear();
  deployService = {
    mtaStsPublishing: vi.fn(async () => true),
    mtaStsSites: vi.fn(async () => [{ host: "mta-sts.exemplo.com", policy: "" }]),
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    setProjectRemovedListener: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(async () => PROJECT),
  };
  app.decorate("deployService", deployService as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
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

  it("remover o domínio de e-mail esquece o modo guardado do MTA-STS (um recadastro não herda o enforce)", async () => {
    spyOn("removeDomain").mockResolvedValue(undefined);
    const file = `${ctx.dir}/mail-health-mta-sts-modes.json`;
    await writeFile(file, JSON.stringify({ "exemplo.com": "enforce", "outro.com": "enforce" }));
    const res = await app.inject({ method: "DELETE", url: "/api/mail/domains/exemplo.com", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "outro.com": "enforce" });
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
 * Usar uma caixa que já existe como a do e-mail do projeto, e soltar o e-mail
 * quando o projeto é removido.
 */
describe("POST /api/projects/:id/email — caixa que já existe", () => {
  const config = { enabled: true, domain: "exemplo.com", mailbox: "contato@exemplo.com", mailFrom: "contato@exemplo.com", env: {} };

  it("senha atual: repassa ao serviço, informa se foi conferida, audita sem a senha", async () => {
    const connect = spyOn("connectExistingMailbox").mockResolvedValue({ email: config, passwordVerified: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", fromLocalPart: "contato", useExistingMailbox: "current_password", password: "senha-atual-da-caixa-1", fromName: "Contato" },
    });
    expect(res.statusCode).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.anything(), "exemplo.com", "contato", {
      mode: "current_password",
      password: "senha-atual-da-caixa-1",
      fromName: "Contato",
    });
    expect(res.json()).toMatchObject({ passwordVerified: true });
    expect(res.body).not.toContain("senha-atual-da-caixa-1");
    await ctx.auditService.flush();
    const entries = JSON.stringify((await ctx.auditService.list()).entries);
    expect(entries).toContain("mail.project.mailbox.connect");
    expect(entries).toContain("contato@exemplo.com");
    expect(entries).not.toContain("senha-atual-da-caixa-1");
  });

  it("trocar a senha: devolve a gerada uma vez, sem cache", async () => {
    spyOn("connectExistingMailbox").mockResolvedValue({ email: config, generatedPassword: "Gerada-Forte_123abcXYZ.9" });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", fromLocalPart: "contato", useExistingMailbox: "replace_password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ generatedPassword: "Gerada-Forte_123abcXYZ.9" });
    expect(res.headers["cache-control"]).toBe("no-store");
    await ctx.auditService.flush();
    const entries = JSON.stringify((await ctx.auditService.list()).entries);
    expect(entries).toContain("mail.project.mailbox.connect");
    expect(entries).not.toContain("Gerada-Forte_123abcXYZ.9");
  });

  it("sem a caixa (fromLocalPart) ou com modo desconhecido: 400 e o serviço nem é chamado", async () => {
    const connect = spyOn("connectExistingMailbox");
    for (const payload of [
      { domain: "exemplo.com", useExistingMailbox: "keep_password" },
      { domain: "exemplo.com", fromLocalPart: "contato", useExistingMailbox: "apagar_tudo" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/projects/p1/email", headers: auth, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("erro do serviço (caixa de outro projeto) sai como 409 com a mensagem", async () => {
    spyOn("connectExistingMailbox").mockRejectedValue(
      Object.assign(new Error("A caixa contato@exemplo.com já é usada pelo projeto Outra."), { statusCode: 409, code: "mailbox_in_use" }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/email",
      headers: auth,
      payload: { domain: "exemplo.com", fromLocalPart: "contato", useExistingMailbox: "keep_password" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mailbox_in_use" });
  });
});

describe("GET /api/projects/:id/email/mailboxes", () => {
  it("lista as caixas usáveis do domínio", async () => {
    const list = spyOn("listUsableMailboxes").mockResolvedValue([
      { address: "contato@exemplo.com", localPart: "contato", kind: "user", passwordKnown: false },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/email/mailboxes?domain=exemplo.com", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mailboxes: [{ address: "contato@exemplo.com", localPart: "contato", kind: "user", passwordKnown: false }] });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "exemplo.com");
  });

  it("domínio malformado ou ausente: 400; projeto inexistente: 404", async () => {
    const list = spyOn("listUsableMailboxes");
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/email/mailboxes", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/email/mailboxes?domain=a;b", headers: auth })).statusCode).toBe(400);
    deployService.getProject!.mockResolvedValueOnce(undefined as never);
    expect((await app.inject({ method: "GET", url: "/api/projects/nada/email/mailboxes?domain=exemplo.com", headers: auth })).statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("remover um projeto solta o e-mail dele", () => {
  it("o plugin de e-mail registra o ouvinte, que chama releaseProjectEmail; a falha do serviço sobe para o deploy tratar", async () => {
    const release = spyOn("releaseProjectEmail").mockResolvedValue(undefined);
    expect(deployService.setProjectRemovedListener).toHaveBeenCalledOnce();
    const listener = deployService.setProjectRemovedListener!.mock.calls[0]![0] as (id: string) => Promise<void>;
    await listener("p1");
    expect(release).toHaveBeenCalledWith("p1");
    release.mockRejectedValueOnce(new Error("fora"));
    await expect(listener("p1")).rejects.toThrow("fora");
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

/**
 * Pedido do dono do produto (03/10/2026): a aba Caixas do e-mail do projeto
 * mostra só as caixas daquele projeto; a página do domínio mostra todas,
 * com o projeto dono de cada uma.
 */
describe("caixas do projeto — /api/mail/domains/:domain/mailboxes", () => {
  const box = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    localPart: id.split("@")[0]!,
    domain: "exemplo.com",
    kind: "user" as const,
    createdAt: new Date(0).toISOString(),
    ...extra,
  });

  it("criar pela aba do projeto: confere que o projeto existe e grava o dono", async () => {
    const create = spyOn("createMailbox").mockResolvedValue({ mailbox: box("suporte@exemplo.com", { projectId: "p1" }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "suporte", password: "senha-forte-de-teste", projectId: "p1" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(deployService.getProject).toHaveBeenCalledWith("p1");
    expect(create).toHaveBeenCalledWith("exemplo.com", "suporte", "senha-forte-de-teste", { projectId: "p1" });
  });

  it("projeto que não existe: 404, sem criar a caixa", async () => {
    deployService.getProject!.mockResolvedValueOnce(null);
    const create = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "suporte", generatePassword: true, projectId: "nao-existe" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    expect(create).not.toHaveBeenCalled();
  });

  it("projectId fora do formato: 400", async () => {
    const create = spyOn("createMailbox");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains/exemplo.com/mailboxes",
      headers: auth,
      payload: { localPart: "suporte", generatePassword: true, projectId: "x".repeat(65) },
    });
    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("listar com ?projectId= pede só as do projeto; a lista traz o nome do projeto dono", async () => {
    const list = spyOn("listMailboxes").mockResolvedValue([box("contato@exemplo.com", { kind: "project", projectId: "p1" })]);
    const res = await app.inject({ method: "GET", url: "/api/mail/domains/exemplo.com/mailboxes?projectId=p1", headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(list).toHaveBeenCalledWith("exemplo.com", { projectId: "p1" });
    expect(res.json().mailboxes).toEqual([expect.objectContaining({ id: "contato@exemplo.com", projectId: "p1", projectName: "Loja" })]);
  });

  it("sem filtro: todas; dono que não existe mais fica sem nome", async () => {
    deployService.getProject!.mockImplementation(async (id: string) => (id === "p1" ? PROJECT : null));
    const list = spyOn("listMailboxes").mockResolvedValue([
      box("vendas@exemplo.com"),
      box("contato@exemplo.com", { projectId: "p1" }),
      box("velha@exemplo.com", { projectId: "removido" }),
    ]);
    const res = await app.inject({ method: "GET", url: "/api/mail/domains/exemplo.com/mailboxes", headers: auth });
    expect(list).toHaveBeenCalledWith("exemplo.com", {});
    const boxes = res.json().mailboxes as Record<string, unknown>[];
    expect(boxes[0]).not.toHaveProperty("projectName");
    expect(boxes[1]).toMatchObject({ projectName: "Loja" });
    expect(boxes[2]).toMatchObject({ projectId: "removido" });
    expect(boxes[2]).not.toHaveProperty("projectName");
  });
});

describe("MTA-STS publicado pelo painel junto do domínio de e-mail", () => {
  const sts = { ...DOMAIN_SUMMARY, name: "exemplo.com" };
  const flushAll = async (): Promise<void> => {
    // a publicação lê e grava o registro de aquecimentos em arquivo: dá tempo ao disco, não só às promessas
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    spyOn("mailHosts").mockResolvedValue([]);
    spyOn("syncTls").mockResolvedValue({} as never);
    spyOn("mtaStsSites").mockResolvedValue([{ host: "mta-sts.exemplo.com", policy: "" }]);
    spyOn("listDomains").mockResolvedValue([sts]);
    spyOn("healthPlanInput").mockResolvedValue({
      domain: "exemplo.com",
      mailHostname: "mail.exemplo.com",
      serverHostname: "mail.exemplo.com",
      serverIp: "203.0.113.10",
      dkimSelector: "paas",
      dkimPublicKey: "AAAA",
      dmarcStage: "none",
    });
  });

  it("criar o domínio com o DNS ainda sem apontar: o registro nasce 'aguardando DNS' e nada é pedido ao Let's Encrypt", async () => {
    spyOn("addDomain").mockResolvedValue(sts);
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "exemplo.com" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().domain).toMatchObject({ name: "exemplo.com", mtaSts: "waiting_dns" });
    expect(pointsHere).toHaveBeenCalledWith("mta-sts.exemplo.com");
    await flushAll();
    expect(fetchMtaStsPolicy).not.toHaveBeenCalled();
  });

  it("DNS já apontando: 'emitindo' na resposta e, depois que o proxy recarregou, a própria URL é aberta para aquecer o certificado", async () => {
    pointsHere.mockResolvedValue(true);
    spyOn("addDomain").mockResolvedValue(sts);
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "exemplo.com" } });
    expect(res.json().domain.mtaSts).toBe("issuing");
    await flushAll();
    expect(deployService.refreshProxy).toHaveBeenCalled();
    expect(fetchMtaStsPolicy).toHaveBeenCalledWith("exemplo.com", expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("sem o domínio do painel (o proxy não publica) o registro diz 'indisponível'", async () => {
    deployService.mtaStsPublishing!.mockResolvedValue(false);
    spyOn("addDomain").mockResolvedValue(sts);
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "exemplo.com" } });
    expect(res.json().domain.mtaSts).toBe("unavailable");
  });

  it("a lista de domínios traz o estado conhecido; remover o domínio o esquece", async () => {
    spyOn("addDomain").mockResolvedValue(sts);
    spyOn("removeDomain").mockResolvedValue(undefined);
    expect((await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth })).json().domains[0].mtaSts).toBeUndefined();
    await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "exemplo.com" } });
    expect((await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth })).json().domains[0].mtaSts).toBe("waiting_dns");
    await app.inject({ method: "DELETE", url: "/api/mail/domains/exemplo.com", headers: auth });
    expect((await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth })).json().domains[0].mtaSts).toBeUndefined();
  });

  it("na subida (90 s depois) e a cada 30 min o painel roda a publicação dos domínios que ainda não têm a política ativa", async () => {
    const first = timers.find((t) => t.kind === "timeout" && t.ms === 90_000);
    const periodic = timers.find((t) => t.kind === "interval" && t.ms === 30 * 60_000);
    expect(first).toBeDefined();
    expect(periodic).toBeDefined();
    pointsHere.mockResolvedValue(true);
    first!.fn();
    await flushAll();
    // o nome ainda não estava registrado no proxy: recarrega e aquece a emissão
    expect(deployService.refreshProxy).toHaveBeenCalled();
    expect(fetchMtaStsPolicy).toHaveBeenCalledWith("exemplo.com", expect.objectContaining({ timeoutMs: 30_000 }));
    const after = await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth });
    expect(after.json().domains[0].mtaSts).toBe("issuing");
    // a rodada periódica não repete o pedido dentro do intervalo do domínio
    vi.mocked(fetchMtaStsPolicy).mockClear();
    periodic!.fn();
    await flushAll();
    expect(fetchMtaStsPolicy).not.toHaveBeenCalled();
  });

  it("política que abre vira 'ativo' na lista", async () => {
    pointsHere.mockResolvedValue(true);
    vi.mocked(fetchMtaStsPolicy).mockResolvedValueOnce("version: STSv1");
    timers.find((t) => t.ms === 90_000)!.fn();
    await flushAll();
    expect((await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth })).json().domains[0].mtaSts).toBe("active");
  });

  it("política que abre mas sem o TXT NÃO é 'ativa' na lista: o estado vem do mesmo item da saúde ('falta o TXT')", async () => {
    pointsHere.mockResolvedValue(true);
    vi.mocked(fetchMtaStsPolicy).mockResolvedValueOnce("version: STSv1");
    vi.mocked(evaluateMtaStsItem).mockResolvedValueOnce({ id: "mta_sts", level: "optional", inbox: false, code: "missing_txt", params: {} });
    timers.find((t) => t.ms === 90_000)!.fn();
    await flushAll();
    expect((await app.inject({ method: "GET", url: "/api/mail/domains", headers: auth })).json().domains[0].mtaSts).toBe("missing_txt");
  });
});
