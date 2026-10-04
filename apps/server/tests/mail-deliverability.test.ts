/**
 * mail-deliverability.test.ts — primeira leva de entregabilidade (04/10/2026).
 *
 *  - PTR único: o checklist de cada domínio espera o nome com que o servidor
 *    se apresenta (HELO), não mail.<domínio> de cada um;
 *  - DMARC: o rua=mailto:dmarc@<domínio> apontava para uma caixa que não
 *    existia. dmarc@ vira endereço extra da postmaster@ — no cadastro e,
 *    para domínios antigos, na sincronização seguinte (uma vez só);
 *  - report.domain = domínio de e-mail cadastrado (o do hostname);
 *  - configuração nova do Stalwart chega a servidores já instalados: a
 *    sincronização reinicia uma vez quando o config.toml gerado mudou.
 *
 * Sem Docker e sem DNS: StalwartManager/Client são dublês.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { MailCertificate } from "@paas/mailer";
import type { ServerConfig } from "../src/config.js";

interface ManagerCall {
  opts: Record<string, unknown>;
  method: string;
  arg?: unknown;
}
const managerCalls: ManagerCall[] = [];
const clientCalls: string[] = [];
/** Endereços de cada caixa no Stalwart de mentira. */
const emailsOf: Record<string, string[]> = {};
let clientFails = false;

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(private readonly opts: Record<string, unknown>) {}
    async status() {
      return {
        installed: true,
        running: true,
        version: "0.11.8",
        image: "stalwartlabs/mail-server:v0.11.8",
        containerName: "paas-stalwart",
        hostname: this.opts.hostname,
        ports: MAIL_DEFAULT_PORTS,
        message: null,
      };
    }
    async start() {
      managerCalls.push({ opts: this.opts, method: "start" });
    }
    async waitReady() {}
    async connectContainer() {}
    async applyTls(arg: { restart: boolean }) {
      managerCalls.push({ opts: this.opts, method: "applyTls", arg });
      return arg.restart ? "restarted" : "reloaded";
    }
  }
  class FakeStalwartClient {
    async createDomain(d: string) {
      clientCalls.push(`domain ${d}`);
    }
    async createDkimSignature() {
      return "sig";
    }
    async getDkimPublicKey() {
      return "x".repeat(120);
    }
    async createMailbox(email: string, _password: string, extra: string[] = []) {
      clientCalls.push(`mailbox ${email} [${extra.join(",")}]`);
      emailsOf[email] = [email, ...extra];
    }
    async mailboxEmails(email: string) {
      clientCalls.push(`emails ${email}`);
      if (clientFails) throw new Error("Sem conexão com o Stalwart");
      return emailsOf[email] ?? [];
    }
    async addMailboxAlias(email: string, alias: string) {
      clientCalls.push(`alias ${email} + ${alias}`);
      emailsOf[email] = [...(emailsOf[email] ?? []), alias];
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");
const { stalwartConfigFingerprint } = await import("@paas/mailer");

let dir = "";
let config: ServerConfig;

async function seed(data: Record<string, unknown>) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({ adminSecret: "s", hostname: null, domains: {}, mailboxes: {}, projects: {}, ...data }),
  );
}

async function stored() {
  return JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
}

function domain(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    dkimSelector: "paas",
    dkimPublicKey: "x".repeat(120),
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: new Date(0).toISOString(),
    lastVerify: null,
    ...extra,
  };
}

function postmaster(d: string) {
  return {
    id: `postmaster@${d}`,
    localPart: "postmaster",
    domain: d,
    kind: "system",
    createdAt: new Date(0).toISOString(),
    password: "p",
  };
}

const noMx = {
  resolve4: async () => [],
  resolve6: async () => [],
  resolveTxt: async () => [],
  reverse: async () => [],
  resolveMx: async () => {
    throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
  },
};

const service = (extra: Partial<ServerConfig> = {}) =>
  new MailService({ ...config, ...extra } as ServerConfig, {
    inContainer: false,
    readCertificate: async () => null,
    resolver: noMx,
    log: () => {},
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-deliv-"));
  managerCalls.length = 0;
  clientCalls.length = 0;
  for (const k of Object.keys(emailsOf)) delete emailsOf[k];
  clientFails = false;
  config = {
    dataDir: dir,
    mailPorts: MAIL_DEFAULT_PORTS,
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PTR único para o servidor inteiro", () => {
  it("o segundo domínio espera o PTR do nome do servidor (mail.<1º domínio>), não mail.<ele mesmo>", async () => {
    await seed({ domains: { "a.com": domain("a.com"), "b.com": domain("b.com") } });
    const s = service();
    const b = await s.dnsChecklist("b.com");
    expect(b.ptr.expected).toBe("mail.a.com");
    expect(b.mailHostname).toBe("mail.b.com");
    expect((await s.dnsChecklist("a.com")).ptr.expected).toBe("mail.a.com");
  });

  it("com PAAS_MAIL_HOSTNAME, é ele o PTR esperado em todos os domínios", async () => {
    await seed({ domains: { "a.com": domain("a.com"), "b.com": domain("b.com") } });
    const s = service({ mailHostname: "smtp.provedor.com" });
    expect((await s.dnsChecklist("a.com")).ptr.expected).toBe("smtp.provedor.com");
    expect((await s.dnsChecklist("b.com")).ptr.expected).toBe("smtp.provedor.com");
  });
});

describe("DMARC: relatórios chegam à postmaster@ pelo endereço dmarc@", () => {
  it("cadastro novo: postmaster@ já nasce com abuse@ e dmarc@", async () => {
    await seed({});
    await service().addDomain("exemplo.com.br");
    expect(clientCalls).toContain("mailbox postmaster@exemplo.com.br [abuse@exemplo.com.br,dmarc@exemplo.com.br]");
    expect((await stored()).domains["exemplo.com.br"].dmarcAlias).toBe(true);
  });

  it("domínio antigo: a sincronização acrescenta dmarc@ à postmaster@, uma vez só", async () => {
    await seed({ domains: { "a.com": domain("a.com") }, mailboxes: { "postmaster@a.com": postmaster("a.com") } });
    emailsOf["postmaster@a.com"] = ["postmaster@a.com", "abuse@a.com"];
    const s = service();
    await s.syncTls();
    expect(clientCalls).toEqual(["emails postmaster@a.com", "alias postmaster@a.com + dmarc@a.com"]);
    expect((await stored()).domains["a.com"].dmarcAlias).toBe(true);

    clientCalls.length = 0;
    await s.syncTls();
    await service().syncTls();
    expect(clientCalls).toEqual([]);
  });

  it("já tem o dmarc@ (acrescentado à mão): só marca, sem mexer", async () => {
    await seed({ domains: { "a.com": domain("a.com") }, mailboxes: { "postmaster@a.com": postmaster("a.com") } });
    emailsOf["postmaster@a.com"] = ["postmaster@a.com", "DMARC@a.com".toLowerCase()];
    await service().syncTls();
    expect(clientCalls).toEqual(["emails postmaster@a.com"]);
    expect((await stored()).domains["a.com"].dmarcAlias).toBe(true);
  });

  it("dmarc@ já é uma caixa própria: os relatórios já chegam nela; não mexe", async () => {
    await seed({
      domains: { "a.com": domain("a.com") },
      mailboxes: {
        "postmaster@a.com": postmaster("a.com"),
        "dmarc@a.com": { ...postmaster("a.com"), id: "dmarc@a.com", localPart: "dmarc", kind: "user" },
      },
    });
    await service().syncTls();
    expect(clientCalls).toEqual([]);
    expect((await stored()).domains["a.com"].dmarcAlias).toBe(true);
  });

  it("Stalwart não respondeu: a sincronização segue e tenta de novo na próxima", async () => {
    await seed({ domains: { "a.com": domain("a.com") }, mailboxes: { "postmaster@a.com": postmaster("a.com") } });
    clientFails = true;
    const s = service();
    await expect(s.syncTls()).resolves.toBeDefined();
    expect((await stored()).domains["a.com"].dmarcAlias).toBeUndefined();
    clientFails = false;
    clientCalls.length = 0;
    await s.syncTls();
    expect(clientCalls).toContain("alias postmaster@a.com + dmarc@a.com");
  });

  it("dmarc@ fica reservado: não vira caixa nem endereço de projeto", async () => {
    await seed({ domains: { "a.com": domain("a.com", { dmarcAlias: true }) } });
    await expect(service().createMailbox("a.com", "dmarc", "senha-bem-forte-123")).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("report.domain e configuração nova em servidor já instalado", () => {
  it("report.domain = domínio do hostname (mail.envio.exemplo.com.br → envio.exemplo.com.br)", async () => {
    await seed({ domains: { "envio.exemplo.com.br": domain("envio.exemplo.com.br", { dmarcAlias: true }) } });
    await service().startServer();
    expect(managerCalls.find((c) => c.method === "start")!.opts.reportDomain).toBe("envio.exemplo.com.br");
  });

  it("PAAS_MAIL_HOSTNAME dentro de um domínio cadastrado: o mais específico; fora de todos: o 1º domínio", async () => {
    await seed({
      domains: {
        "b.com": domain("b.com", { dmarcAlias: true }),
        "a.com": domain("a.com", { dmarcAlias: true }),
        "x.a.com": domain("x.a.com", { dmarcAlias: true }),
      },
    });
    await service({ mailHostname: "mail.x.a.com" }).startServer();
    expect(managerCalls.at(-1)!.opts.reportDomain).toBe("x.a.com");
    await service({ mailHostname: "smtp.provedor.net" }).startServer();
    expect(managerCalls.at(-1)!.opts.reportDomain).toBe("b.com");
  });

  it("sem domínio cadastrado: não define (vale o padrão do Stalwart)", async () => {
    await seed({ adminSecret: null });
    await service().startServer();
    expect(managerCalls.find((c) => c.method === "start")!.opts.reportDomain).toBeNull();
  });

  it("painel atualizado com o servidor rodando e a configuração gerada mudou: reinicia uma vez e para", async () => {
    // Estado aplicado gravado por uma versão anterior do painel (sem config).
    await seed({
      domains: { "a.com": domain("a.com", { dmarcAlias: true }) },
      tls: { hostname: "mail.a.com", aliases: ["mail.a.com"], certificates: {} },
    });
    const s = service();
    expect(await s.syncTls()).toBe("restarted");
    expect(managerCalls.find((c) => c.method === "applyTls")!.arg).toEqual({ restart: true });
    expect((await stored()).tls.config).toBe(
      stalwartConfigFingerprint({ hostname: "mail.a.com", certificateHosts: [], reportDomain: "a.com" }),
    );
    managerCalls.length = 0;
    expect(await s.syncTls()).toBe("none");
    expect(managerCalls).toEqual([]);
  });

  it("o mail.json guarda só a impressão digital da configuração, nunca o segredo", async () => {
    await seed({ adminSecret: "segredo-do-admin", domains: { "a.com": domain("a.com", { dmarcAlias: true }) } });
    await service().syncTls();
    const tls = JSON.stringify((await stored()).tls);
    expect(tls).not.toContain("segredo-do-admin");
    expect(tls).toMatch(/"config":"[0-9a-f]{64}"/);
  });
});

describe("certificado: compatível com o que já existia", () => {
  it("iniciado do zero, a sincronização seguinte não reinicia à toa (a configuração aplicada fica gravada)", async () => {
    await seed({ domains: { "a.com": domain("a.com", { dmarcAlias: true }) } });
    const cert: MailCertificate = {
      host: "mail.a.com",
      cert: "C",
      key: "K",
      fingerprint: "AA",
      issuer: "LE",
      validTo: "2026-12-30T00:00:00.000Z",
    };
    const s = new MailService(config, { inContainer: false, readCertificate: async () => cert, log: () => {} });
    // status() do dublê diz "rodando": startServer não grava o estado. Simula o
    // caminho do zero gravando o estado pelo primeiro sync.
    expect(await s.syncTls()).toBe("restarted");
    expect(await s.syncTls()).toBe("none");
  });
});
