/**
 * Registro de envios por SMTP: recebimento do aviso do Stalwart (atribuição a
 * projeto, idempotência, fila limitada, privacidade), estados vindos dos
 * eventos de entrega (fora de ordem, repetidos), reconciliação, retenção e a
 * revelação do conteúdo. Sem Docker nem Stalwart: o aviso usado é o formato
 * real capturado de um Stalwart v0.11.8.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDeliveryEvent } from "@paas/core";
import type { QueueMessageRaw } from "@paas/mailer";
import { aggregateState, MailSendLogService, type MailSendLogDeps } from "../src/services/mail-send-log-service.js";

const SECRET_SUBJECT = "Assunto MUITO secreto";
const SECRET_BODY = "Corpo MUITO secreto 4321";
const QID_HEX = "4ab14d0b7ef4000";
const QID = "336385483840897024";

let dir: string;
let now: number;
let queue: QueueMessageRaw[];
let queueFails: boolean;
let serverCreated: boolean;
let deps: MailSendLogDeps;
let logs: string[];
let svc: MailSendLogService;

function hook(over: { login?: string; hex?: string; to?: string[]; body?: string; subject?: string; from?: string } = {}) {
  return {
    context: { stage: "data", sasl: { login: over.login ?? "app@example.com" }, queue: { id: over.hex ?? QID_HEX } },
    envelope: { from: { address: over.from ?? "app@example.com" }, to: (over.to ?? ["dest@exemplo.net"]).map((address) => ({ address })) },
    message: {
      headers: [
        ["Subject", ` ${over.subject ?? SECRET_SUBJECT}\r\n`],
        ["Content-Type", " text/plain; charset=utf-8\r\n"],
      ],
      contents: over.body ?? SECRET_BODY,
      size: 300,
    },
  };
}

function event(over: Partial<MailDeliveryEvent> = {}): MailDeliveryEvent {
  return {
    at: "2026-10-22T12:00:05.000Z",
    queueId: QID,
    from: "app@example.com",
    to: "dest@exemplo.net",
    toDomain: "exemplo.net",
    state: "delivered",
    code: 250,
    detail: "250 2.0.0 OK",
    remoteHost: "mx.exemplo.net",
    nextRetryAt: null,
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-send-log-"));
  now = Date.parse("2026-10-22T12:00:00Z");
  queue = [];
  queueFails = false;
  serverCreated = true;
  logs = [];
  deps = {
    dataDir: dir,
    now: () => now,
    senders: async () => [
      { address: "app@example.com", mailbox: "app@example.com", projectId: "p1", system: false },
      { address: "postmaster@example.com", mailbox: "postmaster@example.com", projectId: null, system: true },
    ],
    projectNames: async () => new Map([["p1", "Loja"]]),
    serverCreated: async () => serverCreated,
    listQueue: async () => {
      if (queueFails) throw new Error("fila fora do ar");
      return { items: queue, total: queue.length };
    },
    captureConfigured: async () => true,
    log: (m) => logs.push(m),
  };
  svc = new MailSendLogService(deps);
});

afterEach(async () => {
  svc.stop();
  await svc.flush();
  await rm(dir, { recursive: true, force: true });
});

async function receive(payload: unknown) {
  const r = svc.submit(payload);
  await svc.flush();
  return r;
}

describe("recebimento do aviso", () => {
  it("guarda o envio na caixa do projeto: de, para, hora, estado 'na fila', sem assunto nem corpo na listagem", async () => {
    expect(await receive(hook())).toBe("queued");
    const list = await svc.list({});
    expect(list.total).toBe(1);
    const item = list.items[0]!;
    expect(item).toMatchObject({
      id: QID,
      at: "2026-10-22T12:00:00.000Z",
      from: "app@example.com",
      mailbox: "app@example.com",
      origin: "project",
      projectId: "p1",
      projectName: "Loja",
      state: "queued",
      hasContent: true,
      captured: true,
      size: 300,
    });
    expect(item.recipients).toEqual([
      { address: "dest@exemplo.net", domain: "exemplo.net", state: "queued", deferrals: 0, updatedAt: null, nextRetryAt: null, remoteHost: null, error: null },
    ]);
    expect(JSON.stringify(list)).not.toContain("secreto");
    expect(list.capture).toEqual({ configured: true, lastReceivedAt: "2026-10-22T12:00:00.000Z", serverCreated: true });
    expect(list.storesContent).toBe(true);
    expect(list.retention).toEqual({ metadataDays: 90, bodyDays: 14 });
    expect(list.projects).toEqual([{ id: "p1", name: "Loja" }]);
  });

  it("o conteúdo nunca vai para o disco dos metadados nem para o log do painel", async () => {
    await receive(hook());
    const saidas = path.join(dir, "mail", "envios", "saidas");
    for (const f of await readdir(saidas)) expect(await readFile(path.join(saidas, f), "utf8")).not.toContain("secreto");
    expect(logs.join("\n")).not.toContain("secreto");
    const content = await readFile(path.join(dir, "envios-conteudo", `${QID}.json`), "utf8");
    expect(content).toContain(SECRET_BODY);
  });

  it("origem: caixa sem projeto = painel; remetente desconhecido = outro", async () => {
    await receive(hook({ login: "postmaster@example.com", hex: "1", from: "postmaster@example.com" }));
    await receive(hook({ login: "estranho@outro.org", hex: "2", from: "estranho@outro.org" }));
    const byId = Object.fromEntries((await svc.list({})).items.map((i) => [i.id, i]));
    expect(byId["1"]).toMatchObject({ origin: "panel", projectId: null, mailbox: "postmaster@example.com" });
    expect(byId["2"]).toMatchObject({ origin: "other", projectId: null, mailbox: "estranho@outro.org" });
    expect((await svc.list({ origin: "panel" })).total).toBe(1);
    expect((await svc.list({ projectId: "none" })).total).toBe(2);
  });

  it("projeto removido: o registro continua, com o nome da época", async () => {
    await receive(hook());
    deps.projectNames = async () => new Map();
    deps.senders = async () => [];
    const list = await svc.list({ projectId: "p1" });
    expect(list.items[0]).toMatchObject({ projectId: "p1", projectName: "Loja", origin: "project" });
    expect(list.projects).toEqual([{ id: "p1", name: "Loja" }]);
  });

  it("aviso repetido (o Stalwart tenta de novo) não duplica", async () => {
    await receive(hook());
    now += 5000;
    await receive(hook());
    const list = await svc.list({});
    expect(list.total).toBe(1);
    expect(list.items[0]!.at).toBe("2026-10-22T12:00:00.000Z");
    expect(svc.counters.stored).toBe(1);
  });

  it("formato inválido é recusado sem quebrar", async () => {
    expect(svc.submit(null)).toBe("invalid");
    expect(svc.submit({ context: { stage: "mail" } })).toBe("invalid");
    expect(svc.submit({ context: { stage: "data", sasl: { login: 3 } } })).toBe("invalid");
    // forma certa por fora, errada por dentro: contada e descartada
    expect(await receive({ context: { stage: "data", sasl: { login: "a@b.c" }, queue: { id: "zz" } } })).toBe("queued");
    expect(svc.counters.invalid).toBe(4);
    expect((await svc.list({})).total).toBe(0);
  });

  it("fila em memória cheia: descarta e conta, sem travar", async () => {
    const small = new MailSendLogService({ ...deps, queueLimit: 2 });
    const results = [1, 2, 3, 4].map((n) => small.submit(hook({ hex: String(n) })));
    expect(results.filter((r) => r === "dropped").length).toBeGreaterThanOrEqual(1);
    expect(small.counters.dropped).toBeGreaterThanOrEqual(1);
    await small.flush();
  });

  it("falha ao gravar não propaga: é contada e registrada sem conteúdo", async () => {
    deps.senders = async () => {
      throw new Error("falha de leitura");
    };
    expect(svc.submit(hook())).toBe("queued");
    await svc.flush();
    expect(svc.counters.failed).toBe(1);
    expect(logs[0]).toContain("falha de leitura");
    expect(logs.join("")).not.toContain("secreto");
    // o próximo continua funcionando
    deps.senders = async () => [];
    await receive(hook({ hex: "2" }));
    expect((await svc.list({})).total).toBe(1);
  });
});

describe("privacidade e conteúdo", () => {
  it("desligar a gravação (global): só metadados, nada de conteúdo no disco", async () => {
    await svc.updateSettings({ storeContent: false });
    await receive(hook());
    const item = (await svc.list({})).items[0]!;
    expect(item.hasContent).toBe(false);
    await expect(svc.reveal(QID)).rejects.toMatchObject({ statusCode: 404, code: "content_not_stored" });
    await expect(readdir(path.join(dir, "envios-conteudo"))).rejects.toThrow();
    expect((await svc.list({})).storesContent).toBe(false);
  });

  it("desligar por projeto: só aquele projeto; e apaga o que já estava guardado", async () => {
    await receive(hook());
    await receive(hook({ login: "postmaster@example.com", hex: "2", from: "postmaster@example.com" }));
    await svc.updateSettings({ project: { id: "p1", storeContent: false } });
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual(["2.json"]);
    const byId = Object.fromEntries((await svc.list({})).items.map((i) => [i.id, i]));
    expect(byId[QID]).toMatchObject({ hasContent: false, contentExpired: true });
    expect(byId["2"]!.hasContent).toBe(true);
    expect((await svc.list({ projectId: "p1" })).storesContent).toBe(false);
    expect((await svc.list({ projectId: "none" })).storesContent).toBe(true);
    await receive(hook({ hex: "3" }));
    expect((await svc.list({ projectId: "p1" })).items.find((i) => i.id === "3")!.hasContent).toBe(false);
    await svc.updateSettings({ project: { id: "p1", storeContent: true } });
    expect((await svc.settings()).projectsWithoutContent).toEqual([]);
  });

  it("Exibir devolve assunto, corpo e anexos de UMA mensagem; escopo de projeto é respeitado", async () => {
    await receive(hook());
    const content = await svc.reveal(QID);
    expect(content).toMatchObject({ id: QID, subject: SECRET_SUBJECT, body: SECRET_BODY, bodyTruncated: false, attachments: [] });
    expect(content.expiresAt).toBe("2026-11-05T12:00:00.000Z");
    expect((await svc.reveal(QID, { projectId: "p1" })).subject).toBe(SECRET_SUBJECT);
    await expect(svc.reveal(QID, { projectId: "outro" })).rejects.toMatchObject({ statusCode: 404, code: "send_not_found" });
    await expect(svc.reveal("999")).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.reveal("../etc")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("corpo grande é cortado no teto por mensagem e marcado", async () => {
    await svc.updateSettings({ maxBodyKiB: 1 });
    await receive(hook({ body: "x".repeat(5000) }));
    const content = await svc.reveal(QID);
    expect(content.body!.length).toBe(1024);
    expect(content.bodyTruncated).toBe(true);
    expect((await svc.list({})).items[0]!.contentTruncated).toBe(true);
  });

  it("anexos: só nome e tamanho, nunca o arquivo", async () => {
    const p = hook();
    p.message.headers = [["Content-Type", 'multipart/mixed; boundary="B"']];
    p.message.contents = ["--B", "Content-Type: text/plain", "", "oi", "--B", "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="r.pdf"', "Content-Transfer-Encoding: base64", "", Buffer.alloc(900, 7).toString("base64"), "--B--"].join("\r\n");
    await receive(p);
    expect((await svc.list({})).items[0]!.attachments).toEqual([{ name: "r.pdf", size: 900 }]);
    const stored = await readFile(path.join(dir, "envios-conteudo", `${QID}.json`), "utf8");
    expect(stored).not.toContain(Buffer.alloc(900, 7).toString("base64"));
  });

  it("revelar o que expirou ou sumiu responde 410", async () => {
    await receive(hook());
    now += 15 * 86_400_000;
    await svc.purge();
    await expect(svc.reveal(QID)).rejects.toMatchObject({ statusCode: 410, code: "content_expired" });
    expect((await svc.list({})).items[0]).toMatchObject({ hasContent: false, contentExpired: true });
  });
});

describe("configuração", () => {
  it("valida limites e coerência", async () => {
    await expect(svc.updateSettings({ metadataDays: 3 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.updateSettings({ bodyDays: 1.5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.updateSettings({ bodyDays: 60, metadataDays: 30 })).rejects.toMatchObject({ statusCode: 400 });
    const v = await svc.updateSettings({ metadataDays: 30, bodyDays: 7, maxBodyKiB: 8, maxTotalMiB: 20 });
    expect(v).toMatchObject({ metadataDays: 30, bodyDays: 7, maxBodyKiB: 8, maxTotalMiB: 20 });
    expect(await svc.settings()).toEqual(v);
  });
});

describe("estados (eventos de entrega)", () => {
  it("entregue", async () => {
    await receive(hook());
    await svc.applyEvents([event()]);
    const r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("delivered");
    expect(r.recipients[0]).toMatchObject({ state: "delivered", remoteHost: "mx.exemplo.net", error: null });
  });

  it("adiado com tentativas, depois recusado (5xx) com motivo claro", async () => {
    await receive(hook());
    await svc.applyEvents([
      event({ at: "2026-10-22T12:00:05.000Z", state: "deferred", code: 451, detail: "451 4.7.1 Greylisted, try again later", nextRetryAt: "2026-10-22T12:10:00.000Z" }),
      event({ at: "2026-10-22T12:10:05.000Z", state: "deferred", code: 451, detail: "451 4.7.1 Greylisted, try again later", nextRetryAt: "2026-10-22T12:40:00.000Z" }),
    ]);
    let r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("deferred");
    expect(r.recipients[0]).toMatchObject({ deferrals: 2, nextRetryAt: "2026-10-22T12:40:00.000Z" });
    expect(r.recipients[0]!.error).toMatchObject({ kind: "greylisted", code: 451, enhanced: "4.7.1" });
    await svc.applyEvents([event({ at: "2026-10-22T13:00:00.000Z", state: "bounced", code: 550, detail: "550 5.1.1 User unknown" })]);
    r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("rejected");
    expect(r.recipients[0]).toMatchObject({ state: "rejected", nextRetryAt: null });
    expect(r.recipients[0]!.error).toMatchObject({ kind: "no_such_user", technical: "550 5.1.1 User unknown" });
  });

  it("destinatário de domínio inexistente: falhou (DNS/MX), não 'rejeitado'", async () => {
    await receive(hook({ to: ["x@nao-existe.example.org"] }));
    await svc.applyEvents([event({ to: "x@nao-existe.example.org", toDomain: "nao-existe.example.org", state: "bounced", code: null, detail: 'SMTP error occurred (smtp.error) { details = Connection Error, reason = "record not found for MX" }', remoteHost: null })]);
    const r = (await svc.list({ state: "failed" })).items[0]!;
    expect(r.state).toBe("failed");
    expect(r.recipients[0]!.error!.kind).toBe("no_mx");
  });

  it("eventos fora de ordem e repetidos: vale o mais novo, sem contar duas vezes", async () => {
    await receive(hook());
    const d1 = event({ at: "2026-10-22T12:00:05.000Z", state: "deferred", code: 451, detail: "451 4.7.1 try again later" });
    const ok = event({ at: "2026-10-22T12:20:00.000Z" });
    await svc.applyEvents([ok, d1]);
    await svc.applyEvents([d1, ok, d1]);
    const r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("delivered");
    // o adiamento aconteceu antes da entrega e conta uma vez, mesmo lido três vezes
    expect(r.recipients[0]!.deferrals).toBe(1);
    // evento velho depois do resultado final não desfaz
    await svc.applyEvents([event({ at: "2026-10-22T12:10:00.000Z", state: "deferred" })]);
    expect((await svc.list({})).items[0]!.state).toBe("delivered");
  });

  it("repetição do mesmo adiamento conta uma vez só", async () => {
    await receive(hook());
    const d = event({ state: "deferred", code: 451, detail: "451 4.7.1 try again later" });
    await svc.applyEvents([d, d]);
    await svc.applyEvents([d]);
    expect((await svc.list({})).items[0]!.recipients[0]!.deferrals).toBe(1);
  });

  it("evento antes do aviso: registro só com metadados; o aviso depois completa sem duplicar", async () => {
    await svc.applyEvents([event()]);
    let list = await svc.list({});
    expect(list.items[0]).toMatchObject({ captured: false, hasContent: false, origin: "project", projectId: "p1", mailbox: null, state: "delivered" });
    await receive(hook());
    list = await svc.list({});
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ captured: true, hasContent: true, state: "delivered", mailbox: "app@example.com" });
    expect(list.items[0]!.recipients).toHaveLength(1);
  });

  it("entregas em dias diferentes do aviso não deixam registro duplicado após recarregar", async () => {
    await receive(hook());
    await svc.applyEvents([event({ at: "2026-10-23T00:00:10.000Z" })]);
    const again = new MailSendLogService(deps);
    const list = await again.list({});
    expect(list.total).toBe(1);
    expect(list.items[0]!.state).toBe("delivered");
  });

  it("cancelada pelo painel, vários destinatários e estado geral", async () => {
    await receive(hook({ to: ["a@x.org", "b@x.org", "c@x.org"] }));
    await svc.applyEvents([
      event({ to: "a@x.org", toDomain: "x.org" }),
      event({ to: "b@x.org", toDomain: "x.org", state: "cancelled", code: null, detail: "Cancelada no painel." }),
    ]);
    const r = (await svc.list({})).items[0]!;
    expect(r.recipients.map((x) => x.state)).toEqual(["delivered", "cancelled", "queued"]);
    expect(r.state).toBe("queued");
    expect((await svc.list({ state: "cancelled" })).total).toBe(1);
    expect(aggregateState([])).toBe("queued");
    expect(aggregateState([{ state: "delivered" }, { state: "failed" }])).toBe("failed");
    expect(aggregateState([{ state: "delivered" }, { state: "rejected" }, { state: "failed" }])).toBe("rejected");
    expect(aggregateState([{ state: "cancelled" }, { state: "delivered" }])).toBe("cancelled");
  });

  it("evento de remetente desconhecido (e-mail recebido de fora, entregue localmente) não vira registro", async () => {
    await svc.applyEvents([event({ queueId: "77", from: "alguem@fora.example.net" })]);
    queue = [raw("78", "alguem@fora.example.net", "z@x.org")];
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    expect((await svc.list({})).total).toBe(0);
  });

  it("sem eventos novos não grava nada", async () => {
    await svc.applyEvents([]);
    expect((await svc.list({})).total).toBe(0);
  });
});

describe("listagem: filtros e paginação", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 7; i++) {
      now = Date.parse(`2026-10-${10 + i}T12:00:00Z`);
      await receive(hook({ hex: String(i), to: [i % 2 ? "impar@x.org" : "par@y.org"] }));
    }
    now = Date.parse("2026-10-22T12:00:00Z");
    await svc.applyEvents([event({ queueId: "2", to: "par@y.org", toDomain: "y.org", state: "bounced", code: 550, detail: "550 5.1.1 unknown", at: "2026-10-12T12:00:05.000Z" })]);
  });

  it("mais recentes primeiro, com páginas", async () => {
    const p1 = await svc.list({ limit: 3 });
    expect(p1.items.map((i) => i.id)).toEqual(["7", "6", "5"]);
    expect(p1.total).toBe(7);
    const p3 = await svc.list({ limit: 3, offset: 6 });
    expect(p3.items.map((i) => i.id)).toEqual(["1"]);
    expect((await svc.list({ limit: 9999 })).limit).toBe(100);
    expect((await svc.list({ limit: 0, offset: -4 })).items).toHaveLength(1);
  });

  it("filtra por estado, período e destinatário", async () => {
    expect((await svc.list({ state: "rejected" })).items.map((i) => i.id)).toEqual(["2"]);
    expect((await svc.list({ from: "2026-10-15", to: "2026-10-16" })).items.map((i) => i.id)).toEqual(["6", "5"]);
    expect((await svc.list({ recipient: "  PAR@Y" })).items.map((i) => i.id)).toEqual(["6", "4", "2"]);
    expect((await svc.list({ state: "queued", recipient: "impar" })).total).toBe(4);
  });
});

const raw = (id: string, from: string, to: string): QueueMessageRaw =>
    ({
      id,
      return_path: from,
      created: "2026-10-22T11:59:00Z",
      size: 123,
      domains: [{ name: "x.org", status: "scheduled", recipients: [{ address: to, status: "scheduled", orig_address: to }], retry_num: 0, next_retry: "2026-10-22T12:05:00Z", expires: "2026-10-27T12:00:00Z" }],
    }) as unknown as QueueMessageRaw;

describe("reconciliação", () => {
  it("mensagem na fila que o painel não conhecia vira registro só com metadados", async () => {
    queue = [raw("500", "app@example.com", "z@x.org"), raw("501", "", "z@x.org")];
    expect(await svc.reconcile()).toEqual({ created: 1, unconfirmed: 0 });
    const item = (await svc.list({})).items[0]!;
    expect(item).toMatchObject({ id: "500", captured: false, hasContent: false, projectId: "p1", state: "queued", size: 123 });
    // já conhecida: nada novo
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
  });

  it("pendente que saiu da fila sem resultado vira 'sem confirmação' (depois de 15 min)", async () => {
    await receive(hook());
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    now += 20 * 60_000;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 1 });
    const r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("unconfirmed");
    // o resultado chegando depois corrige
    await svc.applyEvents([event({ at: "2026-10-22T12:00:09.000Z" })]);
    expect((await svc.list({})).items[0]!.state).toBe("delivered");
  });

  it("se a mensagem ainda está na fila, não mexe", async () => {
    await receive(hook());
    queue = [raw(QID, "app@example.com", "dest@exemplo.net")];
    now += 20 * 60_000;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
  });

  it("fila fora do ar ou servidor não criado: não faz nada", async () => {
    await receive(hook());
    now += 20 * 60_000;
    queueFails = true;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    queueFails = false;
    serverCreated = false;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    expect((await svc.list({})).items[0]!.state).toBe("queued");
  });

  it("retoma depois de reiniciar o painel (lê o disco)", async () => {
    await receive(hook());
    await svc.applyEvents([event()]);
    const again = new MailSendLogService(deps);
    const item = (await again.list({})).items[0]!;
    expect(item).toMatchObject({ id: QID, state: "delivered", hasContent: true });
    expect((await again.reveal(QID)).subject).toBe(SECRET_SUBJECT);
  });
});

describe("retenção automática", () => {
  it("corpo some em 14 dias, metadados em 90; arquivos órfãos saem", async () => {
    await receive(hook());
    now += 10 * 86_400_000;
    expect(await svc.purge()).toEqual({ removedRecords: 0, expiredContents: 0 });
    expect((await svc.reveal(QID)).subject).toBe(SECRET_SUBJECT);
    now += 5 * 86_400_000;
    expect((await svc.purge()).expiredContents).toBe(1);
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual([]);
    expect((await svc.list({})).total).toBe(1);
    now += 80 * 86_400_000;
    expect((await svc.purge()).removedRecords).toBe(1);
    expect((await svc.list({})).total).toBe(0);
  });

  it("conteúdo sem registro é apagado", async () => {
    await receive(hook());
    const other = new MailSendLogService({ ...deps, dataDir: dir });
    await other.purge();
    await rm(path.join(dir, "mail"), { recursive: true });
    const fresh = new MailSendLogService(deps);
    await fresh.purge();
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual([]);
  });

  it("teto total: apaga o conteúdo mais antigo até caber", async () => {
    await svc.updateSettings({ maxTotalMiB: 10, maxBodyKiB: 512 });
    for (let i = 1; i <= 22; i++) {
      now += 1000;
      await receive(hook({ hex: String(i), body: "y".repeat(600 * 1024) }));
    }
    await svc.purge();
    const left = await readdir(path.join(dir, "envios-conteudo"));
    expect(left.length).toBeLessThan(22);
    expect(left).not.toContain("1.json");
    expect((await svc.list({})).items.find((i) => i.id === "1")!.contentExpired).toBe(true);
  });
});

describe("agendamento", () => {
  it("start/stop agendam e cancelam as rotinas", async () => {
    vi.useFakeTimers();
    try {
      const timed = new MailSendLogService(deps);
      const spy = vi.spyOn(timed, "reconcile").mockResolvedValue({ created: 0, unconfirmed: 0 });
      const purge = vi.spyOn(timed, "purge").mockResolvedValue({ removedRecords: 0, expiredContents: 0 });
      timed.start();
      await vi.advanceTimersByTimeAsync(95_000);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(purge).toHaveBeenCalledTimes(1);
      timed.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
