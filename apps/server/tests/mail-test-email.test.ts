/**
 * mail-test-email.test.ts — "Enviar e-mail de teste" na página do domínio.
 *
 * Pedido do dono do produto (01/10/2026): validar o e-mail do painel numa VPS
 * de teste sem depender de chamado no provedor. O painel envia uma mensagem
 * simples pela submission do próprio Stalwart (caixa postmaster@, cuja senha
 * ele guarda), e acompanha o destino pela fila (API de administração) e pelo
 * aviso de entrega que o Stalwart deixa na caixa postmaster@.
 *
 * Sem Docker e sem rede: StalwartManager/Client são dublês; o envio SMTP, a
 * leitura do aviso e o relógio são injetados.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { FindDeliveryReportOptions, QueuedMessage, SmtpSendOptions } from "@paas/mailer";
import type { ServerConfig } from "../src/config.js";

let queue: QueuedMessage[] = [];
let queueError: Error | null = null;
const queueQueries: string[] = [];
let running = true;

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return { installed: true, running, ports: MAIL_DEFAULT_PORTS };
    }
    async connectContainer() {
      // em container o painel se liga à paas-net antes de falar com o Stalwart
    }
  }
  class FakeStalwartClient {
    async listQueuedMessages(text: string) {
      queueQueries.push(text);
      if (queueError) throw queueError;
      return queue;
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

const DOMAIN = "envio.exemplo.com.br";
const TO = "pessoa@gmail.com";
let dir = "";
let config: ServerConfig;
let clock = 0;
let sent: SmtpSendOptions[] = [];
let sendImpl: (o: SmtpSendOptions) => Promise<{ response: string; dsn: boolean }>;
let reports: FindDeliveryReportOptions[] = [];
let reportImpl: (o: FindDeliveryReportOptions) => Promise<{ state: "delivered" | "bounced" | "deferred"; detail: string } | null>;

async function seed(mailboxes: Record<string, unknown> = { [`postmaster@${DOMAIN}`]: postmaster() }) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({
      adminSecret: "s",
      hostname: null,
      domains: {
        [DOMAIN]: {
          name: DOMAIN,
          dkimSelector: "paas",
          dkimPublicKey: "x".repeat(120),
          dkimKeyBits: 2048,
          dmarcStage: "none",
          createdAt: new Date(0).toISOString(),
          lastVerify: null,
        },
      },
      mailboxes,
      projects: {},
    }),
  );
}

function postmaster() {
  return {
    id: `postmaster@${DOMAIN}`,
    localPart: "postmaster",
    domain: DOMAIN,
    kind: "system",
    createdAt: new Date(0).toISOString(),
    password: "senha-do-postmaster",
  };
}

function service(inContainer = true) {
  return new MailService(config, {
    inContainer,
    now: () => clock,
    sendMail: async (o) => {
      sent.push(o);
      return sendImpl(o);
    },
    findReport: async (o) => {
      reports.push(o);
      return reportImpl(o);
    },
  });
}

function inQueue(envId: string, rcptStatus: QueuedMessage["domains"][number]["status"], domainStatus: QueuedMessage["domains"][number]["status"] = "scheduled"): QueuedMessage {
  return {
    id: 1,
    return_path: `postmaster@${DOMAIN}`,
    created: "2026-10-01T12:00:00Z",
    size: 900,
    env_id: envId,
    blob_hash: "b",
    domains: [
      {
        name: "gmail.com",
        status: domainStatus,
        recipients: [{ address: TO, status: rcptStatus }],
        retry_num: 1,
        next_retry: "2026-10-01T12:07:00Z",
        next_notify: null,
        expires: "2026-10-06T12:00:00Z",
      },
    ],
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-test-email-"));
  config = {
    dataDir: dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS, submissions: 4650 },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
  clock = Date.parse("2026-10-01T12:00:00Z");
  sent = [];
  reports = [];
  queue = [];
  queueError = null;
  queueQueries.length = 0;
  running = true;
  sendImpl = async () => ({ response: "250 2.0.0 Message queued for delivery.", dsn: true });
  reportImpl = async () => null;
  await seed();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sendTestEmail — envio", () => {
  it("envia pela submission do Stalwart na paas-net, autenticado como postmaster@, com aviso de entrega", async () => {
    const test = await service().sendTestEmail(DOMAIN, "Pessoa@Gmail.com");

    expect(sent).toHaveLength(1);
    const o = sent[0]!;
    expect(o).toMatchObject({
      host: "paas-stalwart",
      port: 465,
      servername: `mail.${DOMAIN}`,
      username: `postmaster@${DOMAIN}`,
      password: "senha-do-postmaster",
      from: `postmaster@${DOMAIN}`,
      to: TO,
      subject: "Teste do TWS Panel",
    });
    expect(o.text).toContain("servidor de e-mail da sua VPS");
    expect(o.envId).toBe(`tws-teste-${test.id}`);
    expect(o.messageId).toBe(`<tws-teste-${test.id}@${DOMAIN}>`);
    expect(test).toMatchObject({
      domain: DOMAIN,
      from: `postmaster@${DOMAIN}`,
      to: TO,
      state: "queued",
      final: false,
      sentAt: "2026-10-01T12:00:00.000Z",
    });
    expect(test.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("fora de container (desenvolvimento): 127.0.0.1 na porta publicada da 465", async () => {
    await service(false).sendTestEmail(DOMAIN, TO);
    expect(sent[0]).toMatchObject({ host: "127.0.0.1", port: 4650 });
  });

  it("endereço inválido ou mais de um destinatário: 400, nada é enviado", async () => {
    const s = service();
    for (const bad of ["sem-arroba", "a@b.com, c@d.com", "a@b.com\r\nRCPT TO:<c@d.com>", "a b@c.com"]) {
      await expect(s.sendTestEmail(DOMAIN, bad)).rejects.toMatchObject({ statusCode: 400, code: "invalid_recipient" });
    }
    expect(sent).toHaveLength(0);
  });

  it("domínio desconhecido: 404; servidor parado: 409", async () => {
    await expect(service().sendTestEmail("outro.com.br", TO)).rejects.toMatchObject({ statusCode: 404 });
    running = false;
    await expect(service().sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({ statusCode: 409, code: "mail_server_stopped" });
  });

  it("sem a caixa postmaster@ guardada: 409 explicando", async () => {
    await seed({});
    await expect(service().sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({ statusCode: 409, code: "test_mailbox_missing" });
  });

  it("servidor recusa o envio: 502 com a resposta dele", async () => {
    sendImpl = async () => {
      throw Object.assign(new Error("O servidor de e-mail recusou (AUTH): 535 credenciais inválidas"), { code: 535 });
    };
    await expect(service().sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({
      statusCode: 502,
      code: "test_send_failed",
      message: expect.stringContaining("535"),
    });
  });

  it("limite de frequência: 1 teste a cada 30 s e 20 por hora", async () => {
    const s = service();
    await s.sendTestEmail(DOMAIN, TO);
    clock += 10_000;
    await expect(s.sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({ statusCode: 429, code: "test_rate_limited" });
    clock += 20_000;
    await expect(s.sendTestEmail(DOMAIN, TO)).resolves.toBeTruthy();
    for (let i = 0; i < 18; i++) {
      clock += 30_000;
      await s.sendTestEmail(DOMAIN, TO);
    }
    expect(sent).toHaveLength(20);
    clock += 30_000;
    const err = await s.sendTestEmail(DOMAIN, TO).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 429, code: "test_rate_limited" });
    expect((err as Error).message).toMatch(/20 testes por hora/);
    // uma hora depois do primeiro, libera de novo
    clock = Date.parse("2026-10-01T13:00:01Z");
    await expect(s.sendTestEmail(DOMAIN, TO)).resolves.toBeTruthy();
  });

  it("falha no envio também conta no limite (o botão não vira martelo)", async () => {
    sendImpl = async () => {
      throw new Error("fora do ar");
    };
    const s = service();
    await expect(s.sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({ statusCode: 502 });
    await expect(s.sendTestEmail(DOMAIN, TO)).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("testEmailStatus — destino da mensagem", () => {
  async function sendOne() {
    const s = service();
    const test = await s.sendTestEmail(DOMAIN, TO);
    return { s, test, envId: `tws-teste-${test.id}` };
  }

  it("na fila, sem tentativa ainda → 'queued' (consulta a fila pelo destinatário)", async () => {
    const { s, test, envId } = await sendOne();
    queue = [inQueue("outro-envio", { perm_fail: "x" }), inQueue(envId, "scheduled")];
    const status = await s.testEmailStatus(DOMAIN, test.id);
    expect(status).toMatchObject({ state: "queued", final: false, detail: null });
    expect(queueQueries).toEqual([TO]);
  });

  it("adiada: motivo e próxima tentativa", async () => {
    const { s, test, envId } = await sendOne();
    queue = [inQueue(envId, "scheduled", { temp_fail: "Connection to 'gmail-smtp-in.l.google.com' failed: timed out" })];
    const status = await s.testEmailStatus(DOMAIN, test.id);
    expect(status).toMatchObject({
      state: "deferred",
      final: false,
      detail: "Connection to 'gmail-smtp-in.l.google.com' failed: timed out",
      nextRetryAt: "2026-10-01T12:07:00Z",
    });
  });

  it("saiu da fila e o aviso diz entregue → 'delivered' confirmado e definitivo", async () => {
    const { s, test } = await sendOne();
    queue = [];
    reportImpl = async () => ({ state: "delivered", detail: "delivered to 'gmail-smtp-in.l.google.com' with code 250 (2.0.0) 'OK'" });
    const status = await s.testEmailStatus(DOMAIN, test.id);
    expect(status).toMatchObject({ state: "delivered", confirmed: true, final: true });
    expect(status.detail).toContain("gmail-smtp-in");
    // o aviso é procurado na caixa postmaster@, só depois do envio
    expect(reports[0]).toMatchObject({
      baseUrl: "http://paas-stalwart:8080",
      username: `postmaster@${DOMAIN}`,
      password: "senha-do-postmaster",
      to: TO,
    });
    expect(reports[0]!.since.getTime()).toBeLessThanOrEqual(Date.parse(test.sentAt));
    // resultado definitivo não consulta de novo
    await s.testEmailStatus(DOMAIN, test.id);
    expect(reports).toHaveLength(1);
  });

  it("saiu da fila e o aviso diz recusado → 'bounced' com o motivo", async () => {
    const { s, test } = await sendOne();
    reportImpl = async () => ({ state: "bounced", detail: "host 'mx' rejected command 'RCPT TO' with code 550 (5.1.1) 'No such user'" });
    const status = await s.testEmailStatus(DOMAIN, test.id);
    expect(status).toMatchObject({ state: "bounced", final: true, confirmed: true });
    expect(status.detail).toContain("No such user");
  });

  it("recusado ainda dentro da fila → 'bounced'", async () => {
    const { s, test, envId } = await sendOne();
    queue = [inQueue(envId, { perm_fail: "Code: 550, Enhanced code: 5.7.1, Message: Blocked" })];
    expect(await s.testEmailStatus(DOMAIN, test.id)).toMatchObject({ state: "bounced", detail: "550 5.7.1 Blocked", final: true });
  });

  it("sumiu da fila sem aviso: espera um pouco; depois trata como entregue (sem recibo)", async () => {
    const { s, test } = await sendOne();
    clock += 3_000;
    expect(await s.testEmailStatus(DOMAIN, test.id)).toMatchObject({ state: "queued", final: false });
    clock += 25_000;
    const status = await s.testEmailStatus(DOMAIN, test.id);
    expect(status).toMatchObject({ state: "delivered", confirmed: false, final: true });
    expect(status.detail).toMatch(/saiu da fila sem erro/i);
  });

  it("falha ao ler o aviso não derruba a consulta (conta como 'sem aviso')", async () => {
    const { s, test } = await sendOne();
    reportImpl = async () => {
      throw new Error("JMAP fora");
    };
    expect(await s.testEmailStatus(DOMAIN, test.id)).toMatchObject({ state: "queued" });
  });

  it("fila indisponível: 502", async () => {
    const { s, test } = await sendOne();
    queueError = new Error("Sem conexão com o Stalwart");
    await expect(s.testEmailStatus(DOMAIN, test.id)).rejects.toMatchObject({ statusCode: 502, code: "mail_queue_unavailable" });
  });

  it("teste desconhecido (ou de outro domínio): 404", async () => {
    const { s, test } = await sendOne();
    await expect(s.testEmailStatus(DOMAIN, "0123456789abcdef")).rejects.toMatchObject({ statusCode: 404 });
    await expect(s.testEmailStatus("outro.com.br", test.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * Pedido do dono do produto (02/10/2026): testar o envio a partir de qualquer
 * caixa do domínio (ex.: logo depois de trocar a senha dela), num modal
 * aberto pela própria caixa.
 */
describe("sendTestEmail — a partir de outra caixa do domínio", () => {
  const vendas = () => ({
    id: `vendas@${DOMAIN}`,
    localPart: "vendas",
    domain: DOMAIN,
    kind: "user",
    createdAt: new Date(0).toISOString(),
    password: "senha-de-vendas-nova",
  });

  it("autentica como a caixa escolhida, com a senha que o painel guarda (a recém-trocada)", async () => {
    await seed({ [`postmaster@${DOMAIN}`]: postmaster(), [`vendas@${DOMAIN}`]: vendas() });
    const test = await service().sendTestEmail(DOMAIN, TO, `Vendas@${DOMAIN}`);
    expect(sent[0]).toMatchObject({ username: `vendas@${DOMAIN}`, password: "senha-de-vendas-nova", from: `vendas@${DOMAIN}` });
    expect(test.from).toBe(`vendas@${DOMAIN}`);
  });

  it("caixa que não existe ou de outro domínio: 404, nada é enviado", async () => {
    await seed({ [`postmaster@${DOMAIN}`]: postmaster(), "x@outro.com.br": { ...vendas(), id: "x@outro.com.br", domain: "outro.com.br" } });
    await expect(service().sendTestEmail(DOMAIN, TO, `nada@${DOMAIN}`)).rejects.toMatchObject({ statusCode: 404, code: "mailbox_not_found" });
    await expect(service().sendTestEmail(DOMAIN, TO, "x@outro.com.br")).rejects.toMatchObject({ statusCode: 404 });
    expect(sent).toHaveLength(0);
  });
});
