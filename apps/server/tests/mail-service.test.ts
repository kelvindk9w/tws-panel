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
      await deleteMailboxImpl(email);
    }
    async setMailboxPassword(email: string, password: string) {
      passwordCalls.push({ email, password });
    }
    async createMailbox(email: string, password: string) {
      createdMailboxCalls.push({ email, password });
    }
    async addMailboxAlias(email: string, alias: string) {
      aliasCalls.push(`+ ${email} ${alias}`);
    }
    async removeMailboxAlias(email: string, alias: string) {
      aliasCalls.push(`- ${email} ${alias}`);
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
    const mailbox = await svc.changeMailboxPassword("vendas%40exemplo.com", "nova-senha-forte-123");
    expect(mailbox).not.toHaveProperty("password");
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

  it("caixa técnica de projeto: recusa (o painel gerencia e entrega ao projeto)", async () => {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, {
      "loja@exemplo.com": { ...mailboxFixture("loja@exemplo.com", "exemplo.com", "user"), kind: "project" },
    });
    const svc = new MailService(config);
    await expect(svc.changeMailboxPassword("loja@exemplo.com", "nova-senha-forte-123")).rejects.toMatchObject({
      statusCode: 409,
      code: "mailbox_managed",
    });
    expect(passwordCalls).toEqual([]);
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
 * Pedido do dono do produto (02/10/2026): cada projeto escolhe o endereço de
 * envio (ex.: nao-responda@) e o nome que aparece para quem recebe.
 */
describe("MailService — remetente do projeto", () => {
  const project = { id: "p1", slug: "cassino", name: "Cassino Royal" } as unknown as Project;

  async function seedDomain(extra: Record<string, unknown> = {}) {
    await seedMailFile({ "exemplo.com": domainFixture("exemplo.com") }, extra);
  }

  it("padrão: envia como a caixa técnica, com o nome do projeto", async () => {
    await seedDomain();
    const svc = new MailService(config);
    const cfg = await svc.enableProjectEmail(project, "exemplo.com");
    expect(cfg).toMatchObject({ mailbox: "cassino@exemplo.com", mailFrom: "cassino@exemplo.com", fromName: "Cassino Royal" });
    expect(aliasCalls).toEqual([]);
    const env = await svc.envForProject(project);
    expect(env).toMatchObject({ SMTP_USER: "cassino@exemplo.com", MAIL_FROM: "cassino@exemplo.com", MAIL_FROM_NAME: "Cassino Royal" });
  });

  it("endereço escolhido vira endereço extra da caixa técnica; o projeto entra com a caixa e envia como ele", async () => {
    await seedDomain();
    const svc = new MailService(config);
    const cfg = await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "Nao-Responda", fromName: "Cassino" });
    expect(cfg).toMatchObject({ mailbox: "cassino@exemplo.com", mailFrom: "nao-responda@exemplo.com", fromName: "Cassino" });
    expect(aliasCalls).toEqual(["+ cassino@exemplo.com nao-responda@exemplo.com"]);
    expect(await svc.envForProject(project)).toMatchObject({
      SMTP_USER: "cassino@exemplo.com",
      MAIL_FROM: "nao-responda@exemplo.com",
      MAIL_FROM_NAME: "Cassino",
    });
  });

  it("trocar o endereço tira o antigo da caixa; voltar ao padrão também", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "nao-responda" });
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "avisos" });
    await svc.enableProjectEmail(project, "exemplo.com", {});
    expect(aliasCalls).toEqual([
      "+ cassino@exemplo.com nao-responda@exemplo.com",
      "- cassino@exemplo.com nao-responda@exemplo.com",
      "+ cassino@exemplo.com avisos@exemplo.com",
      "- cassino@exemplo.com avisos@exemplo.com",
    ]);
    expect((await svc.projectEmailConfig("p1")).mailFrom).toBe("cassino@exemplo.com");
  });

  it("endereço que já é de outra caixa: recusa (409)", async () => {
    await seedDomain({ "contato@exemplo.com": mailboxFixture("contato@exemplo.com", "exemplo.com", "user") });
    const svc = new MailService(config);
    await expect(svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "contato" })).rejects.toMatchObject({
      statusCode: 409,
      code: "address_in_use",
    });
  });

  it("desativar tira o endereço extra da caixa", async () => {
    await seedDomain();
    const svc = new MailService(config);
    await svc.enableProjectEmail(project, "exemplo.com", { fromLocalPart: "nao-responda" });
    await svc.disableProjectEmail("p1");
    expect(aliasCalls.at(-1)).toBe("- cassino@exemplo.com nao-responda@exemplo.com");
    expect(await svc.envForProject(project)).toEqual({});
  });
});
