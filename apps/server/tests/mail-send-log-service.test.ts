/**
 * Registro de envios por SMTP: recebimento do aviso do Stalwart (atribuição a
 * projeto, idempotência, fila limitada, privacidade), estados vindos dos
 * eventos de entrega (fora de ordem, repetidos), reconciliação, retenção e a
 * revelação do conteúdo. Sem Docker nem Stalwart: o aviso usado é o formato
 * real capturado de um Stalwart v0.11.8.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDeliveryEvent } from "@paas/core";
import type { QueueMessageRaw } from "@paas/mailer";
import { aggregateState, MailSendLogService, type MailSendLogDeps } from "../src/services/mail-send-log-service.js";
import { removeDir } from "./helpers/tmp.js";

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
      { address: "outro@example.com", mailbox: "outro@example.com", projectId: "p2", system: false },
      { address: "maria@example.com", mailbox: "maria@example.com", projectId: null, system: false },
    ],
    localDomains: async () => ["example.com"],
    projectNames: async () => new Map([["p1", "Loja"], ["p2", "Blog"]]),
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
  await removeDir(dir);
});

/** Linhas gravadas em disco (cada gravação de um registro é uma linha): mede regravação. */
async function linesOnDisk(): Promise<number> {
  const folder = path.join(dir, "mail", "envios", "saidas");
  let n = 0;
  for (const f of await readdir(folder)) if (f.endsWith(".jsonl")) n += (await readFile(path.join(folder, f), "utf8")).split("\n").filter(Boolean).length;
  return n;
}

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
    await receive(hook({ login: "outro@example.com", hex: "2", from: "outro@example.com" }));
    await svc.updateSettings({ project: { id: "p1", storeContent: false } });
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual(["2.json"]);
    const byId = Object.fromEntries((await svc.list({})).items.map((i) => [i.id, i]));
    expect(byId[QID]).toMatchObject({ hasContent: false, contentExpired: false, contentRemoved: true });
    expect(byId["2"]!.hasContent).toBe(true);
    await expect(svc.reveal(QID)).rejects.toMatchObject({ statusCode: 410, code: "content_removed" });
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

/** Troca o arquivo por uma pasta com algo dentro: o `rm` simples falha, como num erro de permissão. */
async function blockRemoval(file: string): Promise<void> {
  await rm(file, { force: true });
  await mkdir(file);
  await writeFile(path.join(file, "x"), "x");
}

describe("revisão: privacidade e atribuição", () => {
  it("assunto e corpo só de caixa de PROJETO; webmail e caixa pessoal ficam só com os dados da mensagem", async () => {
    await receive(hook({ login: "maria@example.com", from: "maria@example.com", hex: "a" }));
    await receive(hook({ login: "postmaster@example.com", from: "postmaster@example.com", hex: "b" }));
    await receive(hook({ hex: "c" }));
    const byId = Object.fromEntries((await svc.list({})).items.map((i) => [i.id, i]));
    expect(byId["10"]).toMatchObject({ origin: "panel", hasContent: false });
    expect(byId["11"]).toMatchObject({ hasContent: false });
    expect(byId["12"]).toMatchObject({ origin: "project", hasContent: true });
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual(["12.json"]);
    await expect(svc.reveal("10")).rejects.toMatchObject({ code: "content_not_stored" });
  });

  it("remetente forjado de caixa existente, entregue localmente, NÃO vira envio do projeto", async () => {
    // e-mail vindo de fora (porta 25, sem login) com MAIL FROM = caixa do projeto, para uma caixa local
    await svc.applyEvents([event({ queueId: "300", from: "app@example.com", to: "postmaster@example.com", toDomain: "example.com" })]);
    queue = [raw("301", "app@example.com", "postmaster@example.com")];
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    expect((await svc.list({})).total).toBe(0);
    expect((await svc.list({ projectId: "p1" })).total).toBe(0);
  });

  it("entrega para fora do servidor (só existe com login) continua reconstruída pelo log", async () => {
    await svc.applyEvents([event({ queueId: "302", from: "app@example.com", to: "cliente@exemplo.net" })]);
    queue = [raw("303", "app@example.com", "x@exemplo.net")];
    expect((await svc.reconcile()).created).toBe(1);
    expect((await svc.list({ projectId: "p1" })).total).toBe(2);
  });

  it("fila mista (local + fora): só os destinatários de fora entram", async () => {
    const base = raw("304", "app@example.com", "postmaster@example.com");
    const extra = raw("304", "app@example.com", "fora@exemplo.net").domains[0]!;
    queue = [{ ...base, domains: [...base.domains, extra] } as QueueMessageRaw];
    expect((await svc.reconcile()).created).toBe(1);
    expect((await svc.list({})).items[0]!.recipients.map((r) => r.address)).toEqual(["fora@exemplo.net"]);
  });

  it("apagar conteúdo que falha ao remover NÃO marca como apagado e repete no próximo expurgo", async () => {
    await receive(hook());
    const file = path.join(dir, "envios-conteudo", `${QID}.json`);
    await blockRemoval(file);
    await svc.updateSettings({ storeContent: false });
    expect((await svc.list({})).items[0]).toMatchObject({ hasContent: true, contentRemoved: false });
    expect(logs.some((l) => l.includes("Tento de novo"))).toBe(true);
    expect(logs.join("\n")).not.toContain(SECRET_BODY);
    // o problema passou: o expurgo seguinte (gravação já desligada) conclui
    await removeDir(file);
    await svc.updateSettings({ storeContent: false });
    expect((await svc.list({})).items[0]).toMatchObject({ hasContent: false, contentRemoved: true });
    expect(await readdir(path.join(dir, "envios-conteudo"))).toEqual([]);
  });

  it("expurgo por retenção que falha em remover mantém o registro 'guardado'", async () => {
    await receive(hook());
    now += 20 * 86_400_000;
    const file = path.join(dir, "envios-conteudo", `${QID}.json`);
    await blockRemoval(file);
    const first = await svc.purge();
    expect(first.expiredContents).toBe(0);
    expect((await svc.list({})).items[0]!.hasContent).toBe(true);
    await removeDir(file);
    await writeFile(file, JSON.stringify({ id: QID, subject: "s", body: "b", bodyTruncated: false, attachments: [], storedAt: "2026-10-22T12:00:00.000Z" }));
    expect((await svc.purge()).expiredContents).toBe(1);
  });

  it("'último envio registrado' é do projeto, não do painel todo", async () => {
    await receive(hook({ login: "outro@example.com", from: "outro@example.com", hex: "a" }));
    now += 3_600_000;
    await receive(hook({ hex: "b" }));
    const p2 = (await svc.list({ projectId: "p2" })).capture.lastReceivedAt;
    const p1 = (await svc.list({ projectId: "p1" })).capture.lastReceivedAt;
    expect(p2).toBe("2026-10-22T12:00:00.000Z");
    expect(p1).toBe("2026-10-22T13:00:00.000Z");
    expect((await svc.list({})).capture.lastReceivedAt).toBe("2026-10-22T13:00:00.000Z");
    expect((await svc.list({ projectId: "sem-envio" })).capture.lastReceivedAt).toBeNull();
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
    // sem nenhum evento há mais de 6 h a tela mostra "sem confirmação": o filtro acompanha o que a tela mostra
    expect((await svc.list({ state: "queued", recipient: "impar" })).total).toBe(0);
    const silent = await svc.list({ state: "unconfirmed", recipient: "impar" });
    expect(silent.total).toBe(4);
    expect(silent.items.every((i) => i.state === "unconfirmed")).toBe(true);
    // recém-enviado continua em "na fila" (nos dois lados)
    await receive(hook({ hex: "99", to: ["novo@x.org"] }));
    expect((await svc.list({ state: "queued", recipient: "novo@" })).items.map((i) => i.id)).toEqual(["153"]);
    expect((await svc.list({ state: "unconfirmed", recipient: "novo@" })).total).toBe(0);
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

  it("resultado que ficou sem ser aplicado (chegou antes do registro ou se perdeu) é reaplicado da história guardada", async () => {
    await receive(hook());
    expect((await svc.list({})).items[0]!.state).toBe("queued");
    const stored = [event({ at: "2026-10-22T12:00:09.000Z" }), event({ queueId: "999", at: "2026-10-22T12:00:09.000Z" })];
    const asked: string[][] = [];
    svc = new MailSendLogService({
      ...deps,
      eventsFor: async (ids) => {
        asked.push([...ids]);
        return stored.filter((e) => ids.has(e.queueId));
      },
    });
    await svc.reconcile();
    expect(asked).toEqual([[QID]]);
    const item = (await svc.list({})).items[0]!;
    expect(item.state).toBe("delivered");
    expect(item.recipients[0]!.remoteHost).toBe("mx.exemplo.net");
    // sem pendência, nem pergunta
    await svc.reconcile();
    expect(asked).toHaveLength(1);
  });

  it("sem evento algum no histórico guardado, o estado não é inventado", async () => {
    await receive(hook());
    svc = new MailSendLogService({ ...deps, eventsFor: async () => [] });
    await svc.reconcile();
    expect((await svc.list({})).items[0]!.state).toBe("queued");
  });

  it("falha ao ler a história guardada não derruba a reconciliação", async () => {
    await receive(hook());
    svc = new MailSendLogService({
      ...deps,
      eventsFor: async () => {
        throw new Error("disco");
      },
    });
    await expect(svc.reconcile()).resolves.toEqual({ created: 0, unconfirmed: 0 });
    expect(logs.join("\n")).toMatch(/reaplicar/);
    expect(svc.counters.failed).toBe(1);
  });

  it("6 h sem nenhum evento: 'sem confirmação', com a fila de pé, com a fila fora do ar e mesmo antes de reconciliar", async () => {
    await receive(hook());
    queue = [raw(QID, "app@example.com", "dest@exemplo.net")];
    now += 5 * 3_600_000;
    expect((await svc.reconcile()).unconfirmed).toBe(0);
    expect((await svc.list({})).items[0]!.state).toBe("queued");
    now += 2 * 3_600_000;
    // a tela já não mostra "na fila" como se fosse resultado
    expect((await svc.list({})).items[0]!.state).toBe("unconfirmed");
    queueFails = true;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 1 });
    queueFails = false;
    // o resultado que chegar depois ainda vence
    await svc.applyEvents([event({ at: "2026-10-22T20:00:00.000Z" })]);
    expect((await svc.list({})).items[0]!.state).toBe("delivered");
  });

  it("adiado há mais de 6 h continua 'adiado' enquanto a fila ainda o tem (tem tentativa registrada)", async () => {
    await receive(hook());
    await svc.applyEvents([event({ state: "deferred", at: "2026-10-22T12:00:03.000Z", nextRetryAt: "2026-10-22T12:02:00.000Z" })]);
    queue = [raw(QID, "app@example.com", "dest@exemplo.net")];
    now += 8 * 3_600_000;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    expect((await svc.list({})).items[0]!.state).toBe("deferred");
  });

  it("reaplicar o mesmo adiamento não o conta de novo nem regrava o registro (a cada reconciliação)", async () => {
    const deferred = event({ state: "deferred", code: 451, detail: "451 4.7.1 later", at: "2026-10-22T12:00:03.000Z", nextRetryAt: "2026-10-22T12:02:00.000Z" });
    svc = new MailSendLogService({ ...deps, eventsFor: async (ids) => [deferred].filter((e) => ids.has(e.queueId)) });
    await receive(hook());
    await svc.applyEvents([deferred]);
    now += 20 * 60_000;
    expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 1 });
    const lines = () => linesOnDisk();
    const written = await lines();
    for (let i = 0; i < 5; i++) expect(await svc.reconcile()).toEqual({ created: 0, unconfirmed: 0 });
    const item = (await svc.list({})).items[0]!;
    expect(item.state).toBe("unconfirmed");
    expect(item.recipients[0]!.deferrals).toBe(1);
    expect(await lines()).toBe(written);
  });

  it("o adiamento que só existe no histórico guardado entra uma vez e não volta a ser regravado", async () => {
    const deferred = event({ state: "deferred", code: 451, detail: "451 4.7.1 later", at: "2026-10-22T12:00:03.000Z", nextRetryAt: "2026-10-22T12:02:00.000Z" });
    svc = new MailSendLogService({ ...deps, eventsFor: async (ids) => [deferred].filter((e) => ids.has(e.queueId)) });
    await receive(hook());
    now += 20 * 60_000;
    await svc.reconcile();
    const written = await linesOnDisk();
    for (let i = 0; i < 4; i++) await svc.reconcile();
    const item = (await svc.list({})).items[0]!;
    expect(item.state).toBe("unconfirmed");
    expect(item.recipients[0]!.deferrals).toBe(1);
    expect(await linesOnDisk()).toBe(written);
  });

  it("um adiamento NOVO (mais recente) tira o envio de 'sem confirmação' e conta", async () => {
    await receive(hook());
    now += 20 * 60_000;
    await svc.reconcile();
    expect((await svc.list({})).items[0]!.state).toBe("unconfirmed");
    await svc.applyEvents([event({ state: "deferred", code: 451, detail: "451 later", at: "2026-10-22T12:19:00.000Z", nextRetryAt: "2026-10-22T12:30:00.000Z" })]);
    const r = (await svc.list({})).items[0]!;
    expect(r.state).toBe("deferred");
    expect(r.recipients[0]!.deferrals).toBe(1);
  });

  describe("envios anteriores à correção: cada estado pendente é conferido contra o histórico guardado", () => {
    const delivered = (): MailDeliveryEvent => event({ at: "2026-10-22T12:00:09.000Z" });
    const asked: string[][] = [];
    const withHistory = () =>
      new MailSendLogService({
        ...deps,
        eventsFor: async (ids) => {
          asked.push([...ids]);
          return [delivered()].filter((e) => ids.has(e.queueId));
        },
      });
    beforeEach(() => {
      asked.length = 0;
    });

    it("'na fila'", async () => {
      await receive(hook());
      const fresh = withHistory();
      await fresh.reconcile();
      expect((await fresh.list({})).items[0]!.state).toBe("delivered");
    });

    it("'adiado'", async () => {
      await receive(hook());
      await svc.applyEvents([event({ state: "deferred", code: 451, detail: "451 later", at: "2026-10-22T12:00:03.000Z", nextRetryAt: "2026-10-22T12:02:00.000Z" })]);
      const fresh = withHistory();
      await fresh.reconcile();
      expect((await fresh.list({})).items[0]!.state).toBe("delivered");
    });

    it("'sem confirmação' (o caso do envio que ficou preso e foi dado como perdido pela versão anterior)", async () => {
      await receive(hook());
      now += 20 * 60_000;
      await svc.reconcile();
      expect((await svc.list({})).items[0]!.state).toBe("unconfirmed");
      const fresh = withHistory();
      await fresh.reconcile();
      expect((await fresh.list({})).items[0]!.state).toBe("delivered");
    });

    it("'sem confirmação' é conferido uma vez por execução (resultados novos chegam pela coleta); 'na fila' e 'adiado', sempre", async () => {
      await receive(hook());
      now += 20 * 60_000;
      await svc.reconcile();
      const fresh = new MailSendLogService({ ...deps, eventsFor: async (ids) => (asked.push([...ids]), []) });
      await fresh.reconcile();
      await fresh.reconcile();
      expect(asked).toEqual([[QID]]);
      fresh.submit(hook({ hex: "777", to: ["outro@exemplo.net"] }));
      await fresh.flush();
      await fresh.reconcile();
      expect(asked).toEqual([[QID], [String(0x777)]]);
      fresh.stop();
    });
  });

  it("a leitura do histórico começa no envio pendente mais antigo (com folga), nunca em todo o período", async () => {
    const sinces: number[] = [];
    svc = new MailSendLogService({ ...deps, eventsFor: async (_ids, sinceMs) => (sinces.push(sinceMs), []) });
    now = Date.parse("2026-10-22T10:00:00Z");
    await receive(hook({ hex: "1" }));
    now = Date.parse("2026-10-22T11:00:00Z");
    await receive(hook({ hex: "2" }));
    now = Date.parse("2026-10-22T11:30:00Z");
    await svc.reconcile();
    expect(sinces).toEqual([Date.parse("2026-10-22T10:00:00Z") - 5 * 60_000]);
  });

  it("e nunca além de 30 dias, mesmo com um pendente antigo", async () => {
    const sinces: number[] = [];
    svc = new MailSendLogService({ ...deps, eventsFor: async (_ids, sinceMs) => (sinces.push(sinceMs), []) });
    now = Date.parse("2026-08-01T10:00:00Z");
    await receive(hook({ hex: "1" }));
    now = Date.parse("2026-10-22T12:00:00Z");
    await svc.reconcile();
    expect(sinces).toEqual([now - 30 * 86_400_000]);
  });

  it("resultado de entrega que chega ANTES do aviso: o aviso completa o registro (caixa, tamanho, conteúdo) sem deixar conteúdo órfão", async () => {
    await svc.applyEvents([event({ at: "2026-10-22T12:00:05.000Z" })]);
    expect((await svc.list({})).items[0]).toMatchObject({ captured: false, size: 0, mailbox: null });
    await receive(hook());
    const item = (await svc.list({})).items[0]!;
    expect(item).toMatchObject({ id: QID, captured: true, size: 300, mailbox: "app@example.com", hasContent: true, state: "delivered" });
    expect(item.at <= "2026-10-22T12:00:05.000Z").toBe(true);
    expect((await svc.reveal(QID)).subject).toBe(SECRET_SUBJECT);
    expect((await svc.list({})).total).toBe(1);
  });

  it("resultado e aviso ao mesmo tempo, na ordem inversa (resultado primeiro, preso na atribuição): nada é pisado", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    svc = new MailSendLogService({
      ...deps,
      senders: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return deps.senders();
      },
    });
    const events = svc.applyEvents([event()]);
    await new Promise((r) => setTimeout(r, 20));
    svc.submit(hook());
    await new Promise((r) => setTimeout(r, 20));
    release();
    await events;
    await svc.flush();
    const list = await svc.list({});
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ captured: true, size: 300, mailbox: "app@example.com", hasContent: true, state: "delivered" });
    expect((await svc.reveal(QID)).body).toBe(SECRET_BODY);
  });

  it("aviso gravando o conteúdo (preso) e o resultado chegando no meio: o envio termina 'entregue'", async () => {
    const store = (svc as unknown as { store: { writeContent(c: unknown): Promise<void> } }).store;
    const write = store.writeContent.bind(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    store.writeContent = async (content) => {
      await gate;
      await write(content);
    };
    svc.submit(hook());
    await new Promise((r) => setTimeout(r, 20));
    const events = svc.applyEvents([event({ at: "2026-10-22T12:00:09.000Z" })]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await events;
    await svc.flush();
    expect((await svc.list({})).items[0]).toMatchObject({ captured: true, state: "delivered", hasContent: true });
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
    // A ordem do "mais antigo" vem da data do arquivo; o relógio do disco é grosso (vários arquivos
    // no mesmo instante), então o teste fixa as datas em vez de depender da velocidade da gravação.
    for (let i = 1; i <= 22; i++) {
      const file = path.join(dir, "envios-conteudo", `${parseInt(String(i), 16)}.json`);
      await utimes(file, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
    }
    await svc.purge();
    const left = await readdir(path.join(dir, "envios-conteudo"));
    expect(left.length).toBeLessThan(22);
    expect(left).toContain(`${parseInt("22", 16)}.json`);
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
