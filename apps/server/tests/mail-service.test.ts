/**
 * mail-service.test.ts — removeDomain() e deleteMailbox() contra um
 * StalwartClient/Manager FAKE (mock de @paas/mailer): sem isso, exercitar o
 * MailService de verdade exigiria um Stalwart + Docker reais só para testar
 * lógica de orquestração local (persistência JSON, tolerância a falhas).
 *
 * Cobre dois bugs do review 2026-08-24:
 *  5) removeDomain silenciava falhas de deleteMailbox (.catch(() => undefined))
 *     — caixa podia ficar órfã VIVA no Stalwart sem registro local, e
 *     ninguém saberia. Agora a falha é logada (estruturada) e reportada no
 *     retorno, sem impedir a remoção do domínio de prosseguir.
 *  6) DELETE .../mailboxes/:id não gravava auditoria, diferente de
 *     criar domínio/caixa. Agora deleteMailbox aceita um sink de auditoria
 *     opcional (mesmo padrão de injeção de DeployService/AlertsService) e
 *     registra a remoção quando ele é fornecido.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, type Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

// -----------------------------------------------------------------------
// Fake do StalwartClient/Manager: sem rede, sem Docker. Os testes exercitam
// SÓ a lógica de orquestração do MailService (o que é responsabilidade dele).
// -----------------------------------------------------------------------
const deletedMailboxCalls: string[] = [];
const deletedDomainCalls: string[] = [];
let deleteMailboxImpl: (email: string) => Promise<void> = async () => undefined;
const passwordCalls: { email: string; password: string }[] = [];
const createdMailboxCalls: { email: string; password: string }[] = [];
const aliasCalls: string[] = [];
/** Ordem das chamadas que mexem em caixas/endereços no Stalwart. */
const order: string[] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return {
        installed: true,
        running: true,
        version: "0.11.8",
        image: "stalwartlabs/mail-server:v0.11.8",
        containerName: "paas-stalwart",
        hostname: "mail.test",
        ports: MAIL_DEFAULT_PORTS,
        message: null,
      };
    }
  }
  class FakeStalwartClient {
    async deleteDomain(domain: string) {
      deletedDomainCalls.push(domain);
    }
    async deleteMailbox(email: string) {
      deletedMailboxCalls.push(email);
      order.push(`delete ${email}`);
      await deleteMailboxImpl(email);
    }
    async setMailboxPassword(email: string, password: string) {
      passwordCalls.push({ email, password });
    }
    async createMailbox(email: string, password: string) {
      createdMailboxCalls.push({ email, password });
      order.push(`create ${email}`);
    }
    async addMailboxAlias(email: string, alias: string) {
      aliasCalls.push(`+ ${email} ${alias}`);
    }
    async removeMailboxAlias(email: string, alias: string) {
      aliasCalls.push(`- ${email} ${alias}`);
      order.push(`- alias ${alias}`);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let config: ServerConfig;

async function seedMailFile(domains: Record<string, unknown>, mailboxes: Record<string, unknown>) {
  const mailDir = path.join(dir, "mail");
  await mkdir(mailDir, { recursive: true });
  await writeFile(
    path.join(mailDir, "mail.json"),
    JSON.stringify({
      adminSecret: "secret-de-teste",
      hostname: "mail.test",
      domains,
      mailboxes,
      projects: {},
    }),
    "utf8",
  );
}

function domainFixture(name: string) {
  return {
    name,
    dkimSelector: "paas",
    dkimPublicKey: "x".repeat(120),
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: new Date(0).toISOString(),
  };
}

function mailboxFixture(email: string, domain: string, kind: "user" | "system", password = "senha-forte") {
  const [localPart] = email.split("@");
  return { id: email, localPart, domain, kind, createdAt: new Date(0).toISOString(), password };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-test-"));
  deletedMailboxCalls.length = 0;
  deletedDomainCalls.length = 0;
  passwordCalls.length = 0;
  createdMailboxCalls.length = 0;
  aliasCalls.length = 0;
  order.length = 0;
  deleteMailboxImpl = async () => undefined;
  config = {
    dataDir: dir,
    mailPorts: MAIL_DEFAULT_PORTS,
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
  } as unknown as ServerConfig;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MailService.removeDomain — falhas de deleteMailbox", () => {
  it("uma caixa falha ao remover no Stalwart: NÃO bloqueia a remoção do domínio, e a falha é logada + reportada", async () => {
    await seedMailFile(
      { "example.com": domainFixture("example.com") },
      {
        "postmaster@example.com": mailboxFixture("postmaster@example.com", "example.com", "system"),
        "a@example.com": mailboxFixture("a@example.com", "example.com", "user"),
        "b@example.com": mailboxFixture("b@example.com", "example.com", "user"),
      },
    );
    deleteMailboxImpl = async (email) => {
      if (email === "a@example.com") throw new Error("Stalwart indisponível");
    };
    const log = vi.fn();
    const service = new MailService(config, { log });

    const result = await service.removeDomain("example.com");

    // a falha NÃO impediu a tentativa nas outras caixas nem a remoção do domínio
    expect(deletedMailboxCalls.sort()).toEqual(
      ["a@example.com", "b@example.com", "postmaster@example.com"].sort(),
    );
    expect(deletedDomainCalls).toEqual(["example.com"]);

    // observável: logada de forma estruturada (não silenciada)...
    expect(log).toHaveBeenCalledTimes(1);
    const [msg, meta] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("a@example.com");
    expect(meta).toMatchObject({ domain: "example.com", mailbox: "a@example.com" });
    expect(String(meta.error)).toContain("Stalwart indisponível");

    // ...e reportada ao chamador
    expect(result.mailboxDeleteFailures).toEqual(["a@example.com"]);

    // estado local: domínio e as 3 caixas somem (mesmo a que falhou remotamente
    // — comportamento inalterado; o que muda é a falha deixar de ser muda)
    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as {
      domains: Record<string, unknown>;
      mailboxes: Record<string, unknown>;
    };
    expect(stored.domains["example.com"]).toBeUndefined();
    expect(Object.keys(stored.mailboxes)).toEqual([]);
  });

  it("sem falhas: nada é logado e mailboxDeleteFailures vem vazio", async () => {
    await seedMailFile(
      { "example.com": domainFixture("example.com") },
      { "a@example.com": mailboxFixture("a@example.com", "example.com", "user") },
    );
    const log = vi.fn();
    const service = new MailService(config, { log });

    const result = await service.removeDomain("example.com");

    expect(log).not.toHaveBeenCalled();
    expect(result.mailboxDeleteFailures).toEqual([]);
  });

  it("sem `log` injetado (produção hoje): não lança e usa o default (console.warn)", async () => {
    await seedMailFile(
      { "example.com": domainFixture("example.com") },
      { "a@example.com": mailboxFixture("a@example.com", "example.com", "user") },
    );
    deleteMailboxImpl = async () => {
      throw new Error("falha simulada");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new MailService(config);

    await expect(service.removeDomain("example.com")).resolves.toMatchObject({
      mailboxDeleteFailures: ["a@example.com"],
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("MailService.deleteMailbox — auditoria", () => {
  it("registra auditoria quando um sink é injetado (mesmo padrão de criar domínio/caixa)", async () => {
    await seedMailFile(
      { "example.com": domainFixture("example.com") },
      { "c@example.com": mailboxFixture("c@example.com", "example.com", "user") },
    );
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new MailService(config, { audit: { record } });

    await service.deleteMailbox("example.com", "c@example.com");

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      action: "mail.mailbox.delete",
      target: "c@example.com",
    });
    expect(String(record.mock.calls[0]?.[0]?.detail)).toContain("c@example.com");

    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as {
      mailboxes: Record<string, unknown>;
    };
    expect(stored.mailboxes["c@example.com"]).toBeUndefined();
  });

  it("sem sink injetado: remove a caixa normalmente (auditoria é best-effort/opcional)", async () => {
    await seedMailFile(
      { "example.com": domainFixture("example.com") },
      { "c@example.com": mailboxFixture("c@example.com", "example.com", "user") },
    );
    const service = new MailService(config);
    await expect(service.deleteMailbox("example.com", "c@example.com")).resolves.toBeUndefined();
  });
});

/**
 * Pedido do dono do produto (02/10/2026): a senha de uma caixa nunca aparece
 * na tela. A pessoa define a senha ao criar; se esqueceu, troca.
 */
describe("MailService — senha das caixas nunca volta", () => {
  async function storedPassword(email: string): Promise<string> {
    const raw = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
    return raw.mailboxes[email].password;
  }

  it("trocar senha: muda no servidor de e-mail e no que o painel guarda", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "vendas@exemplo.com": mailboxFixture("vendas@exemplo.com", "exemplo.com", "user"),
    });
    const svc = new MailService(config);
    const { mailbox, generatedPassword } = await svc.changeMailboxPassword("vendas%40exemplo.com", "nova-senha-forte-123");
    expect(mailbox).not.toHaveProperty("password");
    expect(generatedPassword).toBeUndefined();
    expect(passwordCalls).toEqual([{ email: "vendas@exemplo.com", password: "nova-senha-forte-123" }]);
    expect(await storedPassword("vendas@exemplo.com")).toBe("nova-senha-forte-123");
  });

  it("postmaster@ (sistema) também pode trocar: o e-mail de teste passa a usar a nova", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "postmaster@exemplo.com": mailboxFixture("postmaster@exemplo.com", "exemplo.com", "system"),
    });
    const svc = new MailService(config);
    await svc.changeMailboxPassword("postmaster@exemplo.com", "nova-senha-forte-123");
    expect(await storedPassword("postmaster@exemplo.com")).toBe("nova-senha-forte-123");
  });

  it("caixa de projeto: também troca (o projeto recebe a senha nova no próximo deploy)", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "loja@exemplo.com": { ...mailboxFixture("loja@exemplo.com", "exemplo.com", "user"), kind: "project" },
    });
    const svc = new MailService(config);
    const res = await svc.changeMailboxPassword("loja@exemplo.com", "nova-senha-forte-123");
    expect(res).toEqual({ mailbox: expect.objectContaining({ id: "loja@exemplo.com", kind: "project" }) });
    expect(passwordCalls).toEqual([{ email: "loja@exemplo.com", password: "nova-senha-forte-123" }]);
    expect(await storedPassword("loja@exemplo.com")).toBe("nova-senha-forte-123");
  });

  it("trocar com 'gerar senha forte': devolve a senha uma vez e grava a mesma", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "loja@exemplo.com": { ...mailboxFixture("loja@exemplo.com", "exemplo.com", "user"), kind: "project" },
    });
    const svc = new MailService(config);
    const res = await svc.changeMailboxPassword("loja@exemplo.com", undefined, { generate: true });
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{23}$/);
    expect(passwordCalls).toEqual([{ email: "loja@exemplo.com", password: res.generatedPassword }]);
    expect(await storedPassword("loja@exemplo.com")).toBe(res.generatedPassword);
    expect(JSON.stringify(res.mailbox)).not.toContain(res.generatedPassword!);
  });

  it("senha curta ou caixa inexistente: recusa", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "vendas@exemplo.com": mailboxFixture("vendas@exemplo.com", "exemplo.com", "user"),
    });
    const svc = new MailService(config);
    await expect(svc.changeMailboxPassword("vendas@exemplo.com", "curta")).rejects.toMatchObject({ code: "weak_password" });
    await expect(svc.changeMailboxPassword("nada@exemplo.com", "nova-senha-forte-123")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("configuração para cliente de e-mail não traz a senha", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "vendas@exemplo.com": mailboxFixture("vendas@exemplo.com", "exemplo.com", "user", "segredo-guardado"),
    });
    const creds = await new MailService(config).mailboxCredentials("vendas@exemplo.com");
    expect(JSON.stringify(creds)).not.toContain("segredo-guardado");
  });

  it("criar caixa exige a senha da pessoa (mínimo 12) e não a devolve", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {});
    const svc = new MailService(config);
    await expect(svc.createMailbox("exemplo.com", "vendas", "curta")).rejects.toMatchObject({ code: "weak_password" });
    const res = await svc.createMailbox("exemplo.com", "vendas", "senha-forte-da-pessoa");
    expect(res).not.toHaveProperty("password");
    expect(createdMailboxCalls).toEqual([{ email: "vendas@exemplo.com", password: "senha-forte-da-pessoa" }]);
  });
});

/**
 * Validação real do dono do produto (02/10/2026): ele criou "Contato -
 * Cassino <contato@...>" e não tinha como abrir essa caixa — o endereço de
 * envio era só um alias da caixa técnica, cuja senha nunca aparece. Agora o
 * endereço de envio É a caixa do projeto, com a senha que a pessoa digita
 * (ou que o painel gera e mostra uma única vez).
 */
describe("MailService — o endereço de envio é a caixa do projeto", () => {
  const project = { id: "p1", slug: "cassino", name: "Cassino Royal" } as unknown as Project;
  const SENHA = "senha-forte-da-pessoa";

  async function seedDomain(mailboxes: Record<string, unknown> = {}, projects: Record<string, unknown> = {}) {
    const mailDir = path.join(dir, "mail");
    await mkdir(mailDir, { recursive: true });
    await writeFile(
      path.join(mailDir, "mail.json"),
      JSON.stringify({
        adminSecret: "secret-de-teste",
        hostname: "mail.test",
        domains: { "exemplo.com": domainFixture("exemplo.com") },
        mailboxes,
        projects,
      }),
      "utf8",
    );
  }

  async function stored(): Promise<{ mailboxes: Record<string, { password: string; kind: string }>; projects: Record<string, Record<string, unknown>> }> {
    return JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
  }

  it("padrão: cria a caixa <slug>@ com a senha digitada; SMTP_USER e MAIL_FROM são ela, sem alias", async () => {
    await seedDomain();
    const svc = new MailService(config);
    const res = await svc.enableProjectEmail(project, "exemplo.com", { password: SENHA });
    expect(res.generatedPassword).toBeUndefined();
    expect(res.email).toMatchObject({ mailbox: "cassino@exemplo.com", mailFrom: "cassino@exemplo.com", fromName: "Cassino Royal" });
    expect(createdMailboxCalls).toEqual([{ email: "cassino@exemplo.com", password: SENHA }]);
    expect(aliasCalls).toEqual([]);
    expect(await svc.envForProject(project)).toEqual({
      SMTP_HOST: "mail.exemplo.com",
      SMTP_PORT: "587",
      SMTP_USER: "cassino@exemplo.com",
      SMTP_PASS: SENHA,
      MAIL_FROM: "cassino@exemplo.com",
      MAIL_FROM_NAME: "Cassino Royal",
    });
    expect(JSON.stringify(await svc.projectEmailConfig("p1"))).not.toContain(SENHA);
  });

  it("endereço escolhido + 'gerar senha forte': a caixa é contato@, a senha volta uma vez só", async () => {
    await seedDomain();
    const svc = new MailService(config);
    const res = await svc.enableProjectEmail(project, "exemplo.com", {
      fromLocalPart: "Contato",
      fromName: "Contato - Cassino",
      generatePassword: true,
    });
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{23}$/);
    expect(res.email).toMatchObject({ mailbox: "contato@exemplo.com", mailFrom: "contato@exemplo.com", fromName: "Contato - Cassino" });
    expect(createdMailboxCalls).toEqual([{ email: "contato@exemplo.com", password: res.generatedPassword }]);
    expect((await stored()).mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "project", password: res.generatedPassword });
    expect((await svc.envForProject(project)).SMTP_PASS).toBe(res.generatedPassword);
    expect(JSON.stringify(await svc.projectEmailConfig("p1"))).not.toContain(res.generatedPassword!);
  });

  it("caixa nova sem senha: 400 pedindo a senha; senha curta: weak_password", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await expect(svc.enableProjectEmail(project, "exemplo.com")).rejects.toMatchObject({ statusCode: 400, code: "password_required" });
    await expect(svc.enableProjectEmail(project, "exemplo.com", { password: "curta" })).rejects.toMatchObject({ code: "weak_password" });
    expect(createdMailboxCalls).toEqual([]);
  });

  it("mesmo endereço: só muda o nome, sem pedir senha; com senha nova, troca", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: SENHA });
    const res = await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", fromName: "Outro Nome" });
    expect(res.email.fromName).toBe("Outro Nome");
    expect(createdMailboxCalls).toHaveLength(1);
    expect(passwordCalls).toEqual([]);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: "outra-senha-forte-1" });
    expect(passwordCalls).toEqual([{ email: "contato@exemplo.com", password: "outra-senha-forte-1" }]);
  });

  it("trocar o endereço: cria a caixa nova e remove a antiga (nenhum outro projeto a usa)", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: SENHA });
    await expect(svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "vendas" })).rejects.toMatchObject({
      code: "password_required",
    });
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "vendas", password: "senha-da-vendas-1" });
    expect(order).toEqual(["create contato@exemplo.com", "create vendas@exemplo.com", "delete contato@exemplo.com"]);
    const file = await stored();
    expect(Object.keys(file.mailboxes)).toEqual(["vendas@exemplo.com"]);
    expect(file.projects.p1).toMatchObject({ mailbox: "vendas@exemplo.com" });
  });

  it("caixa antiga ainda usada por outro projeto: fica", async () => {
    await seedDomain(
      { "loja@exemplo.com": { ...mailboxFixture("loja@exemplo.com", "exemplo.com", "user"), kind: "project" } },
      {
        p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: "2026-10-01T00:00:00.000Z" },
        p2: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: "2026-10-01T00:00:00.000Z" },
      },
    );
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: SENHA });
    expect(deletedMailboxCalls).toEqual([]);
    expect(Object.keys((await stored()).mailboxes).sort()).toEqual(["contato@exemplo.com", "loja@exemplo.com"]);
  });

  it("falha ao remover a caixa antiga no servidor: registra no log e mantém a caixa na lista (dá para remover depois)", async () => {
    const logs: string[] = [];
    await seedDomain();
    const svc = new MailService(config, { log: (m) => logs.push(m) });
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: SENHA });
    deleteMailboxImpl = async () => {
      throw new Error("Stalwart fora");
    };
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "vendas", password: SENHA });
    expect(logs.join(" ")).toContain("contato@exemplo.com");
    expect(Object.keys((await stored()).mailboxes).sort()).toEqual(["contato@exemplo.com", "vendas@exemplo.com"]);
    expect((await svc.projectEmailConfig("p1")).mailbox).toBe("vendas@exemplo.com");
  });

  it("endereço de outra caixa, de outro projeto ou o abuse@: 409 address_in_use", async () => {
    await seedDomain(
      {
        "contato@exemplo.com": mailboxFixture("contato@exemplo.com", "exemplo.com", "user"),
        "loja@exemplo.com": { ...mailboxFixture("loja@exemplo.com", "exemplo.com", "user"), kind: "project" },
        "velha@exemplo.com": { ...mailboxFixture("velha@exemplo.com", "exemplo.com", "user"), kind: "project" },
      },
      {
        p2: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: "2026-10-01T00:00:00.000Z" },
        p3: { domain: "exemplo.com", mailbox: "velha@exemplo.com", fromAddress: "avisos@exemplo.com", enabledAt: "2026-10-01T00:00:00.000Z" },
      },
    );
    const svc = new MailService(config);
    for (const local of ["contato", "loja", "avisos", "abuse", "postmaster"]) {
      await expect(svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: local, password: SENHA })).rejects.toMatchObject({
        statusCode: 409,
        code: "address_in_use",
      });
    }
    expect(createdMailboxCalls).toEqual([]);
  });

  it("caixa de projeto sobrando (e-mail desativado antes): reaproveita, com a senha nova", async () => {
    await seedDomain({ "cassino@exemplo.com": { ...mailboxFixture("cassino@exemplo.com", "exemplo.com", "user"), kind: "project" } });
    const svc = new MailService(config);
    await expect(svc.enableProjectEmail(project, "exemplo.com")).rejects.toMatchObject({ code: "password_required" });
    await svc.enableProjectEmail(project, "exemplo.com", { password: SENHA });
    expect(createdMailboxCalls).toEqual([]);
    expect(passwordCalls).toEqual([{ email: "cassino@exemplo.com", password: SENHA }]);
  });

  it("desativar: a caixa e as mensagens ficam (dá para remover na página do domínio)", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: SENHA });
    await svc.disableProjectEmail("p1");
    expect(aliasCalls).toEqual([]);
    expect(deletedMailboxCalls).toEqual([]);
    expect(await svc.envForProject(project)).toEqual({});
    await expect(svc.deleteMailbox("exemplo.com", "contato@exemplo.com")).resolves.toBeUndefined();
  });

  it("caixa do projeto sumiu do registro: aparece como desativado", async () => {
    await seedDomain({}, { p1: { domain: "exemplo.com", mailbox: "x@exemplo.com", enabledAt: "2026-10-01T00:00:00.000Z" } });
    const svc = new MailService(config);
    expect((await svc.projectEmailConfig("p1")).enabled).toBe(false);
    expect(await svc.envForProject(project)).toEqual({});
  });
});

/**
 * Registros gravados em produção antes desta mudança: endereço de envio como
 * alias (fromAddress) da caixa técnica <slug>@. Continuam funcionando até a
 * pessoa salvar de novo; ao salvar, o alias sai e o modelo novo vale.
 */
describe("MailService — migração do endereço de envio antigo (alias)", () => {
  const project = { id: "p1", slug: "cassino", name: "Cassino Royal" } as unknown as Project;
  const LEGACY = {
    p1: {
      domain: "exemplo.com",
      mailbox: "cassino@exemplo.com",
      enabledAt: "2026-10-01T00:00:00.000Z",
      fromAddress: "contato@exemplo.com",
      fromName: "Contato - Cassino",
    },
  };

  async function seedLegacy() {
    const mailDir = path.join(dir, "mail");
    await mkdir(mailDir, { recursive: true });
    await writeFile(
      path.join(mailDir, "mail.json"),
      JSON.stringify({
        adminSecret: "secret-de-teste",
        hostname: "mail.test",
        domains: { "exemplo.com": domainFixture("exemplo.com") },
        mailboxes: {
          "cassino@exemplo.com": { ...mailboxFixture("cassino@exemplo.com", "exemplo.com", "user", "senha-tecnica"), kind: "project" },
        },
        projects: LEGACY,
      }),
      "utf8",
    );
  }

  it("antes de salvar: o projeto continua entrando com a caixa técnica e enviando como o alias", async () => {
    await seedLegacy();
    const svc = new MailService(config);
    expect(await svc.envForProject(project)).toMatchObject({
      SMTP_USER: "cassino@exemplo.com",
      SMTP_PASS: "senha-tecnica",
      MAIL_FROM: "contato@exemplo.com",
      MAIL_FROM_NAME: "Contato - Cassino",
    });
    expect(await svc.projectEmailConfig("p1")).toMatchObject({ mailbox: "cassino@exemplo.com", mailFrom: "contato@exemplo.com", legacyAlias: true });
  });

  it("ao salvar com o mesmo endereço: tira o alias ANTES de criar a caixa contato@ e remove a técnica", async () => {
    await seedLegacy();
    const svc = new MailService(config);
    await expect(svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato" })).rejects.toMatchObject({
      code: "password_required",
    });
    const res = await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", generatePassword: true });
    expect(order).toEqual(["- alias contato@exemplo.com", "create contato@exemplo.com", "delete cassino@exemplo.com"]);
    expect(res.email).toMatchObject({ mailbox: "contato@exemplo.com", mailFrom: "contato@exemplo.com", legacyAlias: false });
    const file = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
    expect(file.projects.p1).not.toHaveProperty("fromAddress");
    expect(Object.keys(file.mailboxes)).toEqual(["contato@exemplo.com"]);
    expect(await svc.envForProject(project)).toMatchObject({ SMTP_USER: "contato@exemplo.com", MAIL_FROM: "contato@exemplo.com" });
  });

  it("ao salvar voltando para a caixa técnica: só tira o alias (senha opcional)", async () => {
    await seedLegacy();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", {});
    expect(order).toEqual(["- alias contato@exemplo.com"]);
    expect(await svc.projectEmailConfig("p1")).toMatchObject({ mailbox: "cassino@exemplo.com", mailFrom: "cassino@exemplo.com" });
  });

  it("desativar um registro antigo tira o alias", async () => {
    await seedLegacy();
    const svc = new MailService(config);
    await svc.disableProjectEmail("p1");
    expect(aliasCalls).toEqual(["- cassino@exemplo.com contato@exemplo.com"]);
  });
});

/**
 * O app do projeto usa outros nomes (SMTP_SENHA, EMAIL_DE…). O painel guarda
 * só o mapeamento — nunca copia o valor — e entrega o valor atual no deploy:
 * a troca de senha chega sozinha no próximo deploy.
 */
describe("MailService — ligar valores do e-mail às variáveis do projeto", () => {
  const project = { id: "p1", slug: "cassino", name: "Cassino Royal" } as unknown as Project;

  async function enabled() {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {});
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", password: "senha-forte-da-pessoa" });
    return svc;
  }

  it("guarda o mapeamento e entrega o valor atual (a senha nova vale no deploy seguinte)", async () => {
    const svc = await enabled();
    const cfg = await svc.setProjectEmailLinks("p1", { SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM", NOME_DE: "MAIL_FROM_NAME" });
    expect(cfg.envLinks).toEqual({ SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM", NOME_DE: "MAIL_FROM_NAME" });
    expect(await svc.linkedEnvForProject(project)).toEqual({
      SMTP_SENHA: "senha-forte-da-pessoa",
      EMAIL_DE: "contato@exemplo.com",
      NOME_DE: "Cassino Royal",
    });
    await svc.changeMailboxPassword("contato@exemplo.com", "senha-nova-forte-1");
    expect((await svc.linkedEnvForProject(project)).SMTP_SENHA).toBe("senha-nova-forte-1");
    // a seção Variáveis mostra de onde vem cada ligada (só nomes)
    expect(await svc.envLinksForProject(project)).toEqual({ SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM", NOME_DE: "MAIL_FROM_NAME" });
    // o arquivo guarda o mapeamento, não uma cópia da senha no projeto
    const file = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
    expect(file.projects.p1.envLinks).toEqual({ SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM", NOME_DE: "MAIL_FROM_NAME" });
  });

  it("salvar o e-mail de novo mantém o mapeamento; vazio apaga", async () => {
    const svc = await enabled();
    await svc.setProjectEmailLinks("p1", { SMTP_SENHA: "SMTP_PASS" });
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato", fromName: "Outro" });
    expect((await svc.projectEmailConfig("p1")).envLinks).toEqual({ SMTP_SENHA: "SMTP_PASS" });
    expect((await svc.setProjectEmailLinks("p1", {})).envLinks).toEqual({});
    expect(await svc.linkedEnvForProject(project)).toEqual({});
  });

  it("nome inválido, reservado, valor desconhecido ou e-mail desativado: recusa", async () => {
    const svc = await enabled();
    await expect(svc.setProjectEmailLinks("p1", { "1X": "SMTP_PASS" })).rejects.toMatchObject({ statusCode: 400, code: "invalid_env_key" });
    await expect(svc.setProjectEmailLinks("p1", { COMPOSE_PROJECT_NAME: "SMTP_USER" })).rejects.toMatchObject({ code: "invalid_env_key" });
    await expect(svc.setProjectEmailLinks("p1", { SMTP_USER: "SMTP_PASS" })).rejects.toMatchObject({ code: "invalid_env_key" });
    await expect(
      svc.setProjectEmailLinks("p1", { SENHA: "ADMIN_SECRET" as unknown as "SMTP_PASS" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_env_link" });
    await expect(svc.setProjectEmailLinks("p2", { SENHA: "SMTP_PASS" })).rejects.toMatchObject({ statusCode: 409, code: "email_not_enabled" });
  });

  it("sem e-mail ativo, nada é entregue", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {});
    expect(await new MailService(config).linkedEnvForProject(project)).toEqual({});
    expect(await new MailService(config).envLinksForProject(project)).toEqual({});
  });

  it("ligação a um valor que não existe (MAIL_FROM_NAME sem nome) fica de fora", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {});
    const svc = new MailService(config);
    const semNome = { ...project, name: "" } as Project;
    await svc.enableProjectEmail(semNome, "exemplo.com", { fromLocalPart: "contato", password: "senha-forte-da-pessoa" });
    await svc.setProjectEmailLinks("p1", { NOME_DE: "MAIL_FROM_NAME", SMTP_SENHA: "SMTP_PASS" });
    expect(await svc.envLinksForProject(semNome)).toEqual({ SMTP_SENHA: "SMTP_PASS" });
  });
});
