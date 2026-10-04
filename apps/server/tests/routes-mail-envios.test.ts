/**
 * Rotas da página Envios (/api/mail/envios/*): autenticadas, com schema,
 * auditoria nas ações (tentar agora, cancelar, chave DQS — sem a chave) e a
 * nota de entregabilidade montada com os dados guardados. Os serviços são
 * dublês: sem Docker, sem Stalwart, sem DNS.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type MailReputationResponse } from "@paas/core";
import { mailEnviosRoutes, type MailEnviosRouteDeps } from "../src/routes/mail-envios.js";
import { httpError } from "../src/services/http-error.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const NOW = Date.parse("2026-10-04T15:00:00Z");

let ctx: AuthTestContext;
let app: FastifyInstance;
let d: {
  envios: Record<string, ReturnType<typeof vi.fn>>;
  reputation: Record<string, ReturnType<typeof vi.fn>>;
  domainNames: ReturnType<typeof vi.fn>;
};

const REPUTATION: MailReputationResponse = {
  lastCheck: null,
  lastError: null,
  checking: false,
  nextCheckAt: "2026-10-05T15:00:00.000Z",
  dqs: { configured: false, hint: null },
};

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  d = {
    envios: {
      queue: vi.fn(async () => ({ available: true, message: null, items: [], total: 0, checkedAt: "x" })),
      retry: vi.fn(async () => ({ ok: true, message: "Tentando." })),
      cancel: vi.fn(async () => ({ ok: true, message: "Cancelada." })),
      history: vi.fn(async () => ({ items: [], total: 0 })),
      volume: vi.fn(async () => ({ days: [] })),
      summary7d: vi.fn(async () => ({ delivered: 0, bounced: 0, deferredRecipients: 0, recipients: 0 })),
      firstEventAt: vi.fn(async () => null),
    },
    reputation: {
      state: vi.fn(async () => REPUTATION),
      check: vi.fn(async () => REPUTATION),
      setDqsKey: vi.fn(async () => undefined),
      marks: vi.fn(async () => ({ googleAt: null, microsoftAt: null, spamRateOkAt: null })),
      setMarks: vi.fn(async (m: object) => ({ googleAt: null, microsoftAt: null, spamRateOkAt: null, ...m })),
      facts: vi.fn(async () => null),
    },
    domainNames: vi.fn(async () => ["envio.exemplo.com.br"]),
  };
  await app.register(async (scope) => {
    registerErrorHandler(scope);
    mailEnviosRoutes(scope, { ...(d as unknown as MailEnviosRouteDeps), now: () => NOW });
  });
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const ID = "333028896599011329";

describe("fila", () => {
  it("GET /api/mail/envios/queue", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/queue", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true });
  });

  it("tentar agora e cancelar: repassam o id inteiro (sem perder dígitos) e vão para a auditoria", async () => {
    const record = vi.spyOn(app.auditService, "record");
    let res = await app.inject({ method: "POST", url: `/api/mail/envios/queue/${ID}/retry`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(d.envios.retry).toHaveBeenCalledWith(ID);
    res = await app.inject({ method: "POST", url: `/api/mail/envios/queue/${ID}/cancel`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(d.envios.cancel).toHaveBeenCalledWith(ID);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.queue.retry", target: ID }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.queue.cancel", target: ID }));
  });

  it("id que não é número: 400 sem chamar o serviço", async () => {
    for (const bad of ["abc", "1.5", "1".repeat(21)]) {
      const res = await app.inject({ method: "POST", url: `/api/mail/envios/queue/${bad}/cancel`, headers: auth });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(d.envios.cancel).not.toHaveBeenCalled();
  });

  it("erro do serviço: código e mensagem dele, sem auditoria", async () => {
    d.envios.cancel!.mockRejectedValue(httpError(404, "queue_message_not_found", "Essa mensagem já saiu da fila."));
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "POST", url: `/api/mail/envios/queue/${ID}/cancel`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "queue_message_not_found", message: "Essa mensagem já saiu da fila." });
    expect(record).not.toHaveBeenCalled();
  });

  it("erro inesperado: 500 genérico", async () => {
    d.envios.retry!.mockRejectedValue(new Error("boom"));
    const res = await app.inject({ method: "POST", url: `/api/mail/envios/queue/${ID}/retry`, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal_error" });
  });

  it("sem autenticação: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/queue" });
    expect(res.statusCode).toBe(401);
  });
});

describe("histórico e volume", () => {
  it("repassa os filtros já convertidos", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mail/envios/history?days=7&state=bounced&projectId=p1&mailbox=loja%40envio.test&domain=gmail.com&q=user&limit=50&offset=10&refresh=1",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(d.envios.history).toHaveBeenCalledWith({
      days: 7,
      state: "bounced",
      projectId: "p1",
      mailbox: "loja@envio.test",
      domain: "gmail.com",
      q: "user",
      limit: 50,
      offset: 10,
      refresh: true,
    });
  });

  it("sem filtros: 7 dias, sem ler de novo", async () => {
    await app.inject({ method: "GET", url: "/api/mail/envios/history", headers: auth });
    expect(d.envios.history).toHaveBeenCalledWith({ days: 7, refresh: false });
  });

  it.each([
    ["days=31"],
    ["days=0"],
    ["state=sumiu"],
    ["limit=abc"],
    ["domain=nao%20e%20dominio"],
    ["refresh=talvez"],
    ["extra=1"],
  ])("histórico com %s: 400", async (qs) => {
    const res = await app.inject({ method: "GET", url: `/api/mail/envios/history?${qs}`, headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it("volume: 14 dias no fuso pedido", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/volume?tz=180", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(d.envios.volume).toHaveBeenCalledWith({ days: 14, tzOffsetMinutes: 180 });
    await app.inject({ method: "GET", url: "/api/mail/envios/volume?tz=-60", headers: auth });
    expect(d.envios.volume).toHaveBeenLastCalledWith({ days: 14, tzOffsetMinutes: -60 });
    await app.inject({ method: "GET", url: "/api/mail/envios/volume", headers: auth });
    expect(d.envios.volume).toHaveBeenLastCalledWith({ days: 14, tzOffsetMinutes: 0 });
  });

  it("volume com fuso fora do intervalo: 400", async () => {
    for (const tz of ["900", "-900", "abc"]) {
      const res = await app.inject({ method: "GET", url: `/api/mail/envios/volume?tz=${tz}`, headers: auth });
      expect(res.statusCode, tz).toBe(400);
    }
  });
});

describe("reputação", () => {
  it("estado e conferir agora", async () => {
    let res = await app.inject({ method: "GET", url: "/api/mail/envios/reputation", headers: auth });
    expect(res.json()).toEqual(REPUTATION);
    res = await app.inject({ method: "POST", url: "/api/mail/envios/reputation/check", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(d.reputation.check).toHaveBeenCalledWith({ manual: true });
  });

  it("conferir de novo cedo demais: 429 do serviço", async () => {
    d.reputation.check!.mockRejectedValue(httpError(429, "check_too_soon", "Espere um minuto."));
    const res = await app.inject({ method: "POST", url: "/api/mail/envios/reputation/check", headers: auth });
    expect(res.statusCode).toBe(429);
  });

  it("chave DQS: guarda, audita SEM a chave e devolve o estado", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const key = "abcdefghij0123456789abcdef";
    const res = await app.inject({ method: "PUT", url: "/api/mail/envios/reputation/dqs", headers: auth, payload: { key } });
    expect(res.statusCode).toBe(200);
    expect(d.reputation.setDqsKey).toHaveBeenCalledWith(key);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.dqs.set" }));
    expect(JSON.stringify(record.mock.calls)).not.toContain(key);
    await app.inject({ method: "PUT", url: "/api/mail/envios/reputation/dqs", headers: auth, payload: { key: null } });
    expect(d.reputation.setDqsKey).toHaveBeenLastCalledWith(null);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ action: "mail.dqs.clear" }));
  });

  it("chave DQS: corpo inválido → 400", async () => {
    for (const payload of [{}, { key: 5 }, { key: "a".repeat(65) }, { key: "x", outro: 1 }]) {
      const res = await app.inject({ method: "PUT", url: "/api/mail/envios/reputation/dqs", headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("nota de entregabilidade", () => {
  it("sem nada conferido: domínios como 'não verificado' e nota baixa", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/deliverability", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.band).toBe("red");
    expect(body.factsAt).toBeNull();
    expect(body.items.find((i: { id: string }) => i.id === "dns").status).toBe("unknown");
    expect(body.marks).toEqual({ googleAt: null, microsoftAt: null, spamRateOkAt: null });
  });

  it("com fatos, listas e envios guardados", async () => {
    d.reputation.facts!.mockResolvedValue({
      at: "2026-10-04T14:00:00.000Z",
      domains: [{ name: "envio.exemplo.com.br", dnsOk: 6, dnsTotal: 6, ptr: "found" }],
      tls: { ok: 1, total: 1 },
    });
    d.reputation.state!.mockResolvedValue({
      ...REPUTATION,
      lastCheck: {
        checkedAt: "2026-10-04T14:00:00.000Z",
        ip: { target: "203.0.113.10", results: [{ dnsbl: "spamhaus-zen", label: "Spamhaus ZEN", status: "clean", detail: null, removalUrl: null }] },
        domains: [],
        listedCount: 0,
      },
    });
    d.envios.summary7d!.mockResolvedValue({ delivered: 100, bounced: 0, deferredRecipients: 0, recipients: 100 });
    d.envios.firstEventAt!.mockResolvedValue("2026-08-01T00:00:00.000Z");
    const res = await app.inject({ method: "GET", url: "/api/mail/envios/deliverability", headers: auth });
    const body = res.json();
    expect(body.factsAt).toBe("2026-10-04T14:00:00.000Z");
    expect(body.score).toBe(80);
    expect(body.band).toBe("yellow");
  });

  it("marcações do Postmaster: grava e devolve", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/mail/envios/postmaster",
      headers: auth,
      payload: { googleAt: "2026-10-01", spamRateOkAt: null },
    });
    expect(res.statusCode).toBe(200);
    expect(d.reputation.setMarks).toHaveBeenCalledWith({ googleAt: "2026-10-01", spamRateOkAt: null });
    expect(res.json()).toMatchObject({ marks: { googleAt: "2026-10-01" } });
  });

  it("marcações: corpo vazio, campo extra ou valor errado → 400", async () => {
    for (const payload of [{}, { outro: "x" }, { googleAt: 5 }]) {
      const res = await app.inject({ method: "PUT", url: "/api/mail/envios/postmaster", headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
