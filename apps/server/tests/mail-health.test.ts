/**
 * Saúde de entregabilidade (mail-health-service.ts e rotas /health): plano de
 * registros, verificação com resolvedores falsos, intervalo mínimo, cache da
 * sonda da porta 25 e validação das rotas. Sem rede, sem Docker, sem Stalwart.
 */
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETUP_TOKEN_HEADER,
  type BlacklistCheckResponse,
  type DnsVerifyResponse,
  type MailTlsStatusResponse,
} from "@paas/core";
import type { DnsResolverLike, PlanInput, Port25Result, QueueItemView } from "@paas/mailer";
import { HEALTH_MAX_MANUAL_PER_MINUTE, HEALTH_MIN_INTERVAL_MS, MailHealthService, normalizeDomain, PORT25_CACHE_MS } from "../src/services/mail-health-service.js";
import { mailHealthRoutes } from "../src/routes/mail-health.js";
import { httpError } from "../src/services/http-error.js";
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

function emptyResolver(): DnsResolverLike {
  const nf = () => Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
  return { resolve4: nf, resolve6: nf, resolveMx: nf, resolveTxt: nf, reverse: nf };
}

const VERIFY = {
  ptr: { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null },
} as unknown as DnsVerifyResponse;

const TLS: MailTlsStatusResponse = {
  checkedAt: "2026-10-22T00:00:00Z",
  serverRunning: true,
  syncError: null,
  hosts: [
    {
      host: HOST,
      ok: true,
      issuer: "R3",
      validTo: "2027-01-01T00:00:00Z",
      error: null,
      issued: true,
      dns: { status: "ok", resolved: [IP], expectedIp: IP },
      hint: null,
    },
  ],
};

const LISTED: BlacklistCheckResponse = {
  checkedAt: "x",
  ip: { target: IP, results: [{ dnsbl: "z", label: "Spamhaus ZEN", status: "listed", detail: null, removalUrl: null }] },
  domains: [],
  listedCount: 1,
};

let clock = Date.parse("2026-10-22T12:00:00Z");

function make(over: Partial<ConstructorParameters<typeof MailHealthService>[0]> = {}) {
  const deps = {
    planInput: vi.fn(async (domain: string) => {
      if (domain !== DOMAIN) throw httpError(404, "domain_not_found", "Domínio não cadastrado.");
      return PLAN;
    }),
    verify: vi.fn(async () => VERIFY),
    tls: vi.fn(async () => TLS),
    blacklist: vi.fn(async (): Promise<BlacklistCheckResponse | null> => LISTED),
    queue: vi.fn(async (): Promise<QueueItemView[]> => []),
    resolvers: () => [{ label: "falso", resolver: emptyResolver() }],
    probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "blocked", detail: "ETIMEDOUT" })),
    fetchPolicy: vi.fn(async () => null),
    isProxyIp: () => false,
    log: vi.fn(),
    now: () => clock,
    ...over,
  };
  return { service: new MailHealthService(deps), deps };
}

beforeEach(() => {
  clock = Date.parse("2026-10-22T12:00:00Z");
});

describe("MailHealthService", () => {
  it("plano: registros na ordem e PTR esperado", async () => {
    const { service } = make();
    const plan = await service.plan(DOMAIN);
    expect(plan.records[0]).toMatchObject({ id: "a", name: HOST, value: IP, proxied: false });
    expect(plan.ptr.expected).toBe(HOST);
  });

  it("estado: sem verificação ainda, depois com a última", async () => {
    const { service } = make();
    expect((await service.state(DOMAIN)).report).toBeNull();
    expect(service.summary()).toEqual([]);
    await service.check(DOMAIN, { manual: true });
    const state = await service.state(DOMAIN);
    expect(state.report?.domain).toBe(DOMAIN);
    expect(service.summary()).toEqual([{ domain: DOMAIN, level: "critical", checkedAt: "2026-10-22T12:00:00.000Z" }]);
  });

  it("verificação junta DNS, PTR, porta 25, certificado e listas", async () => {
    const { service, deps } = make();
    const report = await service.check(DOMAIN, { manual: true });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.spf).toMatchObject({ level: "critical", code: "missing" });
    expect(byId.ptr?.level).toBe("ok");
    expect(byId.port25).toMatchObject({ level: "critical", code: "blocked" });
    expect(byId.tls?.level).toBe("ok");
    expect(byId.dnsbl).toMatchObject({ level: "critical", code: "listed" });
    expect(report.level).toBe("critical");
    expect(report.inboxIssues).toEqual(expect.arrayContaining(["spf", "port25", "dnsbl"]));
    expect(deps.verify).toHaveBeenCalledWith(DOMAIN);
  });

  it("dados por projeto: cada domínio tem o seu relatório e o seu resumo; o servidor (porta 25) é um só", async () => {
    const OTHER = "loja.example.org";
    const { service, deps } = make({
      planInput: vi.fn(async (domain: string) => {
        if (domain === DOMAIN) return PLAN;
        if (domain === OTHER) return { ...PLAN, domain: OTHER, mailHostname: `mail.${OTHER}` };
        throw httpError(404, "domain_not_found", "Domínio não cadastrado.");
      }),
    });
    const a = await service.check(DOMAIN, { manual: true });
    const b = await service.check(OTHER, { manual: true });
    expect(a.domain).toBe(DOMAIN);
    expect(b.domain).toBe(OTHER);
    // a sonda da porta 25 é do servidor: uma só para os dois projetos
    expect(deps.probePort25).toHaveBeenCalledTimes(1);
    for (const r of [a, b]) {
      expect(r.scopes.server.level).toBe("critical"); // porta 25 e listas de bloqueio
      expect(r.scopes.domain.level).toBe("critical"); // SPF/DKIM/DMARC ausentes no DNS falso
      expect(r.checks.filter((c) => ["ptr", "port25", "tls", "dnsbl", "queue"].includes(c.id)).length).toBe(5);
    }
    // o relatório de um domínio não aparece no estado do outro
    expect((await service.state(DOMAIN)).report?.domain).toBe(DOMAIN);
    expect((await service.state(OTHER)).report?.domain).toBe(OTHER);
    expect(service.summary().map((s) => s.domain).sort()).toEqual([OTHER, DOMAIN].sort());
  });

  it("fila adiada por falha de autenticação do PRÓPRIO domínio é do domínio, não do servidor", async () => {
    const authQueue: QueueItemView[] = [
      {
        id: "1",
        from: `contato@${DOMAIN}`,
        createdAt: null,
        size: 10,
        recipients: [{ address: "x@gmail.com", domain: "gmail.com", state: "deferred", detail: "x" }],
        attempts: 2,
        nextRetryAt: null,
        expiresAt: null,
        lastError: "550 5.7.26 Unauthenticated email is not accepted",
      },
    ];
    const { service } = make({
      queue: vi.fn(async () => authQueue),
      verify: vi.fn(async () => ({ ptr: { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null } }) as unknown as DnsVerifyResponse),
      probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
      blacklist: vi.fn(async () => null),
    });
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "queue")).toMatchObject({ level: "critical", code: "deferred_auth" });
    expect(report.scopes.domain.level).toBe("critical");
    expect(report.scopes.server.level).toBe("ok");
    expect(report.scopes.server.counts.critical).toBe(0);
  });

  it("quatro grafias do mesmo domínio contam como uma só verificação e uma só espera", async () => {
    const { service, deps } = make();
    const spellings = [DOMAIN, DOMAIN.toUpperCase(), `${DOMAIN}.`, ` ${DOMAIN[0]!.toUpperCase()}${DOMAIN.slice(1)}.. `];
    const results = await Promise.all(spellings.map((d) => service.check(d, { manual: true })));
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.domain)).size).toBe(1);
    // depois, qualquer grafia esbarra no mesmo intervalo mínimo
    for (const d of spellings) await expect(service.check(d, { manual: true })).rejects.toMatchObject({ statusCode: 429, code: "health_check_too_soon" });
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect((await service.state(DOMAIN.toUpperCase())).report?.domain).toBe(DOMAIN);
  });

  it("normalizeDomain: minúsculas, sem espaços e sem ponto final", () => {
    expect(normalizeDomain(" Loja.Example.COM.. ")).toBe("loja.example.com");
    expect(normalizeDomain("a.b")).toBe("a.b");
  });

  it("limite do servidor: no máximo N verificações do botão por minuto, somando todos os domínios; a diária não conta", async () => {
    const { service } = make({ planInput: vi.fn(async (domain: string) => ({ ...PLAN, domain, mailHostname: `mail.${domain}` })) });
    for (let i = 0; i < HEALTH_MAX_MANUAL_PER_MINUTE; i++) await service.check(`d${i}.example.org`, { manual: true });
    await expect(service.check("outro.example.org", { manual: true })).rejects.toMatchObject({ statusCode: 429, code: "health_check_busy" });
    await expect(service.check("outro.example.org", { manual: true })).rejects.toThrow(/Espere \d+ s/);
    // a rotina diária segue funcionando
    await expect(service.check("outro.example.org", { manual: false })).resolves.toBeDefined();
    // passado um minuto, libera
    clock += 61_000;
    await expect(service.check("outro.example.org", { manual: true })).resolves.toBeDefined();
  });

  it("verificação recusada pelo limite do servidor não gasta a vaga nem a espera do domínio", async () => {
    const { service } = make({ planInput: vi.fn(async (domain: string) => ({ ...PLAN, domain, mailHostname: `mail.${domain}` })) });
    for (let i = 0; i < HEALTH_MAX_MANUAL_PER_MINUTE; i++) await service.check(`d${i}.example.org`, { manual: true });
    await expect(service.check("novo.example.org", { manual: true })).rejects.toMatchObject({ code: "health_check_busy" });
    clock += 61_000;
    // se a recusa tivesse marcado o domínio, aqui viria health_check_too_soon
    await expect(service.check("novo.example.org", { manual: true })).resolves.toBeDefined();
  });

  it("PTR ausente com a porta 25 livre: o servidor fica em atenção, não crítico", async () => {
    const { service } = make({
      verify: vi.fn(async () => ({ ptr: { ip: IP, expected: HOST, status: "action_required", found: [], ticketText: null } }) as unknown as DnsVerifyResponse),
      probePort25: vi.fn(async (): Promise<Port25Result> => ({ status: "open", host: "gmail-smtp-in.l.google.com" })),
      blacklist: vi.fn(async () => null),
    });
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "ptr")).toMatchObject({ level: "warn", code: "missing" });
    expect(report.scopes.server.level).toBe("warn");
  });

  it("não vaza nada além do que o relatório define (sem chave privada, sem segredo)", async () => {
    const { service } = make();
    const text = JSON.stringify(await service.check(DOMAIN, { manual: true }));
    expect(text).not.toMatch(/PRIVATE|adminSecret|password/i);
  });

  it("'Verificar agora' tem intervalo mínimo por domínio; a rotina diária não", async () => {
    const { service } = make();
    await service.check(DOMAIN, { manual: true });
    await expect(service.check(DOMAIN, { manual: true })).rejects.toMatchObject({ statusCode: 429, code: "health_check_too_soon" });
    await expect(service.check(DOMAIN, { manual: false })).resolves.toBeDefined();
    clock += HEALTH_MIN_INTERVAL_MS + 1;
    await expect(service.check(DOMAIN, { manual: true })).resolves.toBeDefined();
  });

  it("pedidos simultâneos viram uma verificação só", async () => {
    const { service, deps } = make();
    const [a, b] = await Promise.all([service.check(DOMAIN, { manual: true }), service.check(DOMAIN, { manual: true })]);
    expect(a).toBe(b);
    expect(deps.verify).toHaveBeenCalledTimes(1);
  });

  it("sonda da porta 25 fica em cache por 10 min, exceto quando não deu para testar", async () => {
    const { service, deps } = make();
    await service.check(DOMAIN, { manual: false });
    await service.check(DOMAIN, { manual: false });
    expect(deps.probePort25).toHaveBeenCalledTimes(1);
    clock += PORT25_CACHE_MS + 1;
    await service.check(DOMAIN, { manual: false });
    expect(deps.probePort25).toHaveBeenCalledTimes(2);

    const failing = make({ probePort25: vi.fn(async () => ({ status: "error", detail: "x" }) as Port25Result) });
    await failing.service.check(DOMAIN, { manual: false });
    await failing.service.check(DOMAIN, { manual: false });
    expect(failing.deps.probePort25).toHaveBeenCalledTimes(2);
  });

  it("certificado ou listas que falham não derrubam a verificação (nem acusam servidor parado)", async () => {
    const { service, deps } = make({
      tls: vi.fn(async () => {
        throw new Error("docker fora do ar");
      }),
      blacklist: vi.fn(async () => {
        throw new Error("sem estado");
      }),
    });
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "tls")?.code).toBe("no_hosts");
    expect(report.checks.find((c) => c.id === "dnsbl")?.code).toBe("not_checked");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("docker fora do ar"));
  });

  it("falha do certificado com erro que não é Error também é registrada", async () => {
    const { service, deps } = make({ tls: vi.fn(() => Promise.reject("texto")) });
    await service.check(DOMAIN, { manual: true });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("texto"));
  });

  it("sem log injetado, a falha do certificado passa em silêncio", async () => {
    const { service } = make({ log: undefined, tls: vi.fn(async () => Promise.reject(new Error("x"))) });
    await expect(service.check(DOMAIN, { manual: true })).resolves.toBeDefined();
  });

  it("domínio que não existe: 404 sem consultar nada", async () => {
    const { service, deps } = make();
    await expect(service.check("outro.exemplo.com", { manual: true })).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("fila que não pôde ser lida não derruba a verificação", async () => {
    const { service } = make({ queue: vi.fn(async () => Promise.reject(new Error("api fora"))) });
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "queue")).toMatchObject({ level: "info", code: "unavailable" });
  });

  it("mensagem adiada na fila vira diagnóstico de atraso", async () => {
    const item: QueueItemView = {
      id: "1",
      from: `loja@${DOMAIN}`,
      createdAt: null,
      size: 1,
      recipients: [{ address: "a@gmail.com", domain: "gmail.com", state: "deferred", detail: null }],
      attempts: 2,
      nextRetryAt: "2026-10-22T12:05:00.000Z",
      expiresAt: null,
      lastError: "421-4.7.28 unusual rate of unsolicited mail",
    };
    const { service } = make({ queue: vi.fn(async () => [item]) });
    const report = await service.check(DOMAIN, { manual: true });
    expect(report.checks.find((c) => c.id === "queue")).toMatchObject({ code: "deferred_rate_limited", level: "warn" });
    expect(report.inboxIssues).toContain("queue");
  });

  it("falha da verificação libera uma nova tentativa", async () => {
    let first = true;
    const { service } = make({
      verify: vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error("caiu");
        }
        return VERIFY;
      }),
    });
    await expect(service.check(DOMAIN, { manual: false })).rejects.toThrow("caiu");
    await expect(service.check(DOMAIN, { manual: false })).resolves.toBeDefined();
  });
});

describe("MailHealthService com os padrões de produção", () => {
  it("usa resolvedores públicos distintos e a busca de política real (sem tocar a rede aqui)", async () => {
    const { service } = make({
      resolvers: undefined,
      probePort25: undefined,
      fetchPolicy: undefined,
      verify: vi.fn(async () => {
        throw new Error("para antes de qualquer consulta de rede");
      }),
    });
    await expect(service.check(DOMAIN, { manual: false })).rejects.toThrow("antes de qualquer");
  });
});

describe("rotas /health", () => {
  const TOKEN = "token-de-teste";
  const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
  let ctx: AuthTestContext;
  let app: FastifyInstance;
  let health: { state: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn> };

  const STATE = { plan: { domain: DOMAIN }, report: null };
  const REPORT = { domain: DOMAIN, level: "ok", checkedAt: "x", counts: { ok: 1, warn: 0, critical: 0 }, checks: [], inboxIssues: [], scopes: { server: { level: "ok", counts: { ok: 0, warn: 0, critical: 0 } }, domain: { level: "ok", counts: { ok: 1, warn: 0, critical: 0 } } } };

  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    health = {
      state: vi.fn(async () => STATE),
      check: vi.fn(async () => REPORT),
    };
    await app.register(rateLimit, { global: false });
    await app.register(async (scope) => {
      registerErrorHandler(scope);
      mailHealthRoutes(scope, health as never);
    });
  });
  afterEach(async () => {
    await closeAuthTestApp(ctx);
  });

  it("exige sessão", async () => {
    expect((await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/health` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/health/check` })).statusCode).toBe(401);
  });

  it("GET devolve o plano e a última verificação", async () => {
    const res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/health`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATE);
  });

  it("POST verifica, audita (sem dados sensíveis) e devolve o relatório novo", async () => {
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/health/check`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().report).toEqual(REPORT);
    expect(health.check).toHaveBeenCalledWith(DOMAIN, { manual: true });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.health.check", target: DOMAIN }));
  });

  it("erros do serviço viram resposta com código (429, 404, 500)", async () => {
    health.check.mockRejectedValueOnce(httpError(429, "health_check_too_soon", "Espere."));
    let res = await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/health/check`, headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "health_check_too_soon" });
    health.state.mockRejectedValueOnce(httpError(404, "domain_not_found", "Não cadastrado."));
    res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/health`, headers: auth });
    expect(res.statusCode).toBe(404);
    health.state.mockRejectedValueOnce(new Error("boom"));
    res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/health`, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
  });

  it("erro sem mensagem nem código: 500 genérico, sem vazar nada", async () => {
    health.state.mockRejectedValueOnce({});
    const res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/health`, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "Erro interno." });
  });

  it("aceita maiúsculas e ponto final (o serviço normaliza), mas continua recusando lixo", async () => {
    for (const ok of [DOMAIN.toUpperCase(), `${DOMAIN}.`]) {
      const res = await app.inject({ method: "GET", url: `/api/mail/domains/${ok}/health`, headers: auth });
      expect(res.statusCode, ok).toBe(200);
    }
    const bad = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}../health`, headers: auth });
    expect(bad.statusCode).toBe(400);
  });

  it("domínio com formato inválido: 400 sem chamar o serviço", async () => {
    for (const bad of ["a b", "x;rm", "-a.com", "127.0.0.1:25@x", "semponto"]) {
      const res = await app.inject({ method: "GET", url: `/api/mail/domains/${encodeURIComponent(bad)}/health`, headers: auth });
      expect(res.statusCode).toBe(400);
    }
    expect(health.state).not.toHaveBeenCalled();
  });

  it("limite de uso do botão: depois de 6 por minuto, 429", async () => {
    let last = 0;
    for (let i = 0; i < 8; i += 1) {
      last = (await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/health/check`, headers: auth })).statusCode;
    }
    expect(last).toBe(429);
  });
});
