/**
 * `ask` do Caddy para a política MTA-STS: o painel autoriza `mta-sts.<domínio>`
 * SÓ para domínio de e-mail cadastrado, com a mesma conferência de DNS e as
 * mesmas cotas de emissão dos demais nomes. Sem Docker e sem rede.
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicDomainsService, type DynamicDomainsDeps, type StaticOccupant } from "../src/services/dynamic-domains.js";
import { ASK_PATH, buildAskServer } from "../src/services/dynamic-ask-server.js";

let dir = "";
let clock = 0;
const HOUR = 3_600_000;
const projects = new Set(["p1"]);
let occupied = new Map<string, StaticOccupant>();
let mtaHosts: string[] = [];
let dnsOk = true;

function make(over: Partial<DynamicDomainsDeps> = {}): DynamicDomainsService {
  return new DynamicDomainsService({
    dataDir: dir,
    projectExists: async (id) => projects.has(id),
    staticOccupant: async (host) => occupied.get(host) ?? null,
    refreshProxy: vi.fn(async () => undefined),
    inspect: async () => [],
    routing: () => ({ ready: true, reason: null }),
    now: () => clock,
    refreshDelayMs: 40,
    pointsHere: async () => dnsOk,
    mtaStsHosts: async () => mtaHosts,
    ...over,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-dyn-sts-"));
  clock = Date.parse("2026-10-26T12:00:00Z");
  occupied = new Map();
  mtaHosts = ["mta-sts.example.com", "mta-sts.example.org"];
  dnsOk = true;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe("ask HTTP do Caddy — mta-sts.<domínio>", () => {
  it("200 para o mta-sts. de domínio de e-mail cadastrado e 403 para qualquer outro", async () => {
    const s = make();
    const server = buildAskServer({ authorize: (host) => s.authorize(host), secret: "a".repeat(48) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const status = (domain: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: `${ASK_PATH}?k=${"a".repeat(48)}&domain=${domain}` }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await status("mta-sts.example.com")).toBe(200);
      expect(await status("mta-sts.naocadastrado.example")).toBe(403);
      expect(await status("example.com")).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});

describe("ask — mta-sts.<domínio>", () => {
  it("autoriza o mta-sts. de domínio de e-mail cadastrado (sem projeto, sem teto de nomes)", async () => {
    const s = make();
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    expect(await s.authorize("MTA-STS.Example.COM.")).toEqual({ allow: true });
    s.close();
  });

  it("recusa mta-sts. de domínio que NÃO é de e-mail cadastrado", async () => {
    const s = make();
    expect(await s.authorize("mta-sts.naocadastrado.example")).toEqual({ allow: false, reason: "unknown" });
    // um sub-nível a mais não é o nome da política
    expect(await s.authorize("mta-sts.sub.example.com")).toEqual({ allow: false, reason: "unknown" });
    expect(await s.authorize("x.mta-sts.example.com")).toEqual({ allow: false, reason: "unknown" });
    // o próprio domínio de e-mail (sem o prefixo) também não ganha certificado por aqui
    expect(await s.authorize("example.com")).toEqual({ allow: false, reason: "unknown" });
    s.close();
  });

  it("sem a lista de domínios de e-mail (ou com ela falhando), nada de mta-sts. é autorizado", async () => {
    const semLista = make({ mtaStsHosts: undefined });
    expect(await semLista.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "unknown" });
    semLista.close();
    const falha = make({
      mtaStsHosts: async () => {
        throw new Error("e-mail indisponível");
      },
    });
    expect(await falha.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "unknown" });
    falha.close();
  });

  it("nome tomado por um site de projeto ou pelo painel fica reservado; o dono 'e-mail' passa", async () => {
    const s = make();
    occupied.set("mta-sts.example.com", "project");
    occupied.set("mta-sts.example.org", "mail");
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "reserved" });
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: true });
    occupied.set("mta-sts.example.org", "panel");
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: false, reason: "reserved" });
    s.close();
  });

  it("o DNS precisa apontar para a VPS ANTES de gastar cota", async () => {
    const s = make();
    dnsOk = false;
    for (let i = 0; i < 30; i++) expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "dns" });
    dnsOk = true;
    // nada foi gasto: a primeira com DNS certo passa
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    s.close();
  });

  it("sem a conferência de DNS injetada (só testes), a cota é a única trava", async () => {
    const s = make({ pointsHere: undefined });
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    s.close();
  });

  it("respeita o teto de emissões por hora (global) e as tentativas por nome", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: false, reason: "hourly_limit" });
    clock += HOUR + 1;
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: true });
    s.close();
  });

  it("respeita o teto semanal por domínio registrado", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerWeekPerDomain: 1 });
    mtaHosts = ["mta-sts.example.com", "mta-sts.outro.example.com"];
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    // o mesmo domínio registrado (example.com) já usou a cota da semana
    expect(await s.authorize("mta-sts.outro.example.com")).toEqual({ allow: false, reason: "weekly_limit" });
    s.close();
  });

  it("renovação (certificado válido já visto) não gasta cota; vencido volta a gastar", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    const valid = { ok: true, issuer: "LE", validFrom: null, validTo: new Date(clock + 30 * 24 * HOUR).toISOString(), error: null };
    await s.reconcileIssued(new Map([["mta-sts.example.com", valid]]));
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: true }); // gasta a única da hora
    for (let i = 0; i < 5; i++) {
      clock += 2 * 60_000;
      expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: true });
    }
    // visto vencido: deixa de ser renovação
    const expired = { ...valid, validTo: new Date(clock - 1000).toISOString() };
    await s.reconcileIssued(new Map([["mta-sts.example.com", expired]]));
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "hourly_limit" });
    s.close();
  });

  it("reconcileIssued ignora certificado com falha ou sem validade e lista de e-mail que falha", async () => {
    const s = make();
    await s.setLimits({ maxIssuancesPerHour: 1 });
    const failed = { ok: false, issuer: null, validFrom: null, validTo: null, error: "x" };
    await s.reconcileIssued(new Map([["mta-sts.example.com", failed]]));
    expect(await s.authorize("mta-sts.example.org")).toEqual({ allow: true });
    expect(await s.authorize("mta-sts.example.com")).toEqual({ allow: false, reason: "hourly_limit" });
    const quebrado = make({
      mtaStsHosts: async () => {
        throw new Error("x");
      },
    });
    await expect(quebrado.reconcileIssued(new Map())).resolves.toBe(0);
    s.close();
    quebrado.close();
  });

  it("reconcileIssued sem a lista de e-mail injetada não faz nada com mta-sts.", async () => {
    const s = make({ mtaStsHosts: undefined });
    await expect(s.reconcileIssued(new Map())).resolves.toBe(0);
    s.close();
  });
});
