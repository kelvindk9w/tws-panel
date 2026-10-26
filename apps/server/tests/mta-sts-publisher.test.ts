/**
 * Publicação do MTA-STS do lado do painel (mta-sts-publisher.ts): o aquecimento da emissão do certificado
 * na criação do domínio e na rodada periódica, e o botão "Verificar" da caixa do item. Sem rede, sem Docker:
 * DNS, proxy e a abertura da política são trocados por fakes; o relógio é controlado.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MTA_STS_ID_GRACE_MS, type DeliveryHealthStateResponse, type MailHealthCheck } from "@paas/core";
import { mtaStsId, mtaStsPolicy, type DnsResolverLike, type MtaStsCertState, type PlanInput } from "@paas/mailer";
import {
  ACTIVE_RECHECK_MS,
  MtaStsPublisher,
  SWEEP_MAX_WARMS,
  VERIFY_MAX_PER_MINUTE,
  VERIFY_MIN_INTERVAL_MS,
  VERIFY_RETRY_SECONDS,
  WARM_COOLDOWN_FAILED_MS,
  WARM_COOLDOWN_MS,
  WARM_MANUAL_COOLDOWN_MS,
  WARM_MANUAL_MAX_PER_HOUR,
  WARM_MAX_PER_HOUR,
  WARM_TIMEOUT_MS,
  type MtaStsPublisherDeps,
} from "../src/services/mta-sts-publisher.js";
import { MtaStsIdStore, MtaStsWarmStore } from "../src/services/mail-health-ack-store.js";

const DOMAIN = "envio.example.com";
const HOST = `mail.${DOMAIN}`;
const STS_HOST = `mta-sts.${DOMAIN}`;
const IP = "203.0.113.10";
const ID = mtaStsId(mtaStsPolicy(HOST));
const TXT = `v=STSv1; id=${ID}`;
const PLAN: PlanInput = {
  domain: DOMAIN,
  mailHostname: HOST,
  serverHostname: HOST,
  serverIp: IP,
  dkimSelector: "paas",
  dkimPublicKey: "AAAA",
  dmarcStage: "none",
};

interface Zone {
  a?: string[] | "fail";
  txt?: string[] | "fail";
}

function resolverOf(zone: { current: Zone }): DnsResolverLike {
  const notFound = () => Object.assign(new Error("nf"), { code: "ENOTFOUND" });
  return {
    async resolve4(name) {
      const a = zone.current.a;
      if (a === "fail") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      if (!name.startsWith("mta-sts.") || !a || a.length === 0) throw notFound();
      return a;
    },
    async resolve6() {
      throw notFound();
    },
    async resolveMx() {
      throw notFound();
    },
    async resolveTxt(name) {
      const txt = zone.current.txt;
      if (txt === "fail") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      if (!name.startsWith("_mta-sts.") || !txt || txt.length === 0) throw notFound();
      return txt.map((r) => [r]);
    },
    async reverse() {
      throw notFound();
    },
  };
}

const OK_CHECK: MailHealthCheck = { id: "mta_sts", level: "ok", inbox: false, code: "testing", params: { mode: "testing" } };
const STATE = { plan: {}, report: null } as unknown as DeliveryHealthStateResponse;

function make(over: Partial<MtaStsPublisherDeps> = {}, zone: Zone = {}) {
  const dns = { current: zone };
  // o item que a "saúde" devolve ao ser reavaliado (o padrão é a política aberta e válida)
  const item = { current: OK_CHECK };
  const clock = { t: Date.parse("2026-10-26T12:00:00Z") };
  const deps = {
    domains: vi.fn(async () => [DOMAIN]),
    planInput: vi.fn(async (d: string) => {
      if (d !== DOMAIN && d !== "outro.example.com") throw Object.assign(new Error("não cadastrado"), { statusCode: 404, code: "domain_not_found" });
      return { ...PLAN, domain: d, mailHostname: `mail.${d}` };
    }),
    publishing: vi.fn(async () => true),
    pointsHere: vi.fn(async () => true),
    refreshProxy: vi.fn(async () => undefined),
    fetchPolicy: vi.fn(async (): Promise<string | null> => null),
    certState: vi.fn(async (): Promise<MtaStsCertState> => "unknown"),
    resolver: () => resolverOf(dns),
    isProxyIp: (ip: string) => ip.startsWith("104.16."),
    evaluate: vi.fn(async () => ({ check: item.current, state: STATE })),
    log: vi.fn(),
    now: () => clock.t,
    // por padrão o limite de espera nunca vence: quem testa a resposta lenta troca por uma espera instantânea
    wait: vi.fn((): Promise<void> => new Promise(() => undefined)),
    ...over,
  } satisfies MtaStsPublisherDeps;
  return { publisher: new MtaStsPublisher(deps), deps, dns, clock, item };
}

/** Deixa as promessas em segundo plano terminarem. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("begin — domínio de e-mail recém-criado", () => {
  it("sem o domínio do painel o proxy não publica: estado 'unavailable', sem consultar nada", async () => {
    const { publisher, deps } = make({ publishing: vi.fn(async () => false) });
    await expect(publisher.begin(DOMAIN)).resolves.toBe("unavailable");
    expect(publisher.state(DOMAIN)).toBe("unavailable");
    expect(deps.pointsHere).not.toHaveBeenCalled();
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("falha ao ler se o painel publica conta como indisponível", async () => {
    const { publisher } = make({ publishing: vi.fn(async () => { throw new Error("x"); }) });
    await expect(publisher.begin(DOMAIN)).resolves.toBe("unavailable");
  });

  it("o DNS ainda não aponta: 'aguardando DNS' e nenhuma emissão pedida (não gasta cota)", async () => {
    const { publisher, deps } = make({ pointsHere: vi.fn(async () => false) });
    await expect(publisher.begin(DOMAIN)).resolves.toBe("waiting_dns");
    await flush();
    expect(deps.pointsHere).toHaveBeenCalledWith(STS_HOST);
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
    expect(publisher.state(DOMAIN)).toBe("waiting_dns");
  });

  it("conferência do DNS que falha conta como 'não aponta'", async () => {
    const { publisher, deps } = make({ pointsHere: vi.fn(async () => { throw new Error("x"); }) });
    await expect(publisher.begin(DOMAIN)).resolves.toBe("waiting_dns");
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("o DNS aponta: 'emitindo' na hora e, depois que o proxy recarregou, a requisição à própria URL aquece a emissão", async () => {
    let proxyDone!: () => void;
    const proxyReady = new Promise<void>((resolve) => {
      proxyDone = resolve;
    });
    const { publisher, deps } = make({ fetchPolicy: vi.fn(async () => "version: STSv1") });
    await expect(publisher.begin(DOMAIN, proxyReady)).resolves.toBe("issuing");
    await flush();
    // o proxy ainda não registrou o nome: nada é pedido
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
    proxyDone();
    await flush();
    expect(deps.fetchPolicy).toHaveBeenCalledWith(DOMAIN, WARM_TIMEOUT_MS);
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("a emissão ainda não saiu: segue 'emitindo' (a rodada periódica volta a tentar)", async () => {
    const { publisher } = make();
    await publisher.begin(DOMAIN);
    await flush();
    expect(publisher.state(DOMAIN)).toBe("issuing");
  });

  it("falha do proxy ao recarregar não derruba nada: vai para o log", async () => {
    const { publisher, deps } = make();
    await publisher.begin(DOMAIN, Promise.reject(new Error("caddy fora")));
    await flush();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("não foi possível aquecer"));
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("falha na requisição de aquecimento é registrada e o estado segue 'emitindo'", async () => {
    const { publisher, deps } = make({ fetchPolicy: vi.fn(async () => { throw new Error("reset"); }) });
    await publisher.begin(DOMAIN);
    await flush();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("o aquecimento falhou (reset)"));
    expect(publisher.state(DOMAIN)).toBe("issuing");
  });

  it("o domínio é guardado em minúsculas", async () => {
    const { publisher } = make({ pointsHere: vi.fn(async () => false) });
    await publisher.begin("Envio.Example.COM");
    expect(publisher.state("envio.example.com")).toBe("waiting_dns");
    expect(publisher.state("ENVIO.example.com")).toBe("waiting_dns");
  });
});

describe("sweep — subida do painel e verificação periódica", () => {
  it("sem o domínio do painel todos ficam 'unavailable' e nada é recarregado nem pedido", async () => {
    const { publisher, deps } = make({ publishing: vi.fn(async () => false) });
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("unavailable");
    expect(deps.refreshProxy).not.toHaveBeenCalled();
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("registra no proxy o que ainda não está (uma recarga só) e aquece quem já aponta", async () => {
    const { publisher, deps } = make({ domains: vi.fn(async () => [DOMAIN, "outro.example.com"]), fetchPolicy: vi.fn(async () => "version: STSv1") });
    await publisher.sweep();
    expect(deps.refreshProxy).toHaveBeenCalledTimes(1);
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(2);
    expect(publisher.state(DOMAIN)).toBe("active");
    // já registrados: a próxima rodada não recarrega o proxy de novo
    await publisher.sweep();
    expect(deps.refreshProxy).toHaveBeenCalledTimes(1);
  });

  it("nome que ainda não aponta fica 'aguardando DNS' e não gasta emissão", async () => {
    const { publisher, deps } = make({ pointsHere: vi.fn(async () => false) });
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("waiting_dns");
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("política que não abriu fica 'emitindo' e só é tentada de novo depois do intervalo", async () => {
    const { publisher, deps, clock } = make();
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("issuing");
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
    clock.t += WARM_COOLDOWN_MS - 1_000;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
    expect(publisher.state(DOMAIN)).toBe("issuing");
    clock.t += 2_000;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(2);
  });

  it("certificado que falhou espera mais antes de nova tentativa (o Caddy já espera sozinho)", async () => {
    const { publisher, deps, clock } = make({ certState: vi.fn(async () => "failed" as const) });
    await publisher.sweep();
    clock.t += WARM_COOLDOWN_MS + 1_000;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
    clock.t += WARM_COOLDOWN_FAILED_MS;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(2);
  });

  it("estado do certificado ilegível não impede a rodada", async () => {
    const { publisher, deps } = make({ certState: vi.fn(async () => { throw new Error("x"); }) });
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it(`no máximo ${SWEEP_MAX_WARMS} emissões por rodada: o resto espera a próxima`, async () => {
    const names = Array.from({ length: 5 }, (_, i) => `d${i}.example.com`);
    const { publisher, deps } = make({ domains: vi.fn(async () => names) });
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(SWEEP_MAX_WARMS);
    for (const n of names) expect(publisher.state(n), n).toBe("issuing");
    await publisher.sweep();
    // os três primeiros estão no intervalo; os dois que sobraram são tentados agora
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(SWEEP_MAX_WARMS + 2);
  });

  it(`teto de ${WARM_MAX_PER_HOUR} aquecimentos por hora, somando todas as origens (as cotas do Let's Encrypt)`, async () => {
    const names = Array.from({ length: 14 }, (_, i) => `d${i}.example.com`);
    const { publisher, deps, clock } = make({ domains: vi.fn(async () => names) });
    for (let i = 0; i < 5; i += 1) await publisher.sweep();
    // cinco rodadas seguidas dariam 14 pedidos (3 por rodada); o teto da hora segura em WARM_MAX_PER_HOUR
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MAX_PER_HOUR);
    for (const n of names) expect(publisher.state(n), n).toBe("issuing");
    // passada a hora e o intervalo de cada domínio, volta a pedir
    clock.t += 61 * 60_000;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MAX_PER_HOUR + SWEEP_MAX_WARMS);
  });

  it("domínio ativo só é reavaliado depois de algumas horas, e sem pedir nova emissão", async () => {
    const { publisher, deps, clock } = make({ fetchPolicy: vi.fn(async () => "version: STSv1"), certState: vi.fn(async () => "valid" as const) });
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("active");
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
    await publisher.sweep();
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
    clock.t += ACTIVE_RECHECK_MS + 1_000;
    await publisher.sweep();
    expect(deps.evaluate).toHaveBeenCalledTimes(2);
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1); // reavaliar não aquece
  });

  it("a política abre mas falta o TXT (DNS curinga, ou só o A criado): NÃO é ativo e a rodada não pula o domínio por 6 h", async () => {
    const { publisher, deps, clock, item } = make({ fetchPolicy: vi.fn(async () => "version: STSv1"), certState: vi.fn(async () => "valid" as const) });
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "missing_txt", params: { host: STS_HOST } };
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("missing_txt");
    // a próxima rodada (30 min depois) reavalia: o TXT foi criado e o estado vira ativo sem esperar 6 h
    item.current = OK_CHECK;
    clock.t += 30 * 60_000;
    await publisher.sweep();
    expect(deps.evaluate).toHaveBeenCalledTimes(2);
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("política que abre com algo a corrigir ('attention') ou sem poder conferir ('unverified') também é reavaliada a cada rodada", async () => {
    const { publisher, deps, item } = make({ fetchPolicy: vi.fn(async () => "version: STSv1"), certState: vi.fn(async () => "valid" as const) });
    item.current = { id: "mta_sts", level: "warn", inbox: true, code: "enforce_x", params: {} };
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("attention");
    item.current = { id: "mta_sts", level: "info", inbox: false, code: "txt_unavailable", params: {} };
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("unverified");
    item.current = OK_CHECK;
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("active");
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it("avaliação que falha na rodada vai para o log e mantém o estado", async () => {
    const { publisher, deps, item } = make({ fetchPolicy: vi.fn(async () => "version: STSv1"), certState: vi.fn(async () => "valid" as const) });
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "missing_txt", params: {} };
    await publisher.sweep();
    (deps.evaluate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("dns caiu"));
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("missing_txt");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("não foi possível avaliar o item (dns caiu)"));
  });

  it("enforce que deixou de abrir ('enforce_lapsed') é 'emitindo', não 'atenção': sem certificado válido passa pelos tetos de aquecimento", async () => {
    const lapsed: MailHealthCheck = { id: "mta_sts", level: "warn", inbox: false, code: "enforce_lapsed", params: {} };
    const { publisher, deps, item, clock } = make({ fetchPolicy: vi.fn(async () => "version: STSv1") });
    item.current = lapsed;
    await publisher.sweep();
    expect(publisher.state(DOMAIN)).toBe("issuing");
    // as rodas seguintes (certificado ausente): nada de reavaliar direto; vale o intervalo por domínio
    const evaluations = (deps.evaluate as ReturnType<typeof vi.fn>).mock.calls.length;
    for (let i = 0; i < 3; i += 1) {
      clock.t += 60_000;
      await publisher.sweep();
    }
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
    expect((deps.evaluate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(evaluations);
    // passado o intervalo, volta a tentar (uma vez), dentro dos tetos
    clock.t += WARM_COOLDOWN_MS;
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(2);
  });

  it("vários domínios saindo de 'falta o TXT' ao mesmo tempo, sem certificado válido: no máximo 3 por rodada", async () => {
    const names = Array.from({ length: 6 }, (_, i) => `d${i}.example.com`);
    const { publisher, deps, item } = make(
      { domains: vi.fn(async () => names), fetchPolicy: vi.fn(async () => "version: STSv1") },
      { a: [IP], txt: [TXT] },
    );
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "missing_txt", params: {} };
    for (const n of names) publisher.observe(n, { code: "missing_txt" });
    await publisher.sweep();
    expect(deps.fetchPolicy).toHaveBeenCalledTimes(SWEEP_MAX_WARMS);
  });

  it("domínio conhecido cujo nome não aponta para esta VPS: reavalia direto (a requisição não chega ao nosso proxy)", async () => {
    const { publisher, deps, item } = make({ pointsHere: vi.fn(async () => false) });
    publisher.observe(DOMAIN, { code: "missing_txt" });
    item.current = OK_CHECK;
    await publisher.sweep();
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
    expect(deps.evaluate).toHaveBeenCalledTimes(1);
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("observe: o item da saúde (verificação completa) atualiza o estado da lista pela mesma regra", () => {
    const { publisher } = make();
    publisher.observe(DOMAIN.toUpperCase(), { code: "missing_txt" });
    expect(publisher.state(DOMAIN)).toBe("missing_txt");
    publisher.observe(DOMAIN, { code: "testing" });
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("falha no meio da rodada vai para o log e libera a rodada seguinte", async () => {
    const domains = vi.fn(async (): Promise<string[]> => {
      throw new Error("sem cadastro");
    });
    const { publisher, deps } = make({ domains });
    await publisher.sweep();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("a rodada de publicação falhou (sem cadastro)"));
    domains.mockResolvedValueOnce([]);
    await publisher.sweep();
    expect(domains).toHaveBeenCalledTimes(2);
  });

  it("duas rodadas ao mesmo tempo viram uma só", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { publisher, deps } = make({ refreshProxy: vi.fn(async () => gate) });
    const first = publisher.sweep();
    const second = publisher.sweep();
    release();
    await Promise.all([first, second]);
    expect(deps.refreshProxy).toHaveBeenCalledTimes(1);
  });

  it("markRegistered e forget: o que o proxy já recebeu não o recarrega; domínio removido é esquecido", async () => {
    const { publisher, deps } = make({ pointsHere: vi.fn(async () => false) });
    publisher.markRegistered([DOMAIN.toUpperCase()]);
    await publisher.sweep();
    expect(deps.refreshProxy).not.toHaveBeenCalled();
    publisher.forget(DOMAIN);
    expect(publisher.state(DOMAIN)).toBeUndefined();
    await publisher.sweep();
    expect(deps.refreshProxy).toHaveBeenCalledTimes(1);
  });
});

describe("verify — botão 'Verificar' da caixa do MTA-STS", () => {
  it("domínio não cadastrado: erro 404 do plano, sem consultar DNS", async () => {
    const { publisher, deps } = make();
    await expect(publisher.verify("naoexiste.example.com")).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.refreshProxy).not.toHaveBeenCalled();
  });

  it("sem o domínio do painel: 'unavailable', nada é criado nem pedido", async () => {
    const { publisher, deps } = make({ publishing: vi.fn(async () => false) });
    const result = await publisher.verify(DOMAIN);
    expect(result).toMatchObject({ state: "unavailable", missing: [], published: false, issuanceTriggered: false, retryAfter: null });
    expect(result.progress).toEqual({ a: null, txt: null, policy: null });
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("nada no DNS: 'aguardando DNS' e diz exatamente o que falta, com o valor certo do id", async () => {
    const { publisher, deps, item } = make({}, { a: [], txt: [] });
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "absent", params: { host: STS_HOST } };
    const result = await publisher.verify(DOMAIN);
    expect(result.state).toBe("waiting_dns");
    expect(result.check).toMatchObject({ code: "absent" });
    expect(result.missing).toEqual([
      { id: "mta_sts_a", type: "A", name: STS_HOST, value: IP },
      { id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: TXT },
    ]);
    expect(result.progress).toEqual({ a: false, txt: false, policy: false });
    expect(result.retryAfter).toBeNull();
    // sem o A apontando não há aquecimento: só a avaliação do item
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
    expect(deps.evaluate).toHaveBeenCalledWith(DOMAIN);
    expect(result.issuanceTriggered).toBe(false);
  });

  it("o A existe e falta só o TXT: lista só o TXT", async () => {
    const { publisher } = make({}, { a: [IP], txt: [] });
    const result = await publisher.verify(DOMAIN);
    expect(result.missing.map((m) => m.id)).toEqual(["mta_sts"]);
    expect(result.state).toBe("issuing");
  });

  it("o TXT existe e falta só o A: lista só o A", async () => {
    const { publisher, item } = make({}, { a: [], txt: [TXT] });
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "missing_a", params: { host: STS_HOST } };
    const result = await publisher.verify(DOMAIN);
    expect(result.missing.map((m) => m.id)).toEqual(["mta_sts_a"]);
    expect(result.progress).toEqual({ a: false, txt: true, policy: false });
  });

  it("A apontando para outro IP continua faltando; o valor certo vem do plano", async () => {
    const { publisher, item } = make({}, { a: ["198.51.100.9"], txt: [TXT] });
    item.current = { id: "mta_sts", level: "optional", inbox: false, code: "a_mismatch", params: { host: STS_HOST } };
    const result = await publisher.verify(DOMAIN);
    expect(result.missing).toEqual([{ id: "mta_sts_a", type: "A", name: STS_HOST, value: IP }]);
  });

  it("DNS apontando e sem certificado: dispara a emissão e responde 'emitindo' com a espera sugerida", async () => {
    const { publisher, deps } = make({}, { a: [IP], txt: [TXT] });
    const result = await publisher.verify(DOMAIN);
    expect(result).toMatchObject({ state: "issuing", issuanceTriggered: true, retryAfter: VERIFY_RETRY_SECONDS, missing: [], check: null, health: null });
    expect(result.progress).toEqual({ a: true, txt: true, policy: false });
    expect(deps.fetchPolicy).toHaveBeenCalledWith(DOMAIN, WARM_TIMEOUT_MS);
    expect(publisher.state(DOMAIN)).toBe("issuing");
  });

  it("emissão que termina logo: 'ativo' na mesma resposta e o estado do domínio passa a ativo", async () => {
    const { publisher } = make({ fetchPolicy: vi.fn(async () => "version: STSv1") }, { a: [IP], txt: [TXT] });
    const result = await publisher.verify(DOMAIN);
    expect(result).toMatchObject({ state: "active", retryAfter: null, missing: [], check: { code: "testing" }, warmLimitUntil: null });
    expect(result.health).not.toBeNull();
    expect(result.progress).toEqual({ a: true, txt: true, policy: true });
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("emissão demorada: a resposta não espera além do limite curto (a requisição segue em segundo plano)", async () => {
    let finish!: (v: string) => void;
    const slow = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const wait = vi.fn(async () => undefined);
    const { publisher } = make({ fetchPolicy: vi.fn(() => slow), wait }, { a: [IP], txt: [TXT] });
    const result = await publisher.verify(DOMAIN);
    expect(wait).toHaveBeenCalledWith(4_000);
    expect(result.state).toBe("issuing");
    finish("version: STSv1");
    await flush();
    // quando a política abre em segundo plano, o item é reavaliado e o estado da lista acompanha
    expect(publisher.state(DOMAIN)).toBe("active");
  });

  it("o certificado do painel entra na resposta (o estado que a tela mostra)", async () => {
    const { publisher } = make({ certState: vi.fn(async () => "issuing" as const) }, { a: [IP], txt: [TXT] });
    expect((await publisher.verify(DOMAIN)).certificate).toBe("issuing");
    const failing = make({ certState: vi.fn(async () => { throw new Error("x"); }) }, { a: [IP], txt: [TXT] });
    expect((await failing.publisher.verify(DOMAIN)).certificate).toBe("unknown");
  });

  it("falta só a publicação do lado do painel: registra o nome no proxy na hora", async () => {
    const { publisher, deps } = make({}, { a: [IP], txt: [TXT] });
    const first = await publisher.verify(DOMAIN);
    expect(first.published).toBe(true);
    expect(deps.refreshProxy).toHaveBeenCalledTimes(1);
    // já registrado: não recarrega de novo
    const second = make({}, { a: [IP], txt: [TXT] });
    second.publisher.markRegistered([DOMAIN]);
    expect((await second.publisher.verify(DOMAIN)).published).toBe(false);
    expect(second.deps.refreshProxy).not.toHaveBeenCalled();
  });

  it("política hospedada fora do painel (o A não aponta para esta VPS mas o item está ativo): ativa, sem pedir o A", async () => {
    const { publisher, deps } = make({}, { a: ["198.51.100.9"], txt: [TXT] });
    const result = await publisher.verify(DOMAIN);
    expect(result.state).toBe("active");
    expect(result.missing).toEqual([]);
    expect(deps.fetchPolicy).not.toHaveBeenCalled();
  });

  it("falha ao avaliar o item com o A fora fica 'aguardando DNS', sem erro, e vai para o log", async () => {
    const { publisher, deps } = make({ evaluate: vi.fn(async () => { throw new Error("x"); }) }, { a: [], txt: [] });
    expect((await publisher.verify(DOMAIN)).state).toBe("waiting_dns");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("não foi possível avaliar o item (x)"));
  });

  it("TXT com o id de uma política anterior: pede o valor novo, marcado como desatualizado", async () => {
    const { publisher } = make({}, { a: [IP], txt: ["v=STSv1; id=antigo123"] });
    const result = await publisher.verify(DOMAIN);
    expect(result.missing).toEqual([{ id: "mta_sts", type: "TXT", name: `_mta-sts.${DOMAIN}`, value: TXT, outdated: true }]);
    expect(result.idGrace).toBe(false);
  });

  describe("id antigo aceito por um prazo (RFC 8461)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "mta-sts-ids-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("política mudou: o TXT com o id anterior vale por um dia (não é pedido de novo) e depois volta a faltar", async () => {
      const clock = { t: Date.parse("2026-10-26T12:00:00Z") };
      const ids = new MtaStsIdStore(dir, () => clock.t);
      await ids.observe(DOMAIN, "antigo123"); // o painel já tinha visto este id como o esperado
      const { publisher } = make({ ids, now: () => clock.t }, { a: [IP], txt: ["v=STSv1; id=antigo123"] });
      const within = await publisher.verify(DOMAIN);
      expect(within.idGrace).toBe(true);
      expect(within.missing).toEqual([]);
      expect(within.progress.txt).toBe(true);
      clock.t += MTA_STS_ID_GRACE_MS + 1_000;
      const after = await publisher.verify(DOMAIN);
      expect(after.idGrace).toBe(false);
      expect(after.missing.map((m) => m.id)).toEqual(["mta_sts"]);
    });

    it("falha ao ler os ids guardados não derruba a verificação", async () => {
      const ids = { observe: vi.fn(async () => { throw new Error("x"); }) };
      const { publisher } = make({ ids }, { a: [IP], txt: [TXT] });
      expect((await publisher.verify(DOMAIN)).missing).toEqual([]);
    });
  });

  it("consulta de DNS que falhou não afirma nada: nem falta, nem pronto", async () => {
    const { publisher, item } = make({}, { a: "fail", txt: "fail" });
    item.current = { id: "mta_sts", level: "info", inbox: false, code: "txt_unavailable", params: {} };
    const result = await publisher.verify(DOMAIN);
    expect(result.progress).toEqual({ a: null, txt: null, policy: null });
    expect(result.missing).toEqual([]);
    expect(result.state).toBe("unverified");
  });

  describe("limites", () => {
    it(`o mesmo domínio só pode ser verificado a cada ${VERIFY_MIN_INTERVAL_MS / 1000} s (429 com a espera)`, async () => {
      const { publisher, clock } = make({}, { a: [], txt: [] });
      await publisher.verify(DOMAIN);
      await expect(publisher.verify(DOMAIN)).rejects.toMatchObject({ statusCode: 429, code: "mta_sts_verify_too_soon", details: { retryAfter: expect.any(Number) } });
      clock.t += VERIFY_MIN_INTERVAL_MS;
      await expect(publisher.verify(DOMAIN)).resolves.toBeDefined();
    });

    it(`teto de ${VERIFY_MAX_PER_MINUTE} verificações por minuto no servidor todo (429 busy)`, async () => {
      // domínios diferentes escapam do intervalo por domínio e batem no teto geral
      const { publisher } = make({ planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) }, { a: [], txt: [] });
      for (let i = 0; i < VERIFY_MAX_PER_MINUTE; i += 1) await publisher.verify(`d${i}.example.com`);
      await expect(publisher.verify("extra.example.com")).rejects.toMatchObject({ statusCode: 429, code: "mta_sts_verify_busy", details: { retryAfter: expect.any(Number) } });
    });

    it("passado o minuto, o teto libera", async () => {
      const clock = { t: Date.parse("2026-10-26T12:00:00Z") };
      const { publisher } = make({ now: () => clock.t, planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) }, { a: [], txt: [] });
      for (let i = 0; i < VERIFY_MAX_PER_MINUTE; i += 1) await publisher.verify(`d${i}.example.com`);
      clock.t += 61_000;
      await expect(publisher.verify("extra.example.com")).resolves.toBeDefined();
    });

    it("pedido de emissão do botão respeita o intervalo do domínio: sem requisição nova antes dele, a resposta segue 'emitindo'", async () => {
      const { publisher, deps, clock } = make({}, { a: [IP], txt: [TXT] });
      const first = await publisher.verify(DOMAIN);
      expect(first.issuanceTriggered).toBe(true);
      clock.t += VERIFY_MIN_INTERVAL_MS; // pode verificar de novo, mas ainda é cedo para nova emissão
      const second = await publisher.verify(DOMAIN);
      expect(second.state).toBe("issuing");
      expect(second.issuanceTriggered).toBe(false);
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
      clock.t += WARM_MANUAL_COOLDOWN_MS;
      expect((await publisher.verify(DOMAIN)).issuanceTriggered).toBe(true);
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(2);
    });

    it("emissão já em andamento não é pedida em dobro: o botão acompanha a mesma requisição", async () => {
      let finish!: (v: string) => void;
      const slow = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const { publisher, deps, clock } = make({ fetchPolicy: vi.fn(() => slow), wait: async () => undefined }, { a: [IP], txt: [TXT] });
      await publisher.verify(DOMAIN);
      clock.t += VERIFY_MIN_INTERVAL_MS;
      const again = await publisher.verify(DOMAIN);
      expect(again.issuanceTriggered).toBe(false);
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(1);
      finish("version: STSv1");
      await flush();
      expect(publisher.state(DOMAIN)).toBe("active");
    });

    it("verificações simultâneas de domínios diferentes não passam do teto do botão", async () => {
      const { publisher, deps } = make(
        { planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) },
        { a: [IP], txt: [TXT] },
      );
      const results = await Promise.all(Array.from({ length: WARM_MANUAL_MAX_PER_HOUR + 2 }, (_, i) => publisher.verify(`s${i}.example.com`)));
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MANUAL_MAX_PER_HOUR);
      expect(results.filter((r) => r.warmLimitUntil !== null)).toHaveLength(2);
    });

    it("o teto da rotina esgotado não impede o botão: ele tem a cota própria", async () => {
      const names = Array.from({ length: 12 }, (_, i) => `d${i}.example.com`);
      const { publisher, deps } = make(
        { domains: vi.fn(async () => names), planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) },
        { a: [IP], txt: [TXT] },
      );
      for (let i = 0; i < 4; i += 1) await publisher.sweep();
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MAX_PER_HOUR);
      const result = await publisher.verify("novo.example.com");
      expect(result.issuanceTriggered).toBe(true);
      expect(result.warmLimitUntil).toBeNull();
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MAX_PER_HOUR + 1);
    });

    it(`teto próprio do botão (${WARM_MANUAL_MAX_PER_HOUR} por hora): acima dele não há requisição e a resposta diz quando volta`, async () => {
      const { publisher, deps, clock } = make(
        { planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) },
        { a: [IP], txt: [TXT] },
      );
      const start = clock.t;
      for (let i = 0; i < WARM_MANUAL_MAX_PER_HOUR; i += 1) {
        const r = await publisher.verify(`m${i}.example.com`);
        expect(r.issuanceTriggered).toBe(true);
      }
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MANUAL_MAX_PER_HOUR);
      clock.t += 5_000;
      const blocked = await publisher.verify("extra.example.com");
      expect(blocked).toMatchObject({ state: "issuing", issuanceTriggered: false, retryAfter: null, check: null });
      expect(blocked.warmLimitUntil).toBe(new Date(start + 3_600_000).toISOString());
      expect(deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MANUAL_MAX_PER_HOUR);
      // passada a hora do aquecimento mais antigo, o botão volta a emitir
      clock.t = start + 3_600_001;
      expect((await publisher.verify("extra.example.com")).issuanceTriggered).toBe(true);
    });

    it("com o certificado já válido, o botão só reavalia: não gasta a cota de emissão", async () => {
      const { publisher, deps } = make({ certState: vi.fn(async () => "valid" as const) }, { a: [IP], txt: [] });
      const result = await publisher.verify(DOMAIN);
      expect(deps.fetchPolicy).not.toHaveBeenCalled();
      expect(result.issuanceTriggered).toBe(false);
      expect(result.check).not.toBeNull();
    });
  });
});

describe("MtaStsIdStore — ids anteriores da política", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mta-sts-ids-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, "mail-health-mta-sts-ids.json");

  it("primeira vez: guarda o id e não há anterior", async () => {
    const store = new MtaStsIdStore(dir);
    expect(await store.observe(DOMAIN, "a1")).toEqual([]);
    expect(JSON.parse(await readFile(file(), "utf8"))).toMatchObject({ [DOMAIN]: { id: "a1", previous: [] } });
  });

  it("id igual não reescreve o arquivo", async () => {
    const store = new MtaStsIdStore(dir);
    await store.observe(DOMAIN, "a1");
    const before = await readFile(file(), "utf8");
    expect(await store.observe(DOMAIN, "a1")).toEqual([]);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  it("política mudou: o id anterior vale por um dia e some depois", async () => {
    const clock = { t: 1_000_000 };
    const store = new MtaStsIdStore(dir, () => clock.t);
    await store.observe(DOMAIN, "a1");
    expect(await store.observe(DOMAIN, "a2")).toEqual(["a1"]);
    clock.t += MTA_STS_ID_GRACE_MS - 1;
    expect(await store.observe(DOMAIN, "a2")).toEqual(["a1"]);
    clock.t += 2;
    expect(await store.observe(DOMAIN, "a2")).toEqual([]);
    expect(JSON.parse(await readFile(file(), "utf8"))[DOMAIN].previous).toEqual([]);
  });

  it("mudou duas vezes seguidas: os dois ids anteriores valem; voltar a um id antigo o tira da lista", async () => {
    const store = new MtaStsIdStore(dir, () => 5_000);
    await store.observe(DOMAIN, "a1");
    await store.observe(DOMAIN, "a2");
    expect((await store.observe(DOMAIN, "a3")).sort()).toEqual(["a1", "a2"]);
    expect((await store.observe(DOMAIN, "a1")).sort()).toEqual(["a2", "a3"]);
  });

  it("remove esquece o domínio (e remover o que não existe não faz nada)", async () => {
    const store = new MtaStsIdStore(dir);
    await store.remove(DOMAIN);
    await store.observe(DOMAIN, "a1");
    await store.observe("outro.example.com", "b1");
    await store.remove(DOMAIN);
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")))).toEqual(["outro.example.com"]);
  });

  it("arquivo com formato torto é ignorado entrada por entrada", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file(), JSON.stringify({ ok: { id: "x", previous: [{ id: "y", until: 9_999_999_999_999 }, { id: 3 }] }, ruim: { id: 1 }, pior: null }));
    const store = new MtaStsIdStore(dir, () => 1_000);
    expect(await store.observe("ok", "x")).toEqual(["y"]);
    await writeFile(file(), JSON.stringify([1, 2]));
    expect(await new MtaStsIdStore(dir).observe(DOMAIN, "z")).toEqual([]);
  });
});

describe("registro de aquecimentos guardado em arquivo (reinícios em sequência não zeram os tetos)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mta-sts-warm-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, "mail-health-mta-sts-warm.json");
  const names = Array.from({ length: 12 }, (_, i) => `d${i}.example.com`);
  const many = { domains: vi.fn(async () => names), planInput: vi.fn(async (d: string) => ({ ...PLAN, domain: d, mailHostname: `mail.${d}` })) };

  it("depois de reiniciar, o teto por hora e o intervalo por domínio continuam valendo", async () => {
    const t0 = Date.parse("2026-10-26T12:00:00Z");
    const first = make({ ...many, warmStore: new MtaStsWarmStore(dir) }, { a: [IP], txt: [TXT] });
    for (let i = 0; i < 4; i += 1) await first.publisher.sweep();
    expect(first.deps.fetchPolicy).toHaveBeenCalledTimes(WARM_MAX_PER_HOUR);
    await first.publisher.flush();
    const saved = JSON.parse(await readFile(file(), "utf8")) as { routine: number[]; last: Record<string, number> };
    expect(saved.routine).toHaveLength(WARM_MAX_PER_HOUR);
    expect(Object.keys(saved.last)).toHaveLength(WARM_MAX_PER_HOUR);

    // "reinício": outro publicador, mesmo arquivo, 5 minutos depois
    const second = make({ ...many, warmStore: new MtaStsWarmStore(dir), now: () => t0 + 5 * 60_000 }, { a: [IP], txt: [TXT] });
    await second.publisher.sweep();
    expect(second.deps.fetchPolicy).not.toHaveBeenCalled();
    // uma hora depois da primeira rodada o teto libera
    const third = make({ ...many, warmStore: new MtaStsWarmStore(dir), now: () => t0 + 61 * 60_000 }, { a: [IP], txt: [TXT] });
    await third.publisher.sweep();
    expect(third.deps.fetchPolicy).toHaveBeenCalled();
    await third.publisher.flush();
  });

  it("o teto do botão também sobrevive ao reinício", async () => {
    const t0 = Date.parse("2026-10-26T12:00:00Z");
    const first = make({ ...many, warmStore: new MtaStsWarmStore(dir) }, { a: [IP], txt: [TXT] });
    for (let i = 0; i < WARM_MANUAL_MAX_PER_HOUR; i += 1) await first.publisher.verify(`m${i}.example.com`);
    await first.publisher.flush();
    const second = make({ ...many, warmStore: new MtaStsWarmStore(dir), now: () => t0 + 60_000 }, { a: [IP], txt: [TXT] });
    const r = await second.publisher.verify("novo.example.com");
    expect(r.issuanceTriggered).toBe(false);
    expect(r.warmLimitUntil).not.toBeNull();
    await second.publisher.flush();
  });

  it("arquivo ilegível ou com lixo: começa do zero, sem derrubar; arquivo que não grava vai para o log", async () => {
    await writeFile(file(), "{lixo");
    const broken = make({ warmStore: new MtaStsWarmStore(dir) });
    await broken.publisher.sweep();
    expect(broken.deps.fetchPolicy).toHaveBeenCalledTimes(1);
    await broken.publisher.flush();
    const failing = make({
      warmStore: { load: async () => { throw new Error("disco"); }, save: async () => { throw new Error("cheio"); } },
    });
    await failing.publisher.sweep();
    expect(failing.deps.log).toHaveBeenCalledWith(expect.stringContaining("registro de aquecimentos não lido (disco)"));
    await failing.publisher.flush();
    expect(failing.deps.log).toHaveBeenCalledWith(expect.stringContaining("registro de aquecimentos não gravado (cheio)"));
  });

  it("depois de reiniciar, o selo mostra o último estado conhecido (e a primeira rodada o reconfirma)", async () => {
    const first = make({ warmStore: new MtaStsWarmStore(dir) });
    first.publisher.observe(DOMAIN, { code: "missing_txt" });
    await first.publisher.flush();
    const second = make({ warmStore: new MtaStsWarmStore(dir) });
    expect(second.publisher.state(DOMAIN)).toBeUndefined();
    await second.publisher.ready();
    expect(second.publisher.state(DOMAIN)).toBe("missing_txt");
    await second.publisher.flush();
  });

  it("estado desconhecido no arquivo é ignorado; o arquivo ainda não lido não é sobrescrito por um estado novo", async () => {
    await writeFile(file(), JSON.stringify({ routine: [1], manual: [], last: {}, states: { [DOMAIN]: "estado-novo-demais", "b.example.com": "active", "c.example.com": 3 } }));
    const { publisher } = make({ warmStore: new MtaStsWarmStore(dir) });
    publisher.observe("z.example.com", { code: "testing" }); // antes de carregar
    await publisher.flush();
    await publisher.ready();
    expect(publisher.state(DOMAIN)).toBeUndefined();
    expect(publisher.state("b.example.com")).toBe("active");
    expect(JSON.parse(await readFile(file(), "utf8"))).toMatchObject({ routine: [1], states: { "z.example.com": "active" } });
  });

  it("entradas inválidas do arquivo são ignoradas", async () => {
    await writeFile(file(), JSON.stringify({ routine: [1, "x", null], manual: "não", last: { "a.example.com": 5, "b.example.com": "x" } }));
    expect(await new MtaStsWarmStore(dir).load()).toEqual({ routine: [1], manual: [], last: { "a.example.com": 5 }, states: {} });
    await writeFile(file(), JSON.stringify([1, 2]));
    expect(await new MtaStsWarmStore(dir).load()).toEqual({ routine: [], manual: [], last: {}, states: {} });
    await writeFile(file(), JSON.stringify({ routine: [], manual: [], last: [1] }));
    expect(await new MtaStsWarmStore(dir).load()).toEqual({ routine: [], manual: [], last: {}, states: {} });
  });

  it("forget grava o registro sem o domínio", async () => {
    const { publisher } = make({ warmStore: new MtaStsWarmStore(dir) });
    await publisher.sweep();
    await publisher.flush();
    publisher.forget(DOMAIN);
    await publisher.flush();
    expect((JSON.parse(await readFile(file(), "utf8")) as { last: Record<string, number> }).last).toEqual({});
  });
});
