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
import { MailHealthAckStore, MtaStsModeStore } from "../src/services/mail-health-ack-store.js";
import { mailHealthRoutes } from "../src/routes/mail-health.js";
import { classifyRoute } from "../src/services/token-policy.js";
import { isHumanQuota } from "../src/services/audit-service.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";
import { removeDir } from "./helpers/tmp.js";

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
  await removeDir(dir);
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
      mailHealthRoutes(scope, health as never, { verify: vi.fn() } as never);
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

describe("MailHealthService — ciente só em atenção, motivo em uma linha e publicação do MTA-STS", () => {
  it("porta 25 bloqueada é crítica: não pode ser marcada; 'não deu para testar' (atenção) pode", async () => {
    const blocked = make({ probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "blocked", detail: "ETIMEDOUT" })) });
    await blocked.service.check(DOMAIN, { manual: false });
    await expect(blocked.service.acknowledge(DOMAIN, "port25", {})).rejects.toMatchObject({ statusCode: 409, code: "nothing_to_acknowledge" });
    const unknown = make({ probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "error", detail: "x" })) });
    await unknown.service.check(DOMAIN, { manual: false });
    const state = await unknown.service.acknowledge(DOMAIN, "port25", {});
    expect(state.report?.checks.find((c) => c.id === "port25")?.acknowledged).toBeDefined();
  });

  it("o motivo vira uma linha só (quebras e espaços repetidos viram um espaço)", async () => {
    const { service } = make();
    await service.check(DOMAIN, { manual: false });
    const state = await service.acknowledge(DOMAIN, "ptr", { reason: "  peço ao\n suporte\r\n\r\n  depois\t ok " });
    expect(state.report?.checks.find((c) => c.id === "ptr")?.acknowledged?.reason).toBe("peço ao suporte depois ok");
  });

  it("sem o domínio do painel (publicação indisponível) o item MTA-STS diz isso; com falha na consulta, segue como se publicasse", async () => {
    const off = make({ mtaStsPublishing: async () => false });
    const report = await off.service.check(DOMAIN, { manual: false });
    expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "optional", code: "publish_unavailable" });
    const broken = make({
      mtaStsPublishing: async () => {
        throw new Error("x");
      },
    });
    expect((await broken.service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("absent");
  });
});

describe("auditoria do ciente: cota humana x cota de token", () => {
  const entry = (action: string, actor: string) => ({ id: "1", at: "2026-10-26T00:00:00Z", actor, action, target: "ptr", detail: "" });

  it("marcar e desmarcar como pessoa cai na cota humana da auditoria; como token, na cota de token", () => {
    for (const action of ["mail.health.ack", "mail.health.unack"]) {
      expect(isHumanQuota(entry(action, "kelvin"))).toBe(true);
      expect(isHumanQuota(entry(action, "token:ia"))).toBe(false);
      expect(isHumanQuota(entry(action, "setup-token"))).toBe(false);
    }
  });
});

describe("MailHealthService — modo da última leitura boa do MTA-STS", () => {
  const POLICY = `version: STSv1\nmode: enforce\nmx: ${HOST}\nmax_age: 86400`;
  const withTxtAndA = (): DnsResolverLike => ({
    ...emptyResolver(),
    resolveMx: async () => [{ exchange: HOST, priority: 10 }],
    resolveTxt: async (name: string) => {
      if (name === `_mta-sts.${DOMAIN}`) return [["v=STSv1; id=minha"]];
      throw Object.assign(new Error("nf"), { code: "ENOTFOUND" });
    },
    resolve4: async (name: string) => {
      if (name === `mta-sts.${DOMAIN}`) return [IP];
      throw Object.assign(new Error("nf"), { code: "ENOTFOUND" });
    },
  });

  it("guarda o modo quando a política abre e avisa se depois ela deixar de abrir (em memória e em arquivo)", async () => {
    let policy: string | null = POLICY;
    const modes = new MtaStsModeStore(dir);
    const { service } = make({ resolvers: () => [{ label: "falso", resolver: withTxtAndA() }], fetchPolicy: vi.fn(async () => policy), modes });
    expect((await service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")).toMatchObject({ code: "enforce" });
    expect(await modes.get(DOMAIN)).toBe("enforce");
    policy = null;
    clock += 120_000;
    expect((await service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "warn", code: "enforce_lapsed" });
    // depois de reiniciar o painel (serviço novo, mesmo arquivo) o aviso continua
    const again = make({ resolvers: () => [{ label: "falso", resolver: withTxtAndA() }], fetchPolicy: vi.fn(async () => null), modes: new MtaStsModeStore(dir) });
    expect((await again.service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("enforce_lapsed");
  });

  it("sem arquivo (só memória) o modo também vale; falha ao gravar ou ler o arquivo não derruba a verificação", async () => {
    let policy: string | null = POLICY;
    const { service } = make({ resolvers: () => [{ label: "falso", resolver: withTxtAndA() }], fetchPolicy: vi.fn(async () => policy) });
    await service.check(DOMAIN, { manual: false });
    policy = null;
    clock += 120_000;
    expect((await service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("enforce_lapsed");
    const logs: string[] = [];
    const broken = make({
      resolvers: () => [{ label: "falso", resolver: withTxtAndA() }],
      fetchPolicy: vi.fn(async () => POLICY),
      modes: {
        get: async () => {
          throw new Error("x");
        },
        set: async () => {
          throw new Error("disco cheio");
        },
      },
      log: (m: string) => logs.push(m),
    });
    expect((await broken.service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("enforce");
    expect(logs.join()).toContain("disco cheio");
  });

  it("TXT removido apaga o modo guardado; domínio removido também; um recadastro não herda o enforce antigo", async () => {
    let policy: string | null = POLICY;
    let zone = withTxtAndA();
    const modes = new MtaStsModeStore(dir);
    const { service } = make({ resolvers: () => [{ label: "falso", resolver: zone }], fetchPolicy: vi.fn(async () => policy), modes });
    await service.check(DOMAIN, { manual: false });
    expect(await modes.get(DOMAIN)).toBe("enforce");
    // o TXT some: o item diz 'absent' e o modo é esquecido
    zone = emptyResolver();
    policy = null;
    clock += 120_000;
    expect((await service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("absent");
    expect(await modes.get(DOMAIN)).toBeNull();
    // meses depois o TXT volta e a política ainda não abre: a causa, sem o falso 'enforce_lapsed'
    zone = withTxtAndA();
    clock += 120_000;
    expect((await service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("unreachable");
    // domínio removido
    policy = POLICY;
    clock += 120_000;
    await service.check(DOMAIN, { manual: false });
    expect(await modes.get(DOMAIN)).toBe("enforce");
    await service.forgetDomain(DOMAIN);
    expect(await modes.get(DOMAIN)).toBeNull();
    expect((await service.state(DOMAIN)).report).toBeNull();
  });

  it("TXT com timeout NÃO apaga o enforce guardado; MX com timeout grava o modo da política que abriu", async () => {
    const modes = new MtaStsModeStore(dir);
    await modes.set(DOMAIN, "enforce");
    const flaky: DnsResolverLike = {
      ...withTxtAndA(),
      resolveTxt: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      },
    };
    const first = make({ resolvers: () => [{ label: "falso", resolver: flaky }], fetchPolicy: vi.fn(async () => POLICY), modes });
    expect((await first.service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")?.code).toBe("txt_unavailable");
    expect(await modes.get(DOMAIN)).toBe("enforce");
    // MX com timeout, sem modo guardado: a política abriu em enforce e o modo passa a ser guardado
    await modes.remove(DOMAIN);
    const noMx: DnsResolverLike = {
      ...withTxtAndA(),
      resolveMx: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      },
    };
    const second = make({ resolvers: () => [{ label: "falso", resolver: noMx }], fetchPolicy: vi.fn(async () => POLICY), modes });
    expect((await second.service.check(DOMAIN, { manual: false })).checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "warn", code: "mx_unverified" });
    expect(await modes.get(DOMAIN)).toBe("enforce");
  });

  it("arquivo dos modos torto é ignorado; só testing e enforce valem", async () => {
    await writeFile(path.join(dir, "mail-health-mta-sts-modes.json"), JSON.stringify({ [DOMAIN]: "enforce", x: "qualquer" }));
    const store = new MtaStsModeStore(dir);
    expect(await store.get(DOMAIN)).toBe("enforce");
    expect(await store.get("x")).toBeNull();
    await writeFile(path.join(dir, "mail-health-mta-sts-modes.json"), "[]");
    expect(await new MtaStsModeStore(dir).get(DOMAIN)).toBeNull();
    await store.set(DOMAIN, "testing");
    await store.set(DOMAIN, "testing");
    expect(await store.get(DOMAIN)).toBe("testing");
  });
});
