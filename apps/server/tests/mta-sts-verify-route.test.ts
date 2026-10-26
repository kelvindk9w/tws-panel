/**
 * Botão "Verificar" da caixa do MTA-STS (POST /api/mail/domains/:domain/mta-sts/verify): só admin, com limite de
 * taxa e auditoria; e a ponte entre o serviço de saúde e os ids anteriores da política (TXT com o id antigo é
 * aceito por um prazo). Sem rede, sem Docker.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type MtaStsVerifyResponse } from "@paas/core";
import { mtaStsId, mtaStsPolicy, type DnsResolverLike, type PlanInput, type Port25Result } from "@paas/mailer";
import { mailHealthRoutes } from "../src/routes/mail-health.js";
import { MailHealthService } from "../src/services/mail-health-service.js";
import { MtaStsIdStore } from "../src/services/mail-health-ack-store.js";
import { MtaStsPublisher } from "../src/services/mta-sts-publisher.js";
import { classifyRoute } from "../src/services/token-policy.js";
import { EXPECTED_ROUTE_ACCESS, EXPECTED_ROUTE_REACH } from "../src/services/token-policy-table.js";
import { httpError } from "../src/services/http-error.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const DOMAIN = "envio.example.com";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";
const URL = `/api/mail/domains/${DOMAIN}/mta-sts/verify`;

const RESULT: MtaStsVerifyResponse = {
  domain: DOMAIN,
  checkedAt: "2026-10-26T12:00:00.000Z",
  state: "issuing",
  progress: { a: true, txt: true, policy: false },
  missing: [],
  idGrace: false,
  published: true,
  issuanceTriggered: true,
  certificate: "issuing",
  retryAfter: 6,
  check: null,
  health: null,
  warmLimitUntil: null,
};

describe("rota do botão Verificar do MTA-STS", () => {
  let ctx: AuthTestContext;
  let app: FastifyInstance;
  let mtaSts: { verify: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    mtaSts = { verify: vi.fn(async () => RESULT) };
    await app.register(rateLimit, { global: false });
    await app.register(async (scope) => {
      registerErrorHandler(scope);
      mailHealthRoutes(scope, { state: vi.fn(), check: vi.fn(), acknowledge: vi.fn(), unacknowledge: vi.fn() } as never, mtaSts as never);
    });
  });
  afterEach(async () => {
    await closeAuthTestApp(ctx);
  });

  it("exige sessão", async () => {
    expect((await app.inject({ method: "POST", url: URL })).statusCode).toBe(401);
    expect(mtaSts.verify).not.toHaveBeenCalled();
  });

  it("verifica só este item, devolve o resultado e audita a ação com o que foi feito", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RESULT);
    expect(mtaSts.verify).toHaveBeenCalledWith(DOMAIN);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mail.mta_sts.verify",
        target: DOMAIN,
        detail: expect.stringMatching(/issuing.*nome registrado no proxy.*emissão do certificado disparada/),
      }),
    );
  });

  it("a auditoria cita os registros de DNS que faltam (só os nomes, nunca valores)", async () => {
    mtaSts.verify.mockResolvedValueOnce({
      ...RESULT,
      state: "waiting_dns",
      published: false,
      issuanceTriggered: false,
      missing: [{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=abc" }],
    });
    const record = vi.spyOn(app.auditService, "record");
    await app.inject({ method: "POST", url: URL, headers: auth });
    const detail = (record.mock.calls[0]?.[0] as { detail: string }).detail;
    expect(detail).toContain(`falta no DNS: _mta-sts.${DOMAIN}`);
    expect(detail).not.toContain("v=STSv1");
    expect(detail).not.toContain("registrado no proxy");
  });

  it("o acompanhamento (followUp) não enche a auditoria; o fim ativo e qualquer recarga do proxy ou emissão disparada são registrados", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const quiet = { ...RESULT, published: false, issuanceTriggered: false };
    mtaSts.verify.mockResolvedValueOnce(quiet);
    let res = await app.inject({ method: "POST", url: URL, headers: auth, payload: { followUp: true } });
    expect(res.statusCode).toBe(200);
    expect(record).not.toHaveBeenCalled();
    mtaSts.verify.mockResolvedValueOnce({ ...quiet, state: "active", retryAfter: null });
    res = await app.inject({ method: "POST", url: URL, headers: auth, payload: { followUp: true } });
    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.mta_sts.verify", detail: expect.stringContaining("active") }));
    // mandar followUp: true não esconde a ação: o painel recarregou o proxy / disparou a emissão
    record.mockClear();
    mtaSts.verify.mockResolvedValueOnce({ ...quiet, published: true });
    await app.inject({ method: "POST", url: URL, headers: auth, payload: { followUp: true } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("nome registrado no proxy") }));
    record.mockClear();
    mtaSts.verify.mockResolvedValueOnce({ ...quiet, issuanceTriggered: true });
    await app.inject({ method: "POST", url: URL, headers: auth, payload: { followUp: true } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("emissão do certificado disparada") }));
  });

  it("o teto de tentativas de emissão do botão aparece na auditoria", async () => {
    mtaSts.verify.mockResolvedValueOnce({ ...RESULT, published: false, issuanceTriggered: false, retryAfter: null, warmLimitUntil: "2026-10-26T13:00:00.000Z" });
    const record = vi.spyOn(app.auditService, "record");
    await app.inject({ method: "POST", url: URL, headers: auth });
    expect((record.mock.calls[0]?.[0] as { detail: string }).detail).toContain("limite de tentativas de emissão por hora");
  });

  it("corpo com campo desconhecido e domínio fora do padrão são recusados antes do serviço", async () => {
    expect((await app.inject({ method: "POST", url: URL, headers: auth, payload: { outro: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/mail/domains/exemplo.com%3Brm/mta-sts/verify`, headers: auth })).statusCode).toBe(400);
    expect(mtaSts.verify).not.toHaveBeenCalled();
  });

  it("limite do serviço vira 429 com Retry-After (cabeçalho e corpo) e não grava auditoria", async () => {
    const err = httpError(429, "mta_sts_verify_too_soon", "Espere 3 s.");
    err.details = { retryAfter: 3 };
    mtaSts.verify.mockRejectedValueOnce(err);
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.json()).toMatchObject({ error: "mta_sts_verify_too_soon", retryAfter: 3 });
    expect(record).not.toHaveBeenCalled();
  });

  it("domínio não cadastrado vira 404; erro inesperado vira 500 sem vazar detalhe", async () => {
    mtaSts.verify.mockRejectedValueOnce(httpError(404, "domain_not_found", "Não cadastrado."));
    expect((await app.inject({ method: "POST", url: URL, headers: auth })).statusCode).toBe(404);
    mtaSts.verify.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "POST", url: URL, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
  });

  it("a rota tem limite de taxa próprio: passada a cota por minuto, 429", async () => {
    let last = 200;
    for (let i = 0; i < 21; i += 1) last = (await app.inject({ method: "POST", url: URL, headers: auth })).statusCode;
    expect(last).toBe(429);
  });

  it("só admin: token de escopo read ou write não usa o botão (a emissão de certificado é ação de admin)", () => {
    expect(classifyRoute("POST", "/api/mail/domains/:domain/mta-sts/verify")).toEqual({ kind: "scope", scope: "admin" });
    expect(EXPECTED_ROUTE_ACCESS["POST /api/mail/domains/:domain/mta-sts/verify"]).toBe("admin");
    expect(EXPECTED_ROUTE_REACH["POST /api/mail/domains/:domain/mta-sts/verify"]).toBe("panel");
  });
});

describe("saúde do e-mail: id antigo do TXT aceito por um prazo", () => {
  let dir: string;
  let clock: number;
  const nf = () => Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
  const PLAN: PlanInput = { domain: DOMAIN, mailHostname: HOST, serverHostname: HOST, serverIp: IP, dkimSelector: "paas", dkimPublicKey: "AAAA", dmarcStage: "none" };
  const ID = mtaStsId(mtaStsPolicy(HOST));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-mta-ids-"));
    clock = Date.parse("2026-10-26T12:00:00Z");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resolver = (txt: string): DnsResolverLike => ({
    resolve4: async (name) => (name.startsWith("mta-sts.") ? [IP] : nf()),
    resolve6: nf,
    resolveMx: async () => [{ exchange: HOST, priority: 10 }],
    resolveTxt: async (name) => (name.startsWith("_mta-sts.") ? [[txt]] : nf()),
    reverse: nf,
  });

  function make(txt: string, ids: MtaStsIdStore, remove?: (d: string) => Promise<void>) {
    return new MailHealthService({
      planInput: async () => PLAN,
      verify: vi.fn(async () => ({ ptr: { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null } }) as never),
      tls: vi.fn(async () => ({ checkedAt: "x", serverRunning: true, syncError: null, hosts: [] })),
      blacklist: vi.fn(async () => null),
      queue: vi.fn(async () => []),
      resolvers: () => [{ label: "falso", resolver: resolver(txt) }],
      probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
      fetchPolicy: vi.fn(async () => mtaStsPolicy(HOST).replace(/\r\n/g, "\n")),
      isProxyIp: () => false,
      ids: remove ? { observe: (d, id) => ids.observe(d, id), remove } : ids,
      now: () => clock,
    });
  }

  it("a política mudou: o TXT com o id anterior vira 'ativo' (id_grace) por um dia e depois 'id desatualizado'", async () => {
    const ids = new MtaStsIdStore(dir, () => clock);
    await ids.observe(DOMAIN, "idantigo0000000a"); // o painel esperava este id antes da mudança
    const service = make("v=STSv1; id=idantigo0000000a", ids);
    const within = await service.check(DOMAIN, { manual: false });
    expect(within.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "info", code: "id_grace", expected: `v=STSv1; id=${ID}` });
    clock += 25 * 60 * 60 * 1000;
    const after = await service.check(DOMAIN, { manual: false });
    expect(after.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "optional", code: "id_outdated" });
  });

  it("TXT com o id atual: ativo (ok), sem lembrete", async () => {
    const service = make(`v=STSv1; id=${ID}`, new MtaStsIdStore(dir, () => clock));
    const report = await service.check(DOMAIN, { manual: false });
    expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "ok", code: "testing" });
  });

  it("arquivo de ids que falha não derruba a verificação; remover o domínio esquece os ids", async () => {
    const broken = new MailHealthService({
      planInput: async () => PLAN,
      verify: vi.fn(async () => ({ ptr: { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null } }) as never),
      tls: vi.fn(async () => ({ checkedAt: "x", serverRunning: true, syncError: null, hosts: [] })),
      blacklist: vi.fn(async () => null),
      queue: vi.fn(async () => []),
      resolvers: () => [{ label: "falso", resolver: resolver(`v=STSv1; id=${ID}`) }],
      probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
      fetchPolicy: vi.fn(async () => null),
      isProxyIp: () => false,
      ids: { observe: async () => { throw new Error("disco cheio"); } },
    });
    await expect(broken.check(DOMAIN, { manual: false })).resolves.toBeDefined();
    const remove = vi.fn(async () => undefined);
    await make(`v=STSv1; id=${ID}`, new MtaStsIdStore(dir), remove).forgetDomain(DOMAIN);
    expect(remove).toHaveBeenCalledWith(DOMAIN);
  });
});

describe("Verificar: o item MTA-STS é avaliado pela mesma regra da saúde (nunca fabricado)", () => {
  const nf = () => Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
  const PLAN: PlanInput = { domain: DOMAIN, mailHostname: HOST, serverHostname: HOST, serverIp: IP, dkimSelector: "paas", dkimPublicKey: "AAAA", dmarcStage: "none" };
  const ID = mtaStsId(mtaStsPolicy(HOST));
  const SERVED = mtaStsPolicy(HOST).replace(/\r\n/g, "\n");
  const enforceOther = "version: STSv1\nmode: enforce\nmx: outro.provedor.example.net\nmax_age: 86400\n";

  interface Scenario {
    txt?: string | "fail" | null;
    a?: string[];
    policy?: string | null;
    mx?: "ok" | "fail";
    mxHost?: string;
    certState?: "valid" | "unknown";
  }

  function build(sc: Scenario) {
    const onMtaSts = vi.fn();
    const resolver: DnsResolverLike = {
      resolve4: async (name) => (name.startsWith("mta-sts.") && (sc.a ?? [IP]).length > 0 ? (sc.a ?? [IP]) : nf()),
      resolve6: nf,
      resolveMx: async () => (sc.mx === "fail" ? Promise.reject(Object.assign(new Error("t"), { code: "ETIMEOUT" })) : [{ exchange: sc.mxHost ?? HOST, priority: 10 }]),
      resolveTxt: async (name) => {
        if (!name.startsWith("_mta-sts.")) return nf();
        if (sc.txt === "fail") return Promise.reject(Object.assign(new Error("t"), { code: "ETIMEOUT" }));
        return sc.txt === null ? nf() : [[sc.txt ?? `v=STSv1; id=${ID}`]];
      },
      reverse: nf,
    };
    const health = new MailHealthService({
      planInput: async () => PLAN,
      verify: vi.fn(async () => ({ ptr: { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null } }) as never),
      tls: vi.fn(async () => ({ checkedAt: "x", serverRunning: true, syncError: null, hosts: [] })),
      blacklist: vi.fn(async () => null),
      queue: vi.fn(async () => []),
      resolvers: () => [{ label: "falso", resolver }],
      probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
      fetchPolicy: vi.fn(async () => (sc.policy === undefined ? SERVED : sc.policy)),
      isProxyIp: () => false,
      onMtaSts,
    });
    const publisher = new MtaStsPublisher({
      domains: async () => [DOMAIN],
      planInput: async () => PLAN,
      publishing: async () => true,
      pointsHere: async () => (sc.a ?? [IP]).includes(IP),
      refreshProxy: async () => undefined,
      fetchPolicy: async () => (sc.policy === undefined ? SERVED : sc.policy),
      certState: async () => sc.certState ?? "unknown",
      resolver: () => resolver,
      isProxyIp: () => false,
      evaluate: (d) => health.refreshMtaSts(d),
      wait: () => new Promise(() => undefined),
    });
    // o publicador acompanha cada avaliação da saúde (como no painel)
    onMtaSts.mockImplementation((d: string, c: { code: string }) => publisher.observe(d, c));
    return { health, publisher, onMtaSts };
  }

  it("política servida e TXT com o id atual: ativo, e o relatório guardado passa a trazer o item novo", async () => {
    const { health, publisher } = build({});
    await health.check(DOMAIN, { manual: false });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("active");
    expect(r.check).toMatchObject({ level: "ok", code: "testing" });
    expect(r.health?.report?.checks.find((c) => c.id === "mta_sts")).toMatchObject({ code: "testing" });
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("DNS curinga / só o A criado: a política abre, mas sem o TXT o estado é 'falta o TXT' (nunca ativo) e a lista e a caixa concordam", async () => {
    const { health, publisher } = build({ txt: null });
    await health.check(DOMAIN, { manual: false });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("missing_txt");
    expect(r.check?.code).toBe("missing_txt");
    expect(r.missing).toEqual([{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: `v=STSv1; id=${ID}` }]);
    expect(publisher.state(DOMAIN)).toBe("missing_txt");
    expect(r.health?.report?.checks.find((c) => c.id === "mta_sts")?.code).toBe("missing_txt");
  });

  it("enforce com MX errado continua CRÍTICO depois do Verificar (o aviso do topo e a contagem acompanham)", async () => {
    const { health, publisher } = build({ policy: enforceOther });
    const before = await health.check(DOMAIN, { manual: false });
    expect(before.level).toBe("critical");
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("attention");
    expect(r.check).toMatchObject({ level: "critical", code: "mx_mismatch", inbox: true });
    expect(r.health?.report?.level).toBe("critical");
    expect(r.health?.report?.inboxIssues).toContain("mta_sts");
    expect(r.idGrace).toBe(false);
  });

  it("política inválida (sem version) não vira ativa", async () => {
    const { publisher } = build({ policy: "mode: testing\nmx: x.example.net\n" });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("attention");
    expect(r.check?.code).toBe("invalid");
  });

  it("política do painel com o MX em outro provedor: 'mx_external', não ativa", async () => {
    const { publisher } = build({ policy: SERVED, mxHost: "mx.outro-provedor.example.net" });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("attention");
    expect(r.check?.code).toBe("mx_external");
  });

  it("consulta do TXT que falha: 'não deu para conferir', nunca ativo", async () => {
    const { publisher } = build({ txt: "fail" });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("unverified");
    expect(r.check?.code).toBe("txt_unavailable");
    expect(r.missing).toEqual([]);
  });

  it("consulta do MX que falha: 'não deu para conferir'", async () => {
    const { publisher } = build({ mx: "fail" });
    const r = await publisher.verify(DOMAIN);
    expect(r.state).toBe("unverified");
    expect(r.check?.code).toBe("mx_unverified");
  });

  it("refreshMtaSts: ids guardados ou leitura de 'publica?' que falham não derrubam a avaliação", async () => {
    const health = new MailHealthService({
      planInput: async () => PLAN,
      verify: vi.fn(),
      tls: vi.fn(),
      blacklist: vi.fn(),
      queue: vi.fn(),
      resolvers: () => [
        {
          label: "falso",
          resolver: {
            resolve4: async () => [IP],
            resolve6: nf,
            resolveMx: async () => [{ exchange: HOST, priority: 10 }],
            resolveTxt: async () => [[`v=STSv1; id=${ID}`]],
            reverse: nf,
          },
        },
      ],
      fetchPolicy: async () => SERVED,
      isProxyIp: () => false,
      ids: { observe: async () => { throw new Error("disco"); } },
      mtaStsPublishing: async () => { throw new Error("x"); },
    });
    expect((await health.refreshMtaSts(DOMAIN)).check.code).toBe("testing");
  });

  it("refreshMtaSts sem relatório guardado devolve o item e o estado sem relatório", async () => {
    const { health } = build({});
    const out = await health.refreshMtaSts(DOMAIN);
    expect(out.check.code).toBe("testing");
    expect(out.state.report).toBeNull();
  });

  it("a verificação completa também avisa o publicador: a lista nunca fica para trás da saúde", async () => {
    const { health, publisher, onMtaSts } = build({ txt: null });
    await health.check(DOMAIN, { manual: false });
    expect(onMtaSts).toHaveBeenCalledWith(DOMAIN, expect.objectContaining({ code: "missing_txt" }));
    expect(publisher.state(DOMAIN)).toBe("missing_txt");
  });
});
