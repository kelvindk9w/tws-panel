/**
 * Domínios dinâmicos — regras do serviço: cadastro, nome único entre projetos,
 * sufixos, tetos ajustáveis, a decisão do `ask` (quem pode receber certificado
 * sob demanda e quantos por hora) e a tela (contadores, busca, paginação).
 * Sem Docker e sem rede: todas as dependências são dublês.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CertificateItem } from "@paas/core";
import {
  DynamicDomainsService,
  MAX_UNREGISTERED_DNS_LOOKUPS,
  PUBLIC_IP_UNKNOWN_REASON,
  dynamicRouting,
  type DynamicDomainsDeps,
  type StaticOccupant,
} from "../src/services/dynamic-domains.js";
import { runWithActor } from "../src/services/request-actor.js";

let dir = "";
let clock = 0;
const HOUR = 3_600_000;
const projects = new Set(["p1", "p2"]);
let occupied = new Map<string, StaticOccupant>();
let certItems: Partial<CertificateItem>[] = [];

const refreshProxy = vi.fn(async () => undefined);
const audit = { record: vi.fn(async () => undefined) };
const logs: string[] = [];

function make(over: Partial<DynamicDomainsDeps> = {}): DynamicDomainsService {
  return new DynamicDomainsService({
    dataDir: dir,
    projectExists: async (id) => projects.has(id),
    staticOccupant: async (host) => occupied.get(host) ?? null,
    refreshProxy,
    inspect: async (_id, hosts) => certItems.filter((c) => hosts.has(c.host!)) as CertificateItem[],
    routing: () => ({ ready: true, reason: null }),
    audit,
    log: (m) => logs.push(m),
    now: () => clock,
    refreshDelayMs: 40,
    ...over,
  });
}

const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { code?: string; statusCode?: number } | null);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-dyn-"));
  clock = Date.parse("2026-10-24T12:00:00Z");
  occupied = new Map();
  certItems = [];
  logs.length = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  // a cópia da última lista boa é gravada em segundo plano: pode chegar no meio da limpeza
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe("cadastro", () => {
  it("cadastra, normaliza, guarda em disco (0600) e recarrega o proxy uma vez só para vários nomes", async () => {
    const s = make();
    const a = await s.add("p1", "  App.Cliente.EXAMPLE ");
    await s.add("p1", "outro.cliente.example");
    expect(a).toMatchObject({ created: true, item: { host: "app.cliente.example", state: "waiting", via: "own", addedBy: "painel" } });
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalledTimes(1));
    await s.flush();
    const text = await readFile(path.join(dir, "dynamic-domains.json"), "utf8");
    expect(JSON.parse(text).projects.p1.names.map((n: { host: string }) => n.host)).toEqual(["app.cliente.example", "outro.cliente.example"]);
    // reabrir lê o mesmo estado
    expect((await make().names()).map((n) => n.host).sort()).toEqual(["app.cliente.example", "outro.cliente.example"]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "domain.dynamic_added", target: "p1" }));
    s.close();
  });

  it("registra quem cadastrou (token) vindo do contexto da requisição", async () => {
    const s = make();
    const r = await runWithActor("token:saas", () => s.add("p1", "a.cliente.example"));
    expect(r.item.addedBy).toBe("token:saas");
    s.close();
  });

  it("repetir o mesmo nome no mesmo projeto é seguro (não duplica nem regrava)", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    const again = await s.add("p1", "A.Cliente.Example");
    expect(again.created).toBe(false);
    expect((await s.names()).filter((n) => n.host === "a.cliente.example")).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("o mesmo nome não fica em dois projetos (409), nem sob o sufixo de outro projeto", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    expect(await code(s.add("p2", "a.cliente.example"))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }]);
    expect(await code(s.add("p2", "x.saas.example"))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    // dois níveis abaixo não é coberto pelo sufixo
    expect((await s.add("p2", "x.y.saas.example")).created).toBe(true);
    s.close();
  });

  it.each<[string, StaticOccupant]>([
    ["painel.example.com", "panel"],
    ["mail.example.com", "mail"],
    ["site.example.com", "project"],
  ])("nome já servido como site fixo (%s: %s) é recusado", async (host, who) => {
    occupied.set(host, who);
    const s = make();
    expect(await code(s.add("p1", host))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    s.close();
  });

  it.each([
    ["*.example.com", "wildcard"],
    ["203.0.113.7", "ip"],
    ["localhost", "single_label"],
    ["app.localhost", "local"],
    ["https://a.example.com/x", "invalid"],
    ["com.br", "public_suffix"],
  ])("nome inválido %j: 400 com o motivo (%s)", async (host, issue) => {
    const s = make();
    const err = (await s.add("p1", host).then(() => null, (e: unknown) => e)) as { statusCode: number; code: string; details: { issue: string } };
    expect(err).toMatchObject({ statusCode: 400, code: "invalid_dynamic_host", details: { issue } });
    s.close();
  });

  it("nome que não é texto é recusado", async () => {
    const s = make();
    expect(await code(s.add("p1", 42))).toMatchObject({ statusCode: 400, code: "invalid_dynamic_host" });
    s.close();
  });

  it("projeto inexistente: 404", async () => {
    const s = make();
    expect(await code(s.add("nada", "a.cliente.example"))).toMatchObject({ statusCode: 404, code: "project_not_found" });
    expect(await code(s.remove("nada", "a.cliente.example"))).toMatchObject({ statusCode: 404 });
    expect(await code(s.view("nada"))).toMatchObject({ statusCode: 404 });
    expect(await code(s.setSuffixes("nada", []))).toMatchObject({ statusCode: 404 });
    expect(await code(s.one("nada", "a.cliente.example"))).toMatchObject({ statusCode: 404 });
    s.close();
  });

  it("teto de nomes por projeto: o 501º é recusado; subir o teto libera; outro projeto tem o seu", async () => {
    const s = make();
    await s.setLimits({ maxNamesPerProject: 10 });
    for (let i = 0; i < 10; i++) await s.add("p1", `c${i}.cliente.example`);
    expect(await code(s.add("p1", "c10.cliente.example"))).toMatchObject({ statusCode: 409, code: "dynamic_limit_reached" });
    expect((await s.add("p2", "c10.cliente.example")).created).toBe(true);
    await s.setLimits({ maxNamesPerProject: 11 });
    expect((await s.add("p1", "c11.cliente.example")).created).toBe(true);
    s.close();
  });

  it("cadastros simultâneos do mesmo nome em projetos diferentes: só um vence", async () => {
    const s = make();
    const results = await Promise.all([code(s.add("p1", "x.cliente.example")), code(s.add("p2", "x.cliente.example"))]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.code === "domain_in_use")).toHaveLength(1);
    s.close();
  });

  it("remover: tira da lista, recarrega o proxy e repetir dá 404", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalledTimes(1));
    await s.remove("p1", "A.CLIENTE.example");
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalledTimes(2));
    expect(await s.names()).toEqual([]);
    expect(await code(s.remove("p1", "a.cliente.example"))).toMatchObject({ statusCode: 404, code: "domain_not_found" });
    expect(await code(s.remove("p1", 7))).toMatchObject({ statusCode: 404 });
    // nome de outro projeto não se remove por este
    await s.add("p2", "b.cliente.example");
    expect(await code(s.remove("p1", "b.cliente.example"))).toMatchObject({ statusCode: 404 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "domain.dynamic_removed" }));
    s.close();
  });

  it("nome sob o sufixo do próprio projeto não recarrega o proxy (o curinga já o atende)", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }]);
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalledTimes(1));
    const a = await s.add("p1", "novo.saas.example");
    expect(a.item.via).toBe("suffix");
    await s.remove("p1", "novo.saas.example");
    await new Promise((r) => setTimeout(r, 40));
    expect(refreshProxy).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("falha na recarga do proxy é só registrada (o próximo ajuste tenta de novo)", async () => {
    const s = make({ refreshProxy: async () => Promise.reject(new Error("caddy fora do ar")) });
    await s.add("p1", "a.cliente.example");
    await vi.waitFor(() => expect(logs.join()).toContain("caddy fora do ar"));
    s.close();
  });

  it("falha ao gravar no disco: 500 e o estado em memória volta ao que era", async () => {
    const s = make();
    await s.preload();
    // um diretório no lugar do arquivo: a troca atômica falha
    await mkdir(path.join(dir, "dynamic-domains.json"));
    expect(await code(s.add("p1", "a.cliente.example"))).toMatchObject({ statusCode: 500, code: "storage_write_failed" });
    expect(await s.names()).toEqual([]);
    expect(s.claimsSync("a.cliente.example")).toBe(false);
    s.close();
  });

  it("auditoria que falha não derruba o cadastro", async () => {
    const s = make({ audit: { record: async () => Promise.reject(new Error("disco")) } });
    expect((await s.add("p1", "a.cliente.example")).created).toBe(true);
    expect(logs.join()).toContain("auditoria não gravada");
    s.close();
  });
});

describe("sufixos", () => {
  it("valida, normaliza, remove repetidos e grava; igual ao que já existe não faz nada", async () => {
    const s = make();
    const r = await s.setSuffixes("p1", [
      { suffix: "*.SaaS.example", openAll: false },
      { suffix: "saas.example", openAll: true },
      { suffix: "outro.example", openAll: true },
    ]);
    expect(r).toEqual([
      { suffix: "saas.example", openAll: false },
      { suffix: "outro.example", openAll: true },
    ]);
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalledTimes(1));
    await s.setSuffixes("p1", [...r].reverse());
    await new Promise((r2) => setTimeout(r2, 30));
    expect(refreshProxy).toHaveBeenCalledTimes(1);
    expect(await s.suffixes("p1")).toEqual(r);
    expect(await s.suffixes("p2")).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "domain.dynamic_suffixes" }));
    s.close();
  });

  it.each(["com.br", "*.com", "herokuapp.com", "x.local", "localhost", "203.0.113.1", ""])("recusa o sufixo %j", async (suffix) => {
    const s = make();
    expect(await code(s.setSuffixes("p1", [{ suffix, openAll: false }]))).toMatchObject({ statusCode: 400, code: "invalid_dynamic_suffix" });
    s.close();
  });

  it("no máximo 10 sufixos por projeto", async () => {
    const s = make();
    const many = Array.from({ length: 11 }, (_, i) => ({ suffix: `s${i}.example`, openAll: false }));
    expect(await code(s.setSuffixes("p1", many))).toMatchObject({ statusCode: 400, code: "invalid_dynamic_suffix" });
    expect((await s.setSuffixes("p1", many.slice(0, 10))).length).toBe(10);
    s.close();
  });

  it("sufixo de outro projeto ou do painel é recusado; o do próprio projeto pode ser reenviado", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }]);
    expect(await code(s.setSuffixes("p2", [{ suffix: "saas.example", openAll: false }]))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    occupied.set("painel.example", "panel");
    expect(await code(s.setSuffixes("p2", [{ suffix: "painel.example", openAll: true }]))).toMatchObject({ statusCode: 409 });
    expect((await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: true }]))[0]!.openAll).toBe(true);
    s.close();
  });

  it("o proxy recebe sufixos e só os nomes que o curinga não cobre", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }]);
    await s.add("p1", "a.saas.example");
    await s.add("p1", "app.cliente.example");
    await s.add("p1", "x.y.saas.example");
    await s.add("p2", "b.outro.example");
    expect(await s.proxyProjects()).toEqual([
      { projectId: "p1", suffixes: ["saas.example"], hosts: ["app.cliente.example", "x.y.saas.example"] },
      { projectId: "p2", suffixes: [], hosts: ["b.outro.example"] },
    ]);
    s.close();
  });

  it("projeto apagado: nomes e sufixos saem (sem recarregar o proxy: o Caddyfile já foi refeito)", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }]);
    await s.add("p1", "app.cliente.example");
    await vi.waitFor(() => expect(refreshProxy).toHaveBeenCalled());
    // máquina lenta: deixa a recarga pendente do cadastro terminar antes de contar
    await new Promise((r) => setTimeout(r, 60));
    const calls = refreshProxy.mock.calls.length;
    await s.forgetProject("p1");
    await s.forgetProject("nunca-existiu");
    expect(await s.names()).toEqual([]);
    expect(await s.proxyProjects()).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(refreshProxy.mock.calls.length).toBe(calls);
    expect(s.claimsSync("app.cliente.example")).toBe(false);
    s.close();
  });
});

describe("tetos ajustáveis", () => {
  it("padrão 500 nomes e 20 emissões por hora", async () => {
    const s = make();
    expect(await s.limits()).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 });
    s.close();
  });

  it("grava, audita e sobrevive a reabrir; mexe só no que veio", async () => {
    const s = make();
    expect(await s.setLimits({ maxIssuancesPerHour: 5 })).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 5, maxIssuancesPerWeekPerDomain: 40 });
    expect(await s.setLimits({ maxNamesPerProject: 1000 })).toEqual({ maxNamesPerProject: 1000, maxIssuancesPerHour: 5, maxIssuancesPerWeekPerDomain: 40 });
    expect(await make().limits()).toEqual({ maxNamesPerProject: 1000, maxIssuancesPerHour: 5, maxIssuancesPerWeekPerDomain: 40 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "domain.dynamic_limits" }));
    s.close();
  });

  it.each([
    [{ maxNamesPerProject: 9 }],
    [{ maxNamesPerProject: 5001 }],
    [{ maxIssuancesPerHour: 0 }],
    [{ maxIssuancesPerHour: 101 }],
    [{ maxIssuancesPerHour: 2.5 }],
    [{ maxNamesPerProject: Number.NaN }],
  ])("valor fora da faixa %j é recusado, sem ajuste em silêncio", async (input) => {
    const s = make();
    expect(await code(s.setLimits(input))).toMatchObject({ statusCode: 400, code: "invalid_dynamic_limit" });
    expect(await s.limits()).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 });
    s.close();
  });

  it("limites nos extremos da faixa valem", async () => {
    const s = make();
    expect(await s.setLimits({ maxNamesPerProject: 10, maxIssuancesPerHour: 1 })).toEqual({ maxNamesPerProject: 10, maxIssuancesPerHour: 1, maxIssuancesPerWeekPerDomain: 40 });
    expect(await s.setLimits({ maxNamesPerProject: 5000, maxIssuancesPerHour: 100 })).toEqual({ maxNamesPerProject: 5000, maxIssuancesPerHour: 100, maxIssuancesPerWeekPerDomain: 40 });
    s.close();
  });
});

describe("ask — quem pode receber certificado", () => {
  it("nome desconhecido, inválido, curinga e IP: não", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    for (const host of ["desconhecido.example", "", "*.cliente.example", "203.0.113.5", "localhost", "a.cliente.example/x", "a b.example"]) {
      expect((await s.authorize(host)).allow, host).toBe(false);
    }
    expect(await s.authorize("desconhecido.example")).toEqual({ allow: false, reason: "unknown" });
    expect(await s.authorize("203.0.113.5")).toEqual({ allow: false, reason: "invalid" });
    s.close();
  });

  it("nome cadastrado: sim, em qualquer caixa e com ponto final", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    expect(await s.authorize("A.Cliente.Example.")).toEqual({ allow: true });
    s.close();
  });

  it("nome removido deixa de ser autorizado", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    await s.remove("p1", "a.cliente.example");
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "unknown" });
    s.close();
  });

  it("nome que virou site fixo, painel ou e-mail: não, mesmo cadastrado ou sob sufixo aberto", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: true }]);
    await s.add("p1", "a.cliente.example");
    occupied.set("a.cliente.example", "project");
    occupied.set("painel.saas.example", "panel");
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "reserved" });
    expect(await s.authorize("painel.saas.example")).toEqual({ allow: false, reason: "reserved" });
    s.close();
  });

  it("sufixo fechado não autoriza o que não foi cadastrado; aberto autoriza só um nível e cadastra o nome", async () => {
    const s = make();
    await s.setSuffixes("p1", [
      { suffix: "fechado.example", openAll: false },
      { suffix: "aberto.example", openAll: true },
    ]);
    expect(await s.authorize("x.fechado.example")).toEqual({ allow: false, reason: "unknown" });
    expect(await s.authorize("a.b.aberto.example")).toEqual({ allow: false, reason: "unknown" });
    expect(await s.authorize("aberto.example")).toEqual({ allow: false, reason: "unknown" });
    expect(await s.authorize("novo.aberto.example")).toEqual({ allow: true });
    expect((await s.names()).find((n) => n.host === "novo.aberto.example")).toEqual({ host: "novo.aberto.example", projectId: "p1" });
    const view = await s.view("p1");
    expect(view.items.find((i) => i.host === "novo.aberto.example")).toMatchObject({ addedBy: "acesso", via: "suffix" });
    s.close();
  });

  it("sufixo aberto também respeita o teto de nomes do projeto", async () => {
    const s = make();
    await s.setLimits({ maxNamesPerProject: 10 });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    for (let i = 0; i < 10; i++) expect((await s.authorize(`c${i}.aberto.example`)).allow).toBe(true);
    expect(await s.authorize("c10.aberto.example")).toEqual({ allow: false, reason: "name_limit" });
    // quem já está cadastrado continua autorizado (renovação)
    expect((await s.authorize("c3.aberto.example")).allow).toBe(true);
    expect((await s.names()).length).toBe(10);
    s.close();
  });

  it("20 emissões novas por hora; a 21ª é recusada e a janela volta a liberar depois de 1 h", async () => {
    const s = make();
    for (let i = 0; i < 25; i++) await s.add("p1", `c${i}.cliente.example`);
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) results.push((await s.authorize(`c${i}.cliente.example`)).allow);
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await s.authorize("c20.cliente.example")).toEqual({ allow: false, reason: "hourly_limit" });
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(20);
    clock += HOUR + 1;
    expect((await s.authorize("c20.cliente.example")).allow).toBe(true);
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(1);
    s.close();
  });

  it("o teto por hora é ajustável: com 2, só 2 passam", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 2 });
    for (const n of ["a", "b", "c"]) await s.add("p1", `${n}.cliente.example`);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect((await s.authorize("b.cliente.example")).allow).toBe(true);
    expect(await s.authorize("c.cliente.example")).toEqual({ allow: false, reason: "hourly_limit" });
    s.close();
  });

  it("a cota vale para o painel inteiro, não por projeto", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    await s.add("p1", "a.cliente.example");
    await s.add("p2", "b.cliente.example");
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect(await s.authorize("b.cliente.example")).toEqual({ allow: false, reason: "hourly_limit" });
    s.close();
  });

  it("o mesmo pedido chegando várias vezes em seguida conta uma emissão só", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    await s.add("p1", "a.cliente.example");
    for (let i = 0; i < 5; i++) expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(1);
    s.close();
  });

  it("o mesmo nome tem no máximo 3 tentativas novas por hora (5 falhas/h é o limite do Let's Encrypt)", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    for (let i = 0; i < 3; i++) {
      expect((await s.authorize("a.cliente.example")).allow).toBe(true);
      clock += 2 * 60_000;
    }
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "name_cooldown" });
    clock += HOUR;
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    s.close();
  });

  it("nome com certificado já emitido (renovação) passa sem gastar a cota nem a tentativa", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    await s.add("p1", "velho.cliente.example");
    await s.add("p1", "novo.cliente.example");
    const valid = { ok: true, issuer: "LE", validFrom: new Date(clock - HOUR).toISOString(), validTo: new Date(clock + 30 * 24 * HOUR).toISOString(), error: null };
    expect(await s.reconcileIssued(new Map([["velho.cliente.example", valid]]))).toBe(1);
    expect((await s.authorize("novo.cliente.example")).allow).toBe(true); // gasta a única da hora
    for (let i = 0; i < 10; i++) {
      clock += 2 * 60_000;
      expect((await s.authorize("velho.cliente.example")).allow).toBe(true);
    }
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(1);
    s.close();
  });

  it("reconcileIssued: ignora certificado vencido, de nome fora da lista, nome já marcado e leitura que falhou", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    const expired = { ok: true, issuer: "LE", validFrom: null, validTo: new Date(clock - 1000).toISOString(), error: null };
    const failed = { ok: false, issuer: null, validFrom: null, validTo: null, error: "x" };
    expect(await s.reconcileIssued(null)).toBe(0);
    expect(await s.reconcileIssued(new Map([["a.cliente.example", expired], ["fora.example", expired]]))).toBe(0);
    expect(await s.reconcileIssued(new Map([["a.cliente.example", failed]]))).toBe(0);
    const ok = { ...expired, validTo: new Date(clock + HOUR).toISOString() };
    expect(await s.reconcileIssued(new Map([["a.cliente.example", ok]]))).toBe(1);
    expect(await s.reconcileIssued(new Map([["a.cliente.example", ok]]))).toBe(0);
    s.close();
  });

  it("arquivo ilegível: nada é autorizado (falha fechada) e o arquivo não é apagado", async () => {
    await writeFile(path.join(dir, "dynamic-domains.json"), "{ isto não é json");
    const s = make();
    await expect(s.authorize("a.cliente.example")).rejects.toThrow(/ilegível/);
    await expect(s.add("p1", "a.cliente.example")).rejects.toThrow();
    expect(await readFile(path.join(dir, "dynamic-domains.json"), "utf8")).toBe("{ isto não é json");
    await s.preload();
    expect(logs.join()).toContain("ilegível");
    s.close();
  });

  it("formato desconhecido ou registro inválido no arquivo também falham fechado", async () => {
    for (const bad of [
      { version: 2, projects: {} },
      { version: 1, projects: [] },
      { version: 1, projects: { p1: null } },
      null,
      "texto",
      { version: 1, projects: { p1: { suffixes: [], names: ["a.cliente.example"] } } },
      { version: 1, projects: { p1: { suffixes: [], names: [{ host: "a.cliente.example", addedAt: 5, addedBy: "x" }] } } },
      { version: 1, projects: { p1: { suffixes: [], names: [{ host: "a.cliente.example", addedAt: "t", addedBy: 5 }] } } },
      { version: 1, projects: { p1: { suffixes: [], names: [{ host: "a.cliente.example", addedAt: "t", addedBy: "x", issuedAt: 7 }] } } },
      { version: 1, projects: { p1: { suffixes: ["saas.example"], names: [] } } },
      { version: 1, projects: { p1: { suffixes: [{ suffix: "saas.example", openAll: "sim" }], names: [] } } },
      { version: 1, projects: { p1: { suffixes: [{ suffix: 5, openAll: true }], names: [] } } },
    ]) {
      await writeFile(path.join(dir, "dynamic-domains.json"), JSON.stringify(bad));
      await expect(make().authorize("a.cliente.example")).rejects.toThrow(/ilegível/);
    }
  });

  it("tetos gravados fora da faixa (arquivo editado à mão) são ignorados", async () => {
    await writeFile(
      path.join(dir, "dynamic-domains.json"),
      JSON.stringify({ version: 1, settings: { maxNamesPerProject: 99999, maxIssuancesPerHour: "muitos" }, projects: {} }),
    );
    expect(await make().limits()).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 });
  });

  it("o controle de tentativas por nome não cresce sem limite", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 100 });
    // simula muitos nomes antigos acumulados no mapa
    const attempts = (s as unknown as { attempts: Map<string, number[]> }).attempts;
    for (let i = 0; i < 5005; i++) attempts.set(`velho${i}.example`, [clock - 3 * HOUR]);
    await s.add("p1", "a.cliente.example");
    await s.authorize("a.cliente.example");
    expect(attempts.size).toBeLessThan(10);
    s.close();
  });
});

describe("tela", () => {
  const item = (host: string, state: CertificateItem["state"], extra: Partial<CertificateItem> = {}): Partial<CertificateItem> => ({
    host,
    state,
    validTo: null,
    lastError: null,
    failure: null,
    ...extra,
  });

  it("contadores por estado, mensagem de falha, validade e estado desconhecido tratado como aguardando", async () => {
    const s = make();
    for (const h of ["a", "b", "c", "d", "e", "f", "g"]) await s.add("p1", `${h}.cliente.example`);
    certItems = [
      item("a.cliente.example", "valid", { validTo: "2027-01-01T00:00:00.000Z" }),
      item("b.cliente.example", "expiring"),
      item("c.cliente.example", "expired"),
      item("d.cliente.example", "issuing"),
      item("e.cliente.example", "failed", { lastError: { cause: "dns", message: "O DNS não aponta para a VPS.", detail: null, at: null, retryAfter: null } }),
      item("f.cliente.example", "unknown"),
      // g sem item: aguardando
    ];
    const v = await s.view("p1");
    expect(v.counters).toEqual({ total: 7, waiting: 2, issuing: 1, valid: 1, expiring: 1, expired: 1, failed: 1 });
    expect(v.items.find((i) => i.host === "a.cliente.example")).toMatchObject({ state: "valid", validTo: "2027-01-01T00:00:00.000Z", message: null });
    expect(v.items.find((i) => i.host === "e.cliente.example")).toMatchObject({ state: "failed", message: "O DNS não aponta para a VPS." });
    expect(v.routing).toEqual({ ready: true, reason: null });
    expect(v.limits).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 });
    expect(v.usage).toEqual({ names: 7, issuancesLastHour: 0 });
    s.close();
  });

  it("a causa da falha também vem do resumo de falhas repetidas", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    certItems = [
      item("a.cliente.example", "failed", {
        failure: { rounds: 3, firstAt: null, lastAt: null, error: { cause: "firewall", message: "Portas 80/443 fechadas.", detail: null, at: null, retryAfter: null } },
      }),
    ];
    expect((await s.view("p1")).items[0]!.message).toBe("Portas 80/443 fechadas.");
    s.close();
  });

  it("busca, filtro por estado e paginação (as centenas de nomes)", async () => {
    const s = make();
    await s.setLimits({ maxNamesPerProject: 1000 });
    for (let i = 0; i < 130; i++) {
      clock += 1000;
      await s.add("p1", `n${String(i).padStart(3, "0")}.${i % 2 ? "par" : "impar"}.example`);
    }
    certItems = [item("n001.par.example", "valid"), item("n003.par.example", "valid")];
    const first = await s.view("p1", { pageSize: 50 });
    expect(first).toMatchObject({ total: 130, page: 1, pageSize: 50 });
    expect(first.items).toHaveLength(50);
    // mais recentes primeiro
    expect(first.items[0]!.host).toBe("n129.par.example");
    const last = await s.view("p1", { pageSize: 50, page: 3 });
    expect(last.items).toHaveLength(30);
    // página além do fim volta para a última
    expect((await s.view("p1", { pageSize: 50, page: 99 })).page).toBe(3);
    expect((await s.view("p1", { page: 0 })).page).toBe(1);
    const busca = await s.view("p1", { q: " N00 " });
    expect(busca.total).toBe(10);
    expect((await s.view("p1", { state: "valid" })).items.map((i) => i.host).sort()).toEqual(["n001.par.example", "n003.par.example"]);
    expect((await s.view("p1", { q: "impar", state: "valid" })).total).toBe(0);
    // o contador não depende do filtro
    expect((await s.view("p1", { state: "valid" })).counters.total).toBe(130);
    s.close();
  });

  it("projeto sem nomes: lista vazia e nenhuma consulta de certificados", async () => {
    const inspect = vi.fn(async () => []);
    const s = make({ inspect });
    const v = await s.view("p1");
    expect(v).toMatchObject({ total: 0, items: [], counters: { total: 0 }, suffixes: [] });
    expect(inspect).not.toHaveBeenCalled();
    s.close();
  });

  it("um nome só (acompanhar aguardando DNS → válido)", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    certItems = [item("a.cliente.example", "valid", { validTo: "2027-01-01T00:00:00.000Z" })];
    expect(await s.one("p1", "A.cliente.example")).toMatchObject({ host: "a.cliente.example", state: "valid" });
    certItems = [];
    expect((await s.one("p1", "a.cliente.example")).state).toBe("waiting");
    expect(await code(s.one("p1", "outro.cliente.example"))).toMatchObject({ statusCode: 404 });
    expect(await code(s.one("p1", ""))).toMatchObject({ statusCode: 404 });
    s.close();
  });

  it("proxy sem rota (painel sem HTTPS): a tela diz por quê", async () => {
    const s = make({ routing: () => ({ ready: false, reason: "sem HTTPS" }) });
    expect((await s.view("p1")).routing).toEqual({ ready: false, reason: "sem HTTPS" });
    s.close();
  });
});

describe("dynamicRouting — o proxy alcança o painel?", () => {
  const ok = { inContainer: true, askPort: 9101, panelServed: true, panelContainer: "tws-panel", askPath: "/caddy/ask" };

  it("pronto: dá a URL interna do ask", () => {
    expect(dynamicRouting(ok)).toEqual({ askUrl: "http://tws-panel:9101/caddy/ask", ready: true, reason: null });
  });

  it.each([
    ["fora de container", { inContainer: false }, /não está rodando em container/],
    ["porta desligada", { askPort: 0 }, /PAAS_ASK_PORT=0/],
    ["painel sem HTTPS pelo Caddy", { panelServed: false }, /servido por HTTPS/],
  ])("%s: sem URL e com o motivo", (_label, over, reason) => {
    const r = dynamicRouting({ ...ok, ...over });
    expect(r.askUrl).toBeNull();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(reason);
  });
});

describe("persistência — lacunas", () => {
  it("sufixos gravados voltam iguais quando o painel reinicia", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: true }]);
    await s.flush();
    s.close();
    const again = make();
    expect((await again.view("p1")).suffixes).toEqual([{ suffix: "saas.example", openAll: true }]);
    again.close();
  });

  it("sem função de log própria, falha da auditoria não derruba o cadastro (e erro que não é Error também)", async () => {
    const s = make({
      log: undefined,
      audit: {
        record: async () => {
          throw "texto solto";
        },
      },
    });
    expect((await s.add("p1", "a.cliente.example")).created).toBe(true);
    s.close();
  });

  it("registro implícito: nome já registrado por outro acesso simultâneo não duplica", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: true }]);
    const internal = s as unknown as { registerImplicit(projectId: string, host: string): Promise<void> };
    await internal.registerImplicit("p1", "novo.saas.example");
    await internal.registerImplicit("p1", "novo.saas.example");
    expect((await s.names()).filter((n) => n.host === "novo.saas.example")).toHaveLength(1);
    s.close();
  });

  it("registro implícito: disco falhando é registrado em log e não propaga", async () => {
    const s = make();
    await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: true }]);
    await s.flush();
    await rm(path.join(dir, "dynamic-domains.json"));
    await mkdir(path.join(dir, "dynamic-domains.json"));
    const internal = s as unknown as { registerImplicit(projectId: string, host: string): Promise<void> };
    await expect(internal.registerImplicit("p1", "falha.saas.example")).resolves.toBeUndefined();
    expect(logs.join()).toContain("nome autorizado não gravado");
    s.close();
  });
});

const exists = async (file: string) => (await readFile(file, "utf8").then(() => true, () => false));

describe("sufixo que cobre nome de outro projeto (M1) e domínio de aplicações (B1)", () => {
  it("projeto 2 não pode criar um sufixo que cubra um nome cadastrado do projeto 1 (e vice-versa já era recusado)", async () => {
    const s = make();
    await s.add("p1", "loja.saas.example");
    expect(await code(s.setSuffixes("p2", [{ suffix: "saas.example", openAll: false }]))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    expect(await s.proxyProjects()).toEqual([{ projectId: "p1", suffixes: [], hosts: ["loja.saas.example"] }]);
    // a ordem inversa: o sufixo já é do projeto 1, o nome do projeto 2 sob ele é recusado
    await s.setSuffixes("p1", [{ suffix: "outro.example", openAll: false }]);
    expect(await code(s.add("p2", "x.outro.example"))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    // dois níveis abaixo não é coberto pelo curinga
    expect((await s.setSuffixes("p2", [{ suffix: "y.saas.example", openAll: false }])).length).toBe(1);
    // o dono do nome pode ter o sufixo
    expect((await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }])).length).toBe(1);
    s.close();
  });

  it("sufixo que cobre site fixo de OUTRO projeto é recusado; o do próprio projeto passa; painel e e-mail sob o sufixo são permitidos (R2-2)", async () => {
    const fixed = [
      { host: "painel.saas.example", projectId: null },
      { host: "mail.saas.example", projectId: null },
      { host: "site.saas.example", projectId: "p1" },
    ];
    const s = make({ fixedHostsUnder: async (suffix) => (suffix === "saas.example" ? fixed : []) });
    expect(await code(s.setSuffixes("p2", [{ suffix: "saas.example", openAll: false }]))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    // o dono do site fixo: o painel e o e-mail (sem projeto) não impedem
    expect((await s.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }])).length).toBe(1);
    // só painel e e-mail sob o sufixo: passa para qualquer projeto
    const onlyShared = make({
      fixedHostsUnder: async () => [
        { host: "painel.seu-saas.example", projectId: null },
        { host: "mail.seu-saas.example", projectId: null },
      ],
    });
    expect((await onlyShared.setSuffixes("p2", [{ suffix: "seu-saas.example", openAll: true }])).length).toBe(1);
    // e o ask continua respondendo "reservado" para o nome do painel dentro do sufixo
    occupied.set("painel.seu-saas.example", "panel");
    expect(await onlyShared.authorize("painel.seu-saas.example")).toEqual({ allow: false, reason: "reserved" });
    onlyShared.close();
    const onlyOwn = make({ fixedHostsUnder: async () => [{ host: "site.saas.example", projectId: "p1" }] });
    expect((await onlyOwn.setSuffixes("p1", [{ suffix: "saas.example", openAll: false }])).length).toBe(1);
    onlyOwn.close();
    s.close();
  });

  it("sufixo igual ao domínio de aplicações ou abaixo dele é recusado; um sufixo PAI da base e outros passam (R2-3)", async () => {
    const s = make({ appsBase: async () => "apps.example.com" });
    for (const suffix of ["apps.example.com", "cliente.apps.example.com"]) {
      expect(await code(s.setSuffixes("p1", [{ suffix, openAll: false }]))).toMatchObject({ statusCode: 409, code: "domain_in_use" });
    }
    // o curinga é de um nível: example.com não alcança x.apps.example.com
    expect((await s.setSuffixes("p1", [{ suffix: "example.com", openAll: false }])).length).toBe(1);
    expect((await s.setSuffixes("p1", [{ suffix: "clientes.example.org", openAll: false }])).length).toBe(1);
    s.close();
  });

  it("nome de hospedagem compartilhada (github.io, sslip.io) é recusado no cadastro", async () => {
    const s = make();
    for (const host of ["app.github.io", "x.sslip.io"]) {
      const err = (await s.add("p1", host).then(() => null, (e: unknown) => e)) as { statusCode: number; details: { issue: string } };
      expect(err.statusCode).toBe(400);
      expect(err.details.issue).toBe("shared_hosting");
    }
    s.close();
  });
});

describe("ask — DNS antes da cota (M2)", () => {
  it("nome que não aponta para a VPS é recusado SEM gastar emissão nem tentativa; ao apontar, a cota é gasta uma vez", async () => {
    let points = false;
    const pointsHere = vi.fn(async () => points);
    const s = make({ pointsHere });
    await s.setLimits({ maxIssuancesPerHour: 1 });
    await s.add("p1", "a.cliente.example");
    for (let i = 0; i < 6; i++) {
      clock += 2 * 60_000;
      expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "dns" });
    }
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(0);
    points = true;
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(1);
    s.close();
  });

  it("sufixo aberto: nome sem DNS não vira cadastro, não ocupa vaga e não gasta cota", async () => {
    const s = make({ pointsHere: async () => false });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    expect(await s.authorize("fantasma.aberto.example")).toEqual({ allow: false, reason: "dns" });
    expect(await s.names()).toEqual([]);
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(0);
    s.close();
  });

  it("renovação (certificado já visto) não consulta o DNS", async () => {
    const pointsHere = vi.fn(async () => false);
    const s = make({ pointsHere });
    await s.add("p1", "velho.cliente.example");
    const valid = { ok: true, issuer: "LE", validFrom: null, validTo: new Date(clock + 30 * 24 * HOUR).toISOString(), error: null };
    await s.reconcileIssued(new Map([["velho.cliente.example", valid]]));
    expect((await s.authorize("velho.cliente.example")).allow).toBe(true);
    expect(pointsHere).not.toHaveBeenCalled();
    s.close();
  });

  it("nome reservado ou desconhecido nem chega ao DNS", async () => {
    const pointsHere = vi.fn(async () => true);
    occupied.set("painel.cliente.example", "panel");
    const s = make({ pointsHere });
    await s.add("p1", "ok.cliente.example");
    await s.authorize("painel.cliente.example");
    await s.authorize("naocadastrado.cliente.example");
    expect(pointsHere).not.toHaveBeenCalled();
    s.close();
  });
});

describe("ask — teto semanal por domínio registrado (D1)", () => {
  it("o 3º nome do mesmo domínio na semana é recusado com teto 2; outro domínio e a semana seguinte liberam", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerWeekPerDomain: 2 });
    for (const h of ["a.cliente.example", "b.cliente.example", "c.cliente.example", "a.outro.example"]) await s.add("p1", h);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect((await s.authorize("b.cliente.example")).allow).toBe(true);
    expect(await s.authorize("c.cliente.example")).toEqual({ allow: false, reason: "weekly_limit" });
    expect((await s.authorize("a.outro.example")).allow).toBe(true); // outro domínio registrado
    clock += 6 * 24 * HOUR;
    expect(await s.authorize("c.cliente.example")).toEqual({ allow: false, reason: "weekly_limit" });
    clock += 25 * HOUR; // passou de 7 dias desde a primeira
    expect((await s.authorize("c.cliente.example")).allow).toBe(true);
    s.close();
  });

  it("sufixo aberto: um estranho não esgota os 50 do Let's Encrypt (para no teto, 40 por padrão)", async () => {
    const s = make();
    await s.setLimits({ maxNamesPerProject: 1000, maxIssuancesPerHour: 100 });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    let allowed = 0;
    for (let i = 0; i < 60; i++) if ((await s.authorize(`n${i}.aberto.example`)).allow) allowed++;
    expect(allowed).toBe(40);
    s.close();
  });

  it("o teto semanal tem faixa 1 a 49 e é gravado como os outros", async () => {
    const s = make();
    for (const bad of [0, 50, 2.5]) expect(await code(s.setLimits({ maxIssuancesPerWeekPerDomain: bad }))).toMatchObject({ statusCode: 400 });
    expect((await s.setLimits({ maxIssuancesPerWeekPerDomain: 49 })).maxIssuancesPerWeekPerDomain).toBe(49);
    expect((await make().limits()).maxIssuancesPerWeekPerDomain).toBe(49);
    s.close();
  });

  it("tentativas repetidas do mesmo pedido em 60 s contam uma só vez na semana", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerWeekPerDomain: 1 });
    await s.add("p1", "a.cliente.example");
    for (let i = 0; i < 5; i++) expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    s.close();
  });
});

describe("ask — reserva atômica de vaga (B2), projeto apagado (B4) e tentativas (M32)", () => {
  it("25 consultas simultâneas a um sufixo aberto com teto de 10: no máximo 10 passam e 10 nomes ficam", async () => {
    const s = make({
      // espera real antes da decisão: todas chegam juntas ao ponto da reserva
      staticOccupant: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return null;
      },
    });
    await s.setLimits({ maxNamesPerProject: 10, maxIssuancesPerHour: 100 });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => s.authorize(`c${i}.aberto.example`)));
    expect(results.filter((r) => r.allow)).toHaveLength(10);
    expect(results.filter((r) => !r.allow && r.reason === "name_limit")).toHaveLength(15);
    expect((await s.names()).length).toBe(10);
    s.close();
  });

  it("projeto apagado (limpeza dos nomes falhou): nada mais é autorizado, nem nome cadastrado nem sufixo aberto", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    projects.delete("p1");
    try {
      expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "unknown" });
      expect(await s.authorize("x.aberto.example")).toEqual({ allow: false, reason: "unknown" });
    } finally {
      projects.add("p1");
    }
    s.close();
  });

  it("remover e cadastrar de novo não zera as tentativas do nome na hora (3 por hora valem para o nome)", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    for (let i = 0; i < 3; i++) {
      expect((await s.authorize("a.cliente.example")).allow).toBe(true);
      clock += 2 * 60_000;
    }
    await s.remove("p1", "a.cliente.example");
    await s.add("p1", "a.cliente.example");
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "name_cooldown" });
    s.close();
  });
});

describe("certificado vencido volta a gastar cota (B7) e contador global escondido (B6)", () => {
  it("emitido e depois visto vencido: deixa de ser renovação, gasta cota de novo", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    await s.add("p1", "a.cliente.example");
    await s.add("p1", "b.cliente.example");
    const valid = { ok: true, issuer: "LE", validFrom: null, validTo: new Date(clock + HOUR).toISOString(), error: null };
    expect(await s.reconcileIssued(new Map([["a.cliente.example", valid]]))).toBe(1);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true); // renovação, sem cota
    expect((await s.view("p1")).usage.issuancesLastHour).toBe(0);
    clock += 3 * HOUR;
    const expired = { ...valid, validTo: new Date(clock - HOUR).toISOString() };
    expect(await s.reconcileIssued(new Map([["a.cliente.example", expired]]))).toBe(1);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true); // agora é emissão nova: gasta a única da hora
    expect(await s.authorize("b.cliente.example")).toEqual({ allow: false, reason: "hourly_limit" });
    s.close();
  });

  it("token de um projeto só: o contador do servidor vem nulo; sem a opção, vem o número", async () => {
    const s = make();
    await s.add("p1", "a.cliente.example");
    await s.authorize("a.cliente.example");
    expect((await s.view("p1", {}, { hideGlobalUsage: true })).usage).toEqual({ names: 1, issuancesLastHour: null });
    expect((await s.view("p1")).usage).toEqual({ names: 1, issuancesLastHour: 1 });
    s.close();
  });
});

describe("arquivo ilegível: o Caddyfile mantém a última lista boa (B3)", () => {
  it("guarda a última lista boa, usa-a quando o arquivo estraga e avisa a pessoa; o arquivo estragado não é apagado", async () => {
    const first = make();
    await first.add("p1", "a.cliente.example");
    await first.setSuffixes("p1", [{ suffix: "clientes.example", openAll: false }]);
    await first.flush();
    const good = path.join(dir, "dynamic-domains.lastgood.json");
    await vi.waitFor(async () => expect(await exists(good)).toBe(true));
    await vi.waitFor(async () => expect(JSON.parse(await readFile(good, "utf8")).projects.p1.suffixes).toHaveLength(1));
    first.close();

    await writeFile(path.join(dir, "dynamic-domains.json"), "{ estragado");
    const warned: string[] = [];
    const s = make({ onUnreadable: (m) => warned.push(m) });
    expect(await s.proxyProjects()).toEqual([{ projectId: "p1", suffixes: ["clientes.example"], hosts: ["a.cliente.example"] }]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/ilegível/);
    await expect(s.authorize("a.cliente.example")).rejects.toThrow(/ilegível/); // o ask continua fechado
    expect(await readFile(path.join(dir, "dynamic-domains.json"), "utf8")).toBe("{ estragado");
    s.close();
  });

  it("sem cópia boa e com o arquivo ilegível: o erro sobe (o Caddyfile não é refeito às cegas)", async () => {
    await writeFile(path.join(dir, "dynamic-domains.json"), "{ estragado");
    const warned: string[] = [];
    const s = make({ onUnreadable: (m) => warned.push(m) });
    await expect(s.proxyProjects()).rejects.toThrow(/ilegível/);
    expect(warned).toHaveLength(1);
    s.close();
  });

  it("cópia boa que não dá para gravar só vai para o log (o painel segue)", async () => {
    await mkdir(path.join(dir, "dynamic-domains.lastgood.json"));
    const s = make();
    await s.add("p1", "a.cliente.example");
    await s.flush();
    await vi.waitFor(() => expect(logs.join()).toContain("última lista boa não gravada"));
    s.close();
  });
});

describe("teto semanal sobrevive ao reinício (R2-4)", () => {
  it("2 de 2 usados, reinicia o painel: o 3º continua recusado; passada a semana, libera", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerWeekPerDomain: 2 });
    for (const h of ["a.cliente.example", "b.cliente.example", "c.cliente.example"]) await s.add("p1", h);
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    expect((await s.authorize("b.cliente.example")).allow).toBe(true);
    await s.flush();
    s.close();
    const restarted = make();
    expect(await restarted.authorize("c.cliente.example")).toEqual({ allow: false, reason: "weekly_limit" });
    restarted.close();
    clock += 8 * 24 * HOUR;
    const later = make();
    expect((await later.authorize("c.cliente.example")).allow).toBe(true);
    await later.flush();
    // a janela vencida não fica no arquivo
    const saved = JSON.parse(await readFile(path.join(dir, "dynamic-domains.usage.json"), "utf8")) as { weekly: Record<string, number[]> };
    expect(saved.weekly["cliente.example"]).toHaveLength(1);
    later.close();
  });

  it("instantes com mais de 7 dias não contam na carga e não ficam no arquivo", async () => {
    await writeFile(path.join(dir, "dynamic-domains.json"), JSON.stringify({ version: 1, settings: {}, projects: { p1: { suffixes: [], names: [] } } }));
    const old = clock - 8 * 24 * HOUR;
    await writeFile(path.join(dir, "dynamic-domains.usage.json"), JSON.stringify({ weekly: { "velho.example": [old, old + 1000], "novo.example": [clock - HOUR] } }));
    const s = make();
    await s.setLimits({ maxIssuancesPerWeekPerDomain: 1 });
    await s.add("p1", "a.velho.example");
    await s.add("p1", "a.novo.example");
    await s.add("p1", "b.outro.example");
    // os instantes velhos foram descartados na carga: ainda cabe 1
    expect((await s.authorize("a.velho.example")).allow).toBe(true);
    // o recente conta
    expect(await s.authorize("a.novo.example")).toEqual({ allow: false, reason: "weekly_limit" });
    // passam 8 dias; outra emissão regrava o arquivo sem o que venceu
    clock += 8 * 24 * HOUR;
    expect((await s.authorize("b.outro.example")).allow).toBe(true);
    await s.flush();
    const saved = JSON.parse(await readFile(path.join(dir, "dynamic-domains.usage.json"), "utf8")) as { weekly: Record<string, number[]> };
    expect(Object.keys(saved.weekly)).toEqual(["outro.example"]);
    s.close();
  });

  it("arquivo de contagem ausente, torto ou com lixo é tolerado (janela vazia)", async () => {
    await writeFile(path.join(dir, "dynamic-domains.json"), JSON.stringify({ version: 1, settings: {}, projects: { p1: { suffixes: [], names: [] } } }));
    for (const bad of ["{ torto", JSON.stringify({ weekly: { "x.example": "texto", "y.example": [1, "a", null] } }), JSON.stringify({})]) {
      await writeFile(path.join(dir, "dynamic-domains.usage.json"), bad);
      const s = make();
      await s.setLimits({ maxIssuancesPerWeekPerDomain: 1 });
      await s.add("p1", "a.y.example");
      expect((await s.authorize("a.y.example")).allow).toBe(true);
      await s.flush();
      s.close();
    }
  });

  it("contagem que não dá para gravar só vai para o log (o painel segue)", async () => {
    await mkdir(path.join(dir, "dynamic-domains.usage.json"));
    const s = make();
    await s.add("p1", "a.cliente.example");
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    await s.flush();
    expect(logs.join()).toContain("contagem semanal não gravada");
    s.close();
  });
});

describe("nome antigo que as regras novas recusam é descartado, não derruba o arquivo (R2-5)", () => {
  it("mantém o resto e avisa uma vez", async () => {
    await writeFile(
      path.join(dir, "dynamic-domains.json"),
      JSON.stringify({
        version: 1,
        settings: {},
        projects: {
          p1: {
            suffixes: [
              { suffix: "com.br", openAll: false },
              { suffix: "clientes.example", openAll: false },
            ],
            names: [
              { host: "app.x.github.io", addedAt: "t", addedBy: "x" },
              { host: "*.x.example", addedAt: "t", addedBy: "x" },
              { host: "a.cliente.example", addedAt: "t", addedBy: "x" },
            ],
          },
        },
      }),
    );
    const discarded: string[] = [];
    const s = make({ onDiscarded: (m) => discarded.push(m) });
    expect((await s.names()).map((n) => n.host)).toEqual(["a.cliente.example"]);
    expect(await s.proxyProjects()).toEqual([{ projectId: "p1", suffixes: ["clientes.example"], hosts: ["a.cliente.example"] }]);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatch(/2 nome\(s\) e 1 sufixo\(s\)/);
    expect(logs.join()).toMatch(/descartados/);
    s.close();
  });

  it("sem nada a descartar não avisa", async () => {
    const discarded = vi.fn();
    const s = make({ onDiscarded: discarded });
    await s.add("p1", "a.cliente.example");
    await s.flush();
    s.close();
    const again = make({ onDiscarded: discarded });
    await again.names();
    expect(discarded).not.toHaveBeenCalled();
    again.close();
  });
});

describe("arquivo ilegível: renovação de nome que já tem certificado continua (R2-6)", () => {
  async function withIssued(): Promise<void> {
    const s = make();
    await s.add("p1", "a.cliente.example");
    await s.add("p1", "nova.cliente.example");
    const valid = { ok: true, issuer: "LE", validFrom: null, validTo: new Date(clock + 30 * 24 * HOUR).toISOString(), error: null };
    expect(await s.reconcileIssued(new Map([["a.cliente.example", valid]]))).toBe(1);
    await s.flush();
    s.close();
    await writeFile(path.join(dir, "dynamic-domains.json"), "{ estragado");
  }

  it("renova o que já tinha certificado, sem cota nem DNS; nome novo e desconhecido seguem negados (erro)", async () => {
    await withIssued();
    const pointsHere = vi.fn(async () => false);
    const s = make({ pointsHere });
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: true });
    expect(pointsHere).not.toHaveBeenCalled();
    await expect(s.authorize("nova.cliente.example")).rejects.toThrow(/ilegível/);
    await expect(s.authorize("desconhecido.cliente.example")).rejects.toThrow(/ilegível/);
    s.close();
  });

  it("a cópia boa lida fica em memória por um minuto e depois é lida de novo", async () => {
    await withIssued();
    const s = make();
    expect((await s.authorize("a.cliente.example")).allow).toBe(true);
    await rm(path.join(dir, "dynamic-domains.lastgood.json"));
    expect((await s.authorize("a.cliente.example")).allow).toBe(true); // ainda no cache
    clock += 61_000;
    await expect(s.authorize("a.cliente.example")).rejects.toThrow(/ilegível/);
    s.close();
  });

  it("nome que virou site fixo ou projeto removido não renova", async () => {
    await withIssued();
    occupied.set("a.cliente.example", "project");
    const s = make();
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "reserved" });
    occupied.clear();
    projects.delete("p1");
    clock += 61_000;
    expect(await s.authorize("a.cliente.example")).toEqual({ allow: false, reason: "unknown" });
    projects.add("p1");
    s.close();
  });
});

describe("sufixo aberto: consultas de DNS de nomes não cadastrados são limitadas (R2-8)", () => {
  it("passando de 10 ao mesmo tempo responde busy; o nome cadastrado não é afetado e as vagas voltam", async () => {
    const releases: Array<(v: boolean) => void> = [];
    const pointsHere = vi.fn((_host: string) => new Promise<boolean>((resolve) => releases.push(resolve)));
    const s = make({ pointsHere });
    await s.setLimits({ maxNamesPerProject: 1000, maxIssuancesPerHour: 100 });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    await s.add("p1", "cadastrado.cliente.example");
    const pending = Array.from({ length: MAX_UNREGISTERED_DNS_LOOKUPS }, (_, i) => s.authorize(`n${i}.aberto.example`));
    await vi.waitFor(() => expect(pointsHere).toHaveBeenCalledTimes(MAX_UNREGISTERED_DNS_LOOKUPS));
    expect(await s.authorize("excesso.aberto.example")).toEqual({ allow: false, reason: "busy" });
    // o cadastrado continua consultando
    const registered = s.authorize("cadastrado.cliente.example");
    await vi.waitFor(() => expect(pointsHere).toHaveBeenCalledTimes(MAX_UNREGISTERED_DNS_LOOKUPS + 1));
    releases.forEach((r) => r(false));
    expect((await Promise.all(pending)).every((d) => !d.allow)).toBe(true);
    expect((await registered).allow).toBe(false);
    // vagas devolvidas: a consulta seguinte volta a valer
    releases.length = 0;
    const next = s.authorize("depois.aberto.example");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!(true);
    expect((await next).allow).toBe(true);
    s.close();
  });

  it("consulta que falha devolve a vaga", async () => {
    const s = make({ pointsHere: async () => Promise.reject(new Error("dns")) });
    await s.setSuffixes("p1", [{ suffix: "aberto.example", openAll: true }]);
    for (let i = 0; i < MAX_UNREGISTERED_DNS_LOOKUPS + 3; i++) await expect(s.authorize(`n${i}.aberto.example`)).rejects.toThrow("dns");
    s.close();
  });
});

describe("IP público da VPS (R2-1)", () => {
  it("grava, normaliza, apaga com vazio e recusa texto, IP privado e família trocada", async () => {
    const s = make();
    expect(await s.publicIps()).toEqual({ manualIpv4: null, manualIpv6: null, effective: [] });
    const set = await s.setPublicIps({ publicIp: " 203.0.113.10 ", publicIpv6: "2001:db8::1" });
    expect(set).toEqual({ manualIpv4: "203.0.113.10", manualIpv6: "2001:db8::1", effective: ["203.0.113.10", "2001:db8::1"] });
    expect(s.manualIps()).toEqual(["203.0.113.10", "2001:db8::1"]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "domain.dynamic_public_ip" }));
    await s.flush();
    expect(await make().publicIps()).toMatchObject({ manualIpv4: "203.0.113.10" });
    for (const bad of ["abc", "10.0.0.5", "127.0.0.1", "0.0.0.0", "2001:db8::1", "192.168.1.1"]) {
      expect(await code(s.setPublicIps({ publicIp: bad }))).toMatchObject({ statusCode: 400, code: "invalid_public_ip" });
    }
    expect(await code(s.setPublicIps({ publicIpv6: "203.0.113.10" }))).toMatchObject({ statusCode: 400 });
    expect(await code(s.setPublicIps({ publicIpv6: "::" }))).toMatchObject({ statusCode: 400 });
    // só o IPv4 muda; o IPv6 fica
    expect((await s.setPublicIps({ publicIp: "" })).manualIpv4).toBeNull();
    expect((await s.publicIps()).manualIpv6).toBe("2001:db8::1");
    expect((await s.setPublicIps({ publicIpv6: null })).manualIpv6).toBeNull();
    expect((await s.setPublicIps({})).manualIpv4).toBeNull();
    s.close();
  });

  it("o efetivo vem do que o app informa (ownIps) e IP torto no arquivo é ignorado", async () => {
    await writeFile(
      path.join(dir, "dynamic-domains.json"),
      JSON.stringify({ version: 1, settings: { publicIp: "nao-ip", publicIpv6: "203.0.113.1" }, projects: {} }),
    );
    const s = make({ ownIps: () => ["203.0.113.50"] });
    expect(await s.publicIps()).toEqual({ manualIpv4: null, manualIpv6: null, effective: ["203.0.113.50"] });
    s.close();
  });

  it("o motivo do aviso tem o texto combinado", () => {
    expect(PUBLIC_IP_UNKNOWN_REASON).toContain("IP público da VPS desconhecido: nenhum certificado novo");
    expect(PUBLIC_IP_UNKNOWN_REASON).toContain("Configurações → Domínios dinâmicos");
  });
});
