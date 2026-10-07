/**
 * mail-system-send.test.ts — avisos do painel por e-mail (notificações),
 * enviados pelo servidor de e-mail do próprio painel a partir da caixa
 * postmaster@ de um domínio com o DNS conferido.
 *
 * Sem Docker e sem rede: StalwartManager é dublê; o envio SMTP é injetado.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import { SmtpSendError, type SmtpSendOptions } from "@paas/mailer";
import type { ServerConfig } from "../src/config.js";

let running: boolean | Error = true;

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      if (running instanceof Error) throw running;
      return { installed: true, running, ports: MAIL_DEFAULT_PORTS };
    }
    async connectContainer() {
      // em container o painel se liga à paas-net antes de falar com o Stalwart
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

const A = "envio.exemplo.com.br";
const B = "outro.exemplo.com.br";
let dir = "";
let config: ServerConfig;
let sent: SmtpSendOptions[] = [];
let sendImpl: () => Promise<{ response: string; dsn: boolean }>;

function domain(name: string, lastVerify: unknown) {
  return {
    name,
    dkimSelector: "paas",
    dkimPublicKey: "x".repeat(120),
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: new Date(0).toISOString(),
    lastVerify,
  };
}

function postmaster(d: string) {
  return {
    id: `postmaster@${d}`,
    localPart: "postmaster",
    domain: d,
    kind: "system",
    createdAt: new Date(0).toISOString(),
    password: "senha-do-postmaster",
  };
}

const OK = { at: "2026-10-01T00:00:00Z", ok: 5, total: 5, recordsOk: true };
const BAD = { at: "2026-10-01T00:00:00Z", ok: 2, total: 5, recordsOk: false };

async function seed(data: { domains: Record<string, unknown>; mailboxes: Record<string, unknown> } | null) {
  if (!data) return;
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({ adminSecret: "s", hostname: null, projects: {}, ...data }),
  );
}

function service(inContainer = true) {
  return new MailService(config, {
    inContainer,
    log: () => undefined,
    sendMail: async (o) => {
      sent.push(o);
      return sendImpl();
    },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-system-"));
  config = {
    dataDir: dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS, submissions: 4650 },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
  sent = [];
  running = true;
  sendImpl = async () => ({ response: "250 2.0.0 Message queued for delivery.", dsn: false });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("systemMailReadiness", () => {
  it("servidor nunca iniciado: explica", async () => {
    const r = await service().systemMailReadiness();
    expect(r).toMatchObject({ ready: false, from: null });
    expect(r.reason).toMatch(/não foi iniciado/);
  });

  it("servidor parado ou sem resposta: explica", async () => {
    await seed({ domains: { [A]: domain(A, OK) }, mailboxes: { [`postmaster@${A}`]: postmaster(A) } });
    running = false;
    expect((await service().systemMailReadiness()).reason).toMatch(/parado/);
    running = new Error("docker fora");
    expect((await service().systemMailReadiness()).reason).toMatch(/conferir/);
  });

  it("sem domínio, ou sem domínio com o DNS conferido: explica", async () => {
    await seed({ domains: {}, mailboxes: {} });
    expect((await service().systemMailReadiness()).reason).toMatch(/domínio/);
    await seed({ domains: { [A]: domain(A, BAD), [B]: domain(B, null) }, mailboxes: { [`postmaster@${A}`]: postmaster(A) } });
    expect((await service().systemMailReadiness()).reason).toMatch(/DNS/);
  });

  it("pronto: sai da postmaster@ do primeiro domínio com o DNS certo e caixa registrada", async () => {
    await seed({
      domains: { [B]: domain(B, OK), [A]: domain(A, OK) },
      mailboxes: { [`postmaster@${A}`]: postmaster(A) },
    });
    expect(await service().systemMailReadiness()).toEqual({ ready: true, reason: null, from: `postmaster@${A}` });
  });
});

describe("sendSystemMail", () => {
  beforeEach(async () => {
    await seed({ domains: { [A]: domain(A, OK) }, mailboxes: { [`postmaster@${A}`]: postmaster(A) } });
  });

  it("envia pela submission (paas-net), sem pedir aviso de entrega, com texto e HTML", async () => {
    await service().sendSystemMail({ to: "pessoa@exemplo.org", subject: "[TWS Panel] Aviso", text: "t", html: "<p>h</p>" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      host: "paas-stalwart",
      port: 465,
      servername: `mail.${A}`,
      username: `postmaster@${A}`,
      password: "senha-do-postmaster",
      from: `postmaster@${A}`,
      fromName: "TWS Panel",
      to: "pessoa@exemplo.org",
      subject: "[TWS Panel] Aviso",
      text: "t",
      html: "<p>h</p>",
      dsn: false,
    });
    expect(sent[0]!.messageId).toMatch(new RegExp(`^<tws-aviso-[0-9a-f]+@${A.replace(/\./g, "\\.")}>$`));
  });

  it("fora de container: porta publicada no 127.0.0.1", async () => {
    await service(false).sendSystemMail({ to: "pessoa@exemplo.org", subject: "s", text: "t", html: "h" });
    expect(sent[0]).toMatchObject({ host: "127.0.0.1", port: 4650 });
  });

  it("não pronto: recusa com o motivo", async () => {
    running = false;
    await expect(service().sendSystemMail({ to: "p@exemplo.org", subject: "s", text: "t", html: "h" })).rejects.toThrow(/parado/);
  });

  it("recusa definitiva do servidor (5xx) vira erro permanente; o resto, temporário", async () => {
    sendImpl = async () => {
      throw new SmtpSendError(550, "O servidor de e-mail recusou (RCPT): 550 usuário inexistente");
    };
    const e1 = (await service()
      .sendSystemMail({ to: "p@exemplo.org", subject: "s", text: "t", html: "h" })
      .catch((e: unknown) => e)) as Error & { permanent?: boolean };
    expect(e1.permanent).toBe(true);
    expect(e1.message).toMatch(/550/);
    sendImpl = async () => {
      throw new SmtpSendError(0, "tempo esgotado");
    };
    const e2 = (await service()
      .sendSystemMail({ to: "p@exemplo.org", subject: "s", text: "t", html: "h" })
      .catch((e: unknown) => e)) as Error & { permanent?: boolean };
    expect(e2.permanent).toBe(false);
    sendImpl = async () => {
      throw "texto";
    };
    const e3 = (await service()
      .sendSystemMail({ to: "p@exemplo.org", subject: "s", text: "t", html: "h" })
      .catch((e: unknown) => e)) as Error & { permanent?: boolean };
    expect(e3.message).toBe("texto");
  });
});
