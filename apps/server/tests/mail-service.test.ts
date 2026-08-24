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
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

// -----------------------------------------------------------------------
// Fake do StalwartClient/Manager: sem rede, sem Docker. Os testes exercitam
// SÓ a lógica de orquestração do MailService (o que é responsabilidade dele).
// -----------------------------------------------------------------------
const deletedMailboxCalls: string[] = [];
const deletedDomainCalls: string[] = [];
let deleteMailboxImpl: (email: string) => Promise<void> = async () => undefined;

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
