/**
 * Rotas dos envios por SMTP: exigem login, validam schema, listam sem NUNCA
 * devolver assunto/corpo, só "Exibir" devolve (uma mensagem), e a revelação
 * deixa na auditoria quem, quando e o id (sem o texto). Serviço real (disco
 * temporário); Stalwart e projetos são dublês.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { mailSendRoutes } from "../src/routes/mail-send-routes.js";
import { MailSendLogService } from "../src/services/mail-send-log-service.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const SECRET = "Texto-ultra-secreto-9988";

let ctx: AuthTestContext;
let app: FastifyInstance;
let sends: MailSendLogService;
let dataDir: string;
let refresh: () => Promise<unknown>;

function hook(hex: string, login: string, subject = "Assunto " + SECRET) {
  return {
    context: { stage: "data", sasl: { login }, queue: { id: hex } },
    envelope: { from: { address: login }, to: [{ address: "dest@exemplo.net" }] },
    message: { headers: [["Subject", ` ${subject}`], ["Content-Type", "text/plain"]], contents: `Corpo ${SECRET}`, size: 10 },
  };
}

beforeEach(async () => {
  refresh = async () => undefined;
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-routes-send-"));
  sends = new MailSendLogService({
    dataDir,
    senders: async () => [
      { address: "loja@example.com", mailbox: "loja@example.com", projectId: "p1", system: false },
      { address: "blog@example.com", mailbox: "blog@example.com", projectId: "p2", system: false },
    ],
    projectNames: async () => new Map([["p1", "Loja"], ["p2", "Blog"]]),
    serverCreated: async () => true,
    listQueue: async () => ({ items: [], total: 0 }),
    captureConfigured: async () => true,
  });
  sends.submit(hook("a", "loja@example.com"));
  sends.submit(hook("b", "blog@example.com"));
  sends.submit(hook("c", "loja@example.com"));
  await sends.flush();
  await app.register(async (scope) => {
    registerErrorHandler(scope);
    mailSendRoutes(scope, { sends, refresh: () => refresh() });
  });
});

afterEach(async () => {
  sends.stop();
  await closeAuthTestApp(ctx);
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers });
const put = (url: string, payload: unknown) => app.inject({ method: "PUT", url, headers: auth, payload: payload as object });

describe("autenticação", () => {
  it.each([
    ["GET", "/api/mail/envios/saidas"],
    ["GET", "/api/projects/p1/email/saidas"],
    ["POST", "/api/mail/envios/saidas/1/reveal"],
    ["POST", "/api/projects/p1/email/saidas/1/reveal"],
    ["GET", "/api/mail/envios/saidas/settings"],
    ["PUT", "/api/mail/envios/saidas/settings"],
    ["PUT", "/api/projects/p1/email/saidas/settings"],
  ])("%s %s sem credencial = 401", async (method, url) => {
    const res = await app.inject({ method: method as "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("depois do setup concluído, Exibir sem sessão é 401 (o setup token não basta)", async () => {
    await ctx.setupState.complete();
    const res = await post("/api/mail/envios/saidas/1/reveal");
    expect(res.statusCode).toBe(401);
  });
});

describe("listagem", () => {
  it("global: todos, com filtro por projeto/origem/estado; nunca assunto ou corpo", async () => {
    const res = await get("/api/mail/envios/saidas");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("secreto");
    expect(res.json().total).toBe(3);
    expect((await get("/api/mail/envios/saidas?projectId=p2")).json().items.map((i: { id: string }) => i.id)).toEqual(["11"]);
    expect((await get("/api/mail/envios/saidas?origin=other")).json().total).toBe(0);
    expect((await get("/api/mail/envios/saidas?state=queued&recipient=dest")).json().total).toBe(3);
    expect((await get("/api/mail/envios/saidas?limit=2&offset=2")).json().items).toHaveLength(1);
  });

  it("do projeto: só as mensagens daquele projeto, mesmo pedindo outro", async () => {
    const res = await get("/api/projects/p1/email/saidas");
    expect(res.json().items.map((i: { projectId: string }) => i.projectId)).toEqual(["p1", "p1"]);
    expect(res.body).not.toContain("secreto");
    expect((await get("/api/projects/p2/email/saidas")).json().total).toBe(1);
    expect((await get("/api/projects/p1/email/saidas?projectId=p2")).statusCode).toBe(400);
    expect((await get("/api/projects/nao-existe/email/saidas")).json().total).toBe(0);
  });

  it.each(["state=xx", "origin=xx", "from=ontem", "to=2026-1-1", "limit=0", "limit=1000", "offset=-1", "recipient=" + "a".repeat(101), "x=1"])("schema recusa %s", async (qs) => {
    expect((await get(`/api/mail/envios/saidas?${qs}`)).statusCode).toBe(400);
  });
});

describe("leitura do registro de entrega ao abrir a lista", () => {
  it.each(["/api/mail/envios/saidas", "/api/projects/p1/email/saidas"])("%s pede a leitura do registro sem esperar por ela", async (url) => {
    const calls: number[] = [];
    // a leitura nunca termina: a lista tem de responder do mesmo jeito
    refresh = () => {
      calls.push(1);
      return new Promise(() => undefined);
    };
    expect((await get(url)).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("leitura que falha não vira erro na lista", async () => {
    refresh = () => Promise.reject(new Error("docker fora do ar"));
    expect((await get("/api/mail/envios/saidas")).statusCode).toBe(200);
  });

  it("sem a função (painel sem Docker) a lista funciona", async () => {
    const solo = await buildAuthTestApp(TOKEN);
    await solo.app.register(async (scope) => {
      registerErrorHandler(scope);
      mailSendRoutes(scope, { sends });
    });
    expect((await solo.app.inject({ method: "GET", url: "/api/mail/envios/saidas", headers: auth })).statusCode).toBe(200);
    await closeAuthTestApp(solo);
  });
});

describe("Exibir", () => {
  it("devolve só aquela mensagem e audita quem/quando/id, sem o texto", async () => {
    const res = await post("/api/mail/envios/saidas/10/reveal");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "10", subject: "Assunto " + SECRET, body: `Corpo ${SECRET}` });
    expect(res.headers["cache-control"]).toBe("no-store");
    await ctx.auditService.flush();
    const entries = (await ctx.auditService.list(1, 200)).entries;
    const entry = entries.find((e: { action: string }) => e.action === "mail.send.reveal") as { target: string; detail: string; actor: string; at: string } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.target).toBe("10");
    expect(entry!.actor).toBeTruthy();
    expect(entry!.at).toBeTruthy();
    expect(JSON.stringify(entries)).not.toContain("secreto");
  });

  it("do projeto: mensagem de outro projeto é 404 e não é auditada como exibida", async () => {
    expect((await post("/api/projects/p2/email/saidas/10/reveal")).statusCode).toBe(404);
    expect((await post("/api/projects/p1/email/saidas/10/reveal")).statusCode).toBe(200);
    await ctx.auditService.flush();
    const entries = (await ctx.auditService.list(1, 200)).entries;
    expect(entries.filter((e: { action: string }) => e.action === "mail.send.reveal")).toHaveLength(1);
  });

  it("inexistente, sem conteúdo guardado e id inválido", async () => {
    expect((await post("/api/mail/envios/saidas/999/reveal")).statusCode).toBe(404);
    expect((await post("/api/mail/envios/saidas/abc/reveal")).statusCode).toBe(400);
    await sends.updateSettings({ storeContent: false });
    expect((await post("/api/mail/envios/saidas/10/reveal")).json().error).toBe("content_removed");
    expect((await post("/api/mail/envios/saidas/10/reveal")).statusCode).toBe(410);
  });
});

describe("configuração", () => {
  it("lê e muda retenção; audita sem conteúdo; recusa fora do limite", async () => {
    expect((await get("/api/mail/envios/saidas/settings")).json()).toMatchObject({ metadataDays: 90, bodyDays: 14, storeContent: true });
    const res = await put("/api/mail/envios/saidas/settings", { bodyDays: 7, maxBodyKiB: 32 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bodyDays: 7, maxBodyKiB: 32 });
    expect((await put("/api/mail/envios/saidas/settings", { bodyDays: 0 })).statusCode).toBe(400);
    expect((await put("/api/mail/envios/saidas/settings", { metadataDays: 3 })).statusCode).toBe(400);
    expect((await put("/api/mail/envios/saidas/settings", {})).statusCode).toBe(400);
    expect((await put("/api/mail/envios/saidas/settings", { foo: 1 })).statusCode).toBe(400);
    await ctx.auditService.flush();
    const entries = (await ctx.auditService.list(1, 200)).entries;
    expect(entries.some((e: { action: string }) => e.action === "mail.send.settings")).toBe(true);
  });

  it("por projeto: liga e desliga a gravação de assunto/corpo", async () => {
    let res = await put("/api/projects/p1/email/saidas/settings", { storeContent: false });
    expect(res.json().projectsWithoutContent).toEqual(["p1"]);
    expect((await get("/api/projects/p1/email/saidas")).json().storesContent).toBe(false);
    expect((await post("/api/projects/p1/email/saidas/10/reveal")).statusCode).toBe(410);
    res = await put("/api/projects/p1/email/saidas/settings", { storeContent: true });
    expect(res.json().projectsWithoutContent).toEqual([]);
    expect((await put("/api/projects/p1/email/saidas/settings", { storeContent: "sim" })).statusCode).toBe(400);
  });
});
