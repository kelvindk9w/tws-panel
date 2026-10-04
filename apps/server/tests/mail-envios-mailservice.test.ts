/**
 * Métodos do MailService usados só pela página Envios: fila (listar, tentar
 * agora, cancelar), quem é o remetente (caixa e projeto), o que conferir nas
 * listas de bloqueio e os fatos da nota de entregabilidade.
 * Sem Docker e sem rede: o cliente e o gerenciador do Stalwart são dublês.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, type DnsVerifyResponse, type MailTlsStatusResponse } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

const calls: string[] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return { installed: true, running: true, ports: MAIL_DEFAULT_PORTS };
    }
    async connectContainer() {}
  }
  class FakeStalwartClient {
    async listQueue(limit: number) {
      calls.push(`list:${limit}`);
      return { items: [], total: 0 };
    }
    async retryQueuedMessage(id: string) {
      calls.push(`retry:${id}`);
      return true;
    }
    async cancelQueuedMessage(id: string) {
      calls.push(`cancel:${id}`);
      return true;
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

const DOMAIN = "envio.exemplo.com.br";
let dir = "";
let config: ServerConfig;

function mailbox(id: string, kind: string, extra: Record<string, unknown> = {}) {
  const [localPart, domain] = id.split("@");
  return { id, localPart, domain, kind, createdAt: new Date(0).toISOString(), password: "x", ...extra };
}

async function seed(data: Record<string, unknown>) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify(data));
}

const DOMAINS = {
  [DOMAIN]: {
    name: DOMAIN,
    dkimSelector: "paas",
    dkimPublicKey: "x".repeat(120),
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: new Date(0).toISOString(),
    lastVerify: null,
  },
};

beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(path.join(tmpdir(), "paas-envios-mail-"));
  config = {
    dataDir: dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service() {
  return new MailService(config, { inContainer: false, log: () => {} });
}

describe("MailService — página Envios", () => {
  it("enviosServerCreated: só depois de iniciar o servidor", async () => {
    await seed({ adminSecret: null, domains: {}, mailboxes: {}, projects: {} });
    expect(await service().enviosServerCreated()).toBe(false);
    await seed({ adminSecret: "s", domains: {}, mailboxes: {}, projects: {} });
    expect(await service().enviosServerCreated()).toBe(true);
  });

  it("fila: lista, tenta agora e cancela pelo cliente do Stalwart", async () => {
    await seed({ adminSecret: "s", domains: DOMAINS, mailboxes: {}, projects: {} });
    const s = service();
    expect(await s.enviosQueue(50)).toEqual({ items: [], total: 0 });
    expect(await s.enviosRetry("123")).toBe(true);
    expect(await s.enviosCancel("456")).toBe(true);
    expect(calls).toEqual(["list:50", "retry:123", "cancel:456"]);
  });

  it("fila sem servidor criado: erro 409 explicando", async () => {
    await seed({ adminSecret: null, domains: {}, mailboxes: {}, projects: {} });
    await expect(service().enviosQueue()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("remetentes: caixa do projeto, caixa avulsa, sistema (com abuse@/dmarc@) e o alias antigo de projeto", async () => {
    await seed({
      adminSecret: "s",
      domains: DOMAINS,
      mailboxes: {
        [`postmaster@${DOMAIN}`]: mailbox(`postmaster@${DOMAIN}`, "system"),
        [`loja@${DOMAIN}`]: mailbox(`loja@${DOMAIN}`, "project"),
        [`vendas@${DOMAIN}`]: mailbox(`vendas@${DOMAIN}`, "user", { projectId: "p2" }),
        [`contato@${DOMAIN}`]: mailbox(`contato@${DOMAIN}`, "user"),
      },
      projects: {
        p1: { domain: DOMAIN, mailbox: `loja@${DOMAIN}`, enabledAt: "x", fromAddress: `nao-responda@${DOMAIN}` },
      },
    });
    const senders = await service().enviosSenders();
    const by = Object.fromEntries(senders.map((s) => [s.address, s]));
    expect(by[`loja@${DOMAIN}`]).toEqual({ address: `loja@${DOMAIN}`, mailbox: `loja@${DOMAIN}`, projectId: "p1", system: false });
    expect(by[`nao-responda@${DOMAIN}`]).toEqual({ address: `nao-responda@${DOMAIN}`, mailbox: `loja@${DOMAIN}`, projectId: "p1", system: false });
    expect(by[`vendas@${DOMAIN}`]).toMatchObject({ projectId: "p2", system: false });
    expect(by[`contato@${DOMAIN}`]).toMatchObject({ projectId: null, system: false });
    expect(by[`postmaster@${DOMAIN}`]).toMatchObject({ system: true, mailbox: `postmaster@${DOMAIN}` });
    expect(by[`abuse@${DOMAIN}`]).toMatchObject({ system: true, mailbox: `postmaster@${DOMAIN}` });
    expect(by[`dmarc@${DOMAIN}`]).toMatchObject({ system: true, mailbox: `postmaster@${DOMAIN}` });
  });

  it("listas de bloqueio: o IP do servidor e cada domínio", async () => {
    await seed({ adminSecret: "s", domains: DOMAINS, mailboxes: {}, projects: {} });
    expect(await service().enviosBlacklistTargets()).toEqual({ ip: "203.0.113.10", domains: [DOMAIN] });
  });

  it("fatos da nota: DNS e PTR de cada domínio e o certificado", async () => {
    await seed({ adminSecret: "s", domains: DOMAINS, mailboxes: {}, projects: {} });
    const s = service();
    vi.spyOn(s, "verifyDomain").mockResolvedValue({
      summary: { ok: 6, total: 6 },
      ptr: { status: "generic" },
    } as unknown as DnsVerifyResponse);
    vi.spyOn(s, "tlsStatus").mockResolvedValue({
      checkedAt: "x",
      serverRunning: true,
      hosts: [{ ok: true }, { ok: false }],
      syncError: null,
    } as unknown as MailTlsStatusResponse);
    expect(await s.enviosDeliverabilityFacts()).toEqual({
      domains: [{ name: DOMAIN, dnsOk: 6, dnsTotal: 6, ptr: "generic" }],
      tls: { ok: 1, total: 2 },
    });
  });

  it("fatos da nota: falha na verificação vira 'não verificado', não erro", async () => {
    await seed({ adminSecret: "s", domains: DOMAINS, mailboxes: {}, projects: {} });
    const s = service();
    vi.spyOn(s, "verifyDomain").mockRejectedValue(new Error("DNS fora"));
    vi.spyOn(s, "tlsStatus").mockRejectedValue(new Error("docker fora"));
    expect(await s.enviosDeliverabilityFacts()).toEqual({
      domains: [{ name: DOMAIN, dnsOk: null, dnsTotal: null, ptr: null }],
      tls: null,
    });
  });
});
