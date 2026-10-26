/**
 * "Marcar como ciente" da saúde do e-mail: o arquivo das marcações, o serviço
 * (a marcação vale para o problema de agora e some sozinha se ele mudar) e as
 * rotas PUT/DELETE (só admin, com auditoria). Sem rede, sem Docker.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type DnsVerifyResponse, type MailTlsStatusResponse } from "@paas/core";
import type { DnsResolverLike, PlanInput, Port25Result } from "@paas/mailer";
import { MailHealthService } from "../src/services/mail-health-service.js";
import { MailHealthAckStore } from "../src/services/mail-health-ack-store.js";
import { mailHealthRoutes } from "../src/routes/mail-health.js";
import { classifyRoute } from "../src/services/token-policy.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const DOMAIN = "envio.exemplo.com.br";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";
const PLAN: PlanInput = {
  domain: DOMAIN,
  mailHostname: HOST,
  serverHostname: HOST,
  serverIp: IP,
  dkimSelector: "paas",
  dkimPublicKey: "AAAA",
  dmarcStage: "none",
};
const nf = () => Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
const emptyResolver = (): DnsResolverLike => ({ resolve4: nf, resolve6: nf, resolveMx: nf, resolveTxt: nf, reverse: nf });
const TLS: MailTlsStatusResponse = { checkedAt: "2026-10-22T00:00:00Z", serverRunning: true, syncError: null, hosts: [] };

type PtrStatus = "found" | "action_required" | "mismatch";
const verifyOf = (status: PtrStatus, found: string[] = []) =>
  ({ ptr: { ip: IP, expected: HOST, status, found, ticketText: null } }) as unknown as DnsVerifyResponse;

let dir: string;
let clock = Date.parse("2026-10-26T12:00:00Z");
let ptr: { status: PtrStatus; found: string[] };

function make(over: Partial<ConstructorParameters<typeof MailHealthService>[0]> = {}) {
  const acks = new MailHealthAckStore(dir);
  const service = new MailHealthService({
    planInput: vi.fn(async (domain: string) => {
      if (domain !== DOMAIN) throw Object.assign(new Error("Domínio não cadastrado."), { statusCode: 404, code: "domain_not_found" });
      return PLAN;
    }),
    verify: vi.fn(async () => verifyOf(ptr.status, ptr.found)),
    tls: vi.fn(async () => TLS),
    blacklist: vi.fn(async () => null),
    queue: vi.fn(async () => []),
    resolvers: () => [{ label: "falso", resolver: emptyResolver() }],
    probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
    fetchPolicy: vi.fn(async () => null),
    isProxyIp: () => false,
    acks,
    now: () => clock,
    ...over,
  });
  return { service, acks };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-ack-"));
  clock = Date.parse("2026-10-26T12:00:00Z");
  ptr = { status: "action_required", found: [] };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MailHealthAckStore", () => {
  it("grava, lê e remove; arquivo com o motivo aparado e limitado", async () => {
    const store = new MailHealthAckStore(dir);
    expect(await store.all()).toEqual({});
    await store.set("ptr", { fingerprint: "f", reason: `  ${"x".repeat(400)}  `, at: "2026-10-26T12:00:00.000Z", by: "kelvin" });
    const all = await store.all();
    expect(all.ptr?.reason).toHaveLength(300);
    expect(all.ptr).toMatchObject({ fingerprint: "f", by: "kelvin" });
    expect(JSON.parse(await readFile(path.join(dir, "mail-health-acks.json"), "utf8")).ptr.fingerprint).toBe("f");
    await store.set("ptr", { fingerprint: "g", reason: "   ", at: "2026-10-26T12:00:00.000Z", by: null });
    expect((await store.all()).ptr).toMatchObject({ fingerprint: "g", reason: null });
    expect(await store.remove("ptr")).toBe(true);
    expect(await store.remove("ptr")).toBe(false);
    expect(await store.all()).toEqual({});
  });

  it("ignora o que não é item marcável ou está torto no arquivo", async () => {
    await writeFile(
      path.join(dir, "mail-health-acks.json"),
      JSON.stringify({
        ptr: { fingerprint: "ok", reason: null, at: "2026-10-26T12:00:00.000Z", by: null },
        spf: { fingerprint: "x", reason: null, at: "2026-10-26T12:00:00.000Z", by: null },
        port25: { fingerprint: 1, reason: null, at: "2026-10-26T12:00:00.000Z", by: null },
      }),
    );
    expect(Object.keys(await new MailHealthAckStore(dir).all())).toEqual(["ptr"]);
    await writeFile(path.join(dir, "mail-health-acks.json"), "[]");
    expect(await new MailHealthAckStore(dir).all()).toEqual({});
    await writeFile(path.join(dir, "mail-health-acks.json"), JSON.stringify({ ptr: null, port25: "x", dnsbl: { a: 1 } }));
    expect(await new MailHealthAckStore(dir).all()).toEqual({});
  });
});

describe("MailHealthService — ciente", () => {
  it("marcar o PTR: o item fica visível, deixa de contar e a marcação sobrevive a uma nova verificação", async () => {
    const { service } = make();
    const before = await service.check(DOMAIN, { manual: false });
    expect(before.level).toBe("critical"); // sem DNS nenhum
    expect(before.scopes.server.level).toBe("warn");
    const state = await service.acknowledge(DOMAIN, "ptr", { reason: "  peço ao suporte  ", by: "kelvin" });
    const ptrItem = state.report!.checks.find((c) => c.id === "ptr")!;
    expect(ptrItem).toMatchObject({ level: "warn", acknowledged: { reason: "peço ao suporte", by: "kelvin", at: "2026-10-26T12:00:00.000Z" } });
    expect(state.report!.scopes.server.level).toBe("ok");
    expect(state.report!.counts.acknowledged).toBe(1);
    expect(state.report!.inboxIssues).not.toContain("ptr");
    // nova verificação: a marcação continua valendo (o problema é o mesmo)
    clock += 60_000;
    const again = await service.check(DOMAIN, { manual: true });
    expect(again.checks.find((c) => c.id === "ptr")?.acknowledged).toBeDefined();
    expect(again.scopes.server.level).toBe("ok");
    expect(service.summary()).toEqual([expect.objectContaining({ domain: DOMAIN, level: "critical" })]);
  });

  it("o PTR passa a apontar para outro nome: volta a contar sozinho", async () => {
    ptr = { status: "mismatch", found: ["velho.exemplo.com.br"] };
    const { service } = make();
    await service.check(DOMAIN, { manual: false });
    await service.acknowledge(DOMAIN, "ptr", {});
    expect((await service.state(DOMAIN)).report!.scopes.server.level).toBe("ok");
    ptr = { status: "mismatch", found: ["outro.exemplo.com.br"] };
    clock += 60_000;
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "ptr")?.acknowledged).toBeUndefined();
    expect(report.scopes.server.level).toBe("warn");
    expect(report.inboxIssues).toContain("ptr");
  });

  it("o item vira crítico (porta 25 bloqueada): volta a contar", async () => {
    let port: Port25Result = { status: "error", detail: "x" };
    const { service } = make({ probePort25: vi.fn(async () => port) });
    await service.check(DOMAIN, { manual: false });
    await service.acknowledge(DOMAIN, "port25", {});
    expect((await service.state(DOMAIN)).report!.checks.find((c) => c.id === "port25")?.acknowledged).toBeDefined();
    port = { status: "blocked", detail: "ETIMEDOUT" };
    clock += 11 * 60_000; // passa o cache da sonda
    const report = await service.check(DOMAIN, { manual: false });
    expect(report.checks.find((c) => c.id === "port25")).toMatchObject({ level: "critical" });
    expect(report.checks.find((c) => c.id === "port25")?.acknowledged).toBeUndefined();
    expect(report.scopes.server.level).toBe("critical");
  });

  it("desmarcar volta ao normal; desmarcar sem marcação não faz nada", async () => {
    const { service } = make();
    await service.check(DOMAIN, { manual: false });
    await service.acknowledge(DOMAIN, "ptr", { reason: "x" });
    const state = await service.unacknowledge(DOMAIN, "ptr");
    expect(state.report!.checks.find((c) => c.id === "ptr")?.acknowledged).toBeUndefined();
    expect(state.report!.scopes.server.level).toBe("warn");
    const again = await service.unacknowledge(DOMAIN, "ptr");
    expect(again.report!.scopes.server.level).toBe("warn");
  });

  it("recusa: item que não depende do provedor, domínio inexistente, sem verificação feita e item que está em ordem", async () => {
    const { service } = make();
    await expect(service.acknowledge(DOMAIN, "spf", {})).rejects.toMatchObject({ statusCode: 422, code: "not_acknowledgeable" });
    await expect(service.unacknowledge(DOMAIN, "spf")).rejects.toMatchObject({ statusCode: 422, code: "not_acknowledgeable" });
    await expect(service.acknowledge("nao.existe.example", "ptr", {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.unacknowledge("nao.existe.example", "ptr")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.acknowledge(DOMAIN, "ptr", {})).rejects.toMatchObject({ statusCode: 409, code: "health_not_checked" });
    ptr = { status: "found", found: [HOST] };
    const ok = make();
    await ok.service.check(DOMAIN, { manual: false });
    await expect(ok.service.acknowledge(DOMAIN, "ptr", {})).rejects.toMatchObject({ statusCode: 409, code: "nothing_to_acknowledge" });
  });

  it("arquivo das marcações ilegível não derruba a tela: tudo conta como antes", async () => {
    const broken = { all: vi.fn(async () => Promise.reject(new Error("disco"))), set: vi.fn(), remove: vi.fn() };
    const { service } = make({ acks: broken as never });
    const report = await service.check(DOMAIN, { manual: false });
    expect(report.scopes.server.level).toBe("warn");
    expect((await service.state(DOMAIN)).report!.scopes.server.level).toBe("warn");
  });

  it("sem arquivo injetado, as marcações ficam em memória (inclusive remover)", async () => {
    const { service } = make({ acks: undefined });
    await service.check(DOMAIN, { manual: false });
    const marked = await service.acknowledge(DOMAIN, "ptr", {});
    expect(marked.report!.scopes.server.level).toBe("ok");
    expect((await service.unacknowledge(DOMAIN, "ptr")).report!.scopes.server.level).toBe("warn");
    expect((await service.unacknowledge(DOMAIN, "ptr")).report!.scopes.server.level).toBe("warn");
  });

  it("estado do certificado de mta-sts.<domínio> chega à verificação: 'certificado sendo emitido'", async () => {
    const resolver: DnsResolverLike = {
      ...emptyResolver(),
      resolveTxt: (name) => (name.startsWith("_mta-sts.") ? Promise.resolve([["v=STSv1; id=1"]]) : nf()),
      resolve4: (name) => (name.startsWith("mta-sts.") ? Promise.resolve([IP]) : nf()),
    };
    const certState = vi.fn(async () => "issuing" as const);
    const { service } = make({ resolvers: () => [{ label: "falso", resolver }], certState });
    const report = await service.check(DOMAIN, { manual: false });
    expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "optional", code: "cert_pending" });
    expect(certState).toHaveBeenCalledWith(`mta-sts.${DOMAIN}`);
  });
});

describe("rotas de ciente", () => {
  const TOKEN = "token-de-teste";
  const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
  let ctx: AuthTestContext;
  let app: FastifyInstance;
  let health: { state: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn>; acknowledge: ReturnType<typeof vi.fn>; unacknowledge: ReturnType<typeof vi.fn> };
  const STATE = { plan: { domain: DOMAIN }, report: null };
  const url = (id: string) => `/api/mail/domains/${DOMAIN}/health/ack/${id}`;

  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    health = { state: vi.fn(), check: vi.fn(), acknowledge: vi.fn(async () => STATE), unacknowledge: vi.fn(async () => STATE) };
    await app.register(rateLimit, { global: false });
    await app.register(async (scope) => {
      registerErrorHandler(scope);
      mailHealthRoutes(scope, health as never);
    });
  });
  afterEach(async () => {
    await closeAuthTestApp(ctx);
  });

  it("exigem sessão", async () => {
    expect((await app.inject({ method: "PUT", url: url("ptr") })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: url("ptr") })).statusCode).toBe(401);
  });

  it("PUT marca com motivo, audita (com o motivo) e devolve o estado", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "PUT", url: url("ptr"), headers: auth, payload: { reason: " peço depois " } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATE);
    expect(health.acknowledge).toHaveBeenCalledWith(DOMAIN, "ptr", { reason: " peço depois ", by: null });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mail.health.ack", target: "ptr", detail: expect.stringContaining("motivo: peço depois") }),
    );
  });

  it("PUT sem corpo marca sem motivo", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "PUT", url: url("port25"), headers: auth });
    expect(res.statusCode).toBe(200);
    expect(health.acknowledge).toHaveBeenCalledWith(DOMAIN, "port25", { reason: null, by: null });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.health.ack", detail: expect.not.stringContaining("motivo") }));
  });

  it("PUT recusa motivo grande demais, campo extra e id fora do padrão", async () => {
    expect((await app.inject({ method: "PUT", url: url("ptr"), headers: auth, payload: { reason: "x".repeat(301) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: url("ptr"), headers: auth, payload: { outro: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: url("PTR;rm"), headers: auth })).statusCode).toBe(400);
    expect(health.acknowledge).not.toHaveBeenCalled();
  });

  it("DELETE desmarca e audita", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "DELETE", url: url("ptr"), headers: auth });
    expect(res.statusCode).toBe(200);
    expect(health.unacknowledge).toHaveBeenCalledWith(DOMAIN, "ptr");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.health.unack", target: "ptr" }));
  });

  it("erros do serviço viram resposta com código (422, 409, 404)", async () => {
    health.acknowledge.mockRejectedValueOnce(Object.assign(new Error("Só o provedor."), { statusCode: 422, code: "not_acknowledgeable" }));
    let res = await app.inject({ method: "PUT", url: url("spf"), headers: auth });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "not_acknowledgeable" });
    health.acknowledge.mockRejectedValueOnce(Object.assign(new Error("Verifique antes."), { statusCode: 409, code: "health_not_checked" }));
    res = await app.inject({ method: "PUT", url: url("ptr"), headers: auth });
    expect(res.statusCode).toBe(409);
    health.unacknowledge.mockRejectedValueOnce(Object.assign(new Error("Não cadastrado."), { statusCode: 404, code: "domain_not_found" }));
    res = await app.inject({ method: "DELETE", url: url("ptr"), headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("só admin: token de escopo write ou read não marca nem desmarca; admin sim", () => {
    for (const method of ["PUT", "DELETE"]) {
      expect(classifyRoute(method, "/api/mail/domains/:domain/health/ack/:id")).toEqual({ kind: "scope", scope: "admin" });
    }
    // a verificação em si segue sendo de escrita comum
    expect(classifyRoute("POST", "/api/mail/domains/:domain/health/check")).toEqual({ kind: "scope", scope: "write" });
  });
});
