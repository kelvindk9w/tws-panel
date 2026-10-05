/**
 * O que o webmail precisa saber do servidor de e-mail (MailService): por qual
 * nome falar com o Stalwart na paas-net, se o certificado desse nome já está
 * instalado (para conferir pelo nome) e a isenção do IP do webmail no
 * bloqueio automático do Stalwart.
 *
 * Sem Docker: StalwartManager/Client são dublês.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

let running = true;
const clientCalls: unknown[][] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return { running };
    }
  }
  class FakeStalwartClient {
    async exemptIp(ip: string, previous: string | null) {
      clientCalls.push(["exemptIp", ip, previous]);
    }
    async removeIpExemption(ip: string) {
      clientCalls.push(["removeIpExemption", ip]);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir: string;

function config(extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir: dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    panelDomain: null,
    ...extra,
  } as unknown as ServerConfig;
}

async function writeMail(data: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({ adminSecret: "s", hostname: null, domains: {}, mailboxes: {}, projects: {}, tls: null, ...data }),
  );
}

const domain = (name: string) => ({ name, dkimSelector: "paas", dkimPublicKey: "x", dkimKeyBits: 2048, dmarcStage: "none", createdAt: "", lastVerify: null });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-webmail-"));
  running = true;
  clientCalls.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MailService.webmailBackend", () => {
  it("nome do servidor com certificado instalado: confere pelo nome", async () => {
    await writeMail({
      domains: { "exemplo.com": domain("exemplo.com"), "outro.com.br": domain("outro.com.br") },
      tls: { hostname: "mail.exemplo.com", aliases: [], certificates: { "mail.exemplo.com": "fp" } },
    });
    const backend = await new MailService(config(), { inContainer: true }).webmailBackend();
    expect(backend).toEqual({
      serverRunning: true,
      imapHost: "mail.exemplo.com",
      verifyTls: true,
      hosts: ["mail.exemplo.com", "mail.outro.com.br"],
      domains: [
        { domain: "exemplo.com", host: "mail.exemplo.com" },
        { domain: "outro.com.br", host: "mail.outro.com.br" },
      ],
      identities: {},
    });
  });

  /**
   * Pedido do dono do produto (04/10/2026): e-mail enviado pelo webmail a
   * partir da caixa do projeto saía sem nome. O webmail recebe o nome de
   * exibição do e-mail do projeto para cada caixa de projeto.
   */
  it("nome de exibição de cada caixa de projeto (registro antigo sem nome fica de fora)", async () => {
    await writeMail({
      domains: { "exemplo.com": domain("exemplo.com") },
      projects: {
        p1: { domain: "exemplo.com", mailbox: "contato@exemplo.com", enabledAt: "", fromName: "Contato - Loja" },
        p2: { domain: "exemplo.com", mailbox: "loja2@exemplo.com", enabledAt: "", fromAddress: "vendas@exemplo.com" },
        p3: { domain: "exemplo.com", mailbox: "Suporte@Exemplo.com", enabledAt: "", fromName: "Suporte" },
      },
    });
    const backend = await new MailService(config()).webmailBackend();
    expect(backend.identities).toEqual({ "contato@exemplo.com": "Contato - Loja", "suporte@exemplo.com": "Suporte" });
  });

  it("só outro nome com certificado: fala por ele (o Stalwart escolhe pelo SNI)", async () => {
    await writeMail({
      domains: { "exemplo.com": domain("exemplo.com"), "outro.com.br": domain("outro.com.br") },
      tls: { hostname: "mail.exemplo.com", aliases: [], certificates: { "mail.outro.com.br": "fp" } },
    });
    const backend = await new MailService(config()).webmailBackend();
    expect(backend.imapHost).toBe("mail.outro.com.br");
    expect(backend.verifyTls).toBe(true);
  });

  it("nenhum certificado ainda: o nome do servidor, sem conferir", async () => {
    await writeMail({ domains: { "exemplo.com": domain("exemplo.com") } });
    const backend = await new MailService(config()).webmailBackend();
    expect(backend.imapHost).toBe("mail.exemplo.com");
    expect(backend.verifyTls).toBe(false);
  });

  it("servidor parado ou nunca iniciado", async () => {
    running = false;
    await writeMail({ domains: { "exemplo.com": domain("exemplo.com") } });
    expect((await new MailService(config()).webmailBackend()).serverRunning).toBe(false);
    await writeMail({ adminSecret: null });
    const never = await new MailService(config()).webmailBackend();
    expect(never.serverRunning).toBe(false);
    expect(never.domains).toEqual([]);
  });
});

describe("MailService — isenção do IP do webmail", () => {
  it("repassa ao Stalwart", async () => {
    await writeMail({});
    const service = new MailService(config());
    await service.exemptWebmailIp("172.18.0.9", "172.18.0.4");
    await service.removeWebmailIpExemption("172.18.0.9");
    expect(clientCalls).toEqual([
      ["exemptIp", "172.18.0.9", "172.18.0.4"],
      ["removeIpExemption", "172.18.0.9"],
    ]);
  });
});
