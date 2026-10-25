/**
 * Conferência de DNS do `ask`: o nome precisa apontar (A/AAAA, já seguindo CNAME no resolvedor)
 * para um IP da própria VPS antes de gastar uma emissão. Resolvedor falso, relógio falso.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPointsHere, type DnsCheckDeps } from "../src/services/dynamic-dns-check.js";

const OWN4 = "203.0.113.10";
const OWN6 = "2001:db8::10";

function make(over: Partial<DnsCheckDeps> = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => void (t += ms) };
  const resolve4 = vi.fn(async (_h: string): Promise<string[]> => []);
  const resolve6 = vi.fn(async (_h: string): Promise<string[]> => []);
  const check = buildPointsHere({ ownIps: () => [OWN4, OWN6], resolve4, resolve6, now: () => t, timeoutMs: 50, ...over });
  return { check, resolve4, resolve6, clock };
}

describe("buildPointsHere", () => {
  it("aponta para o IPv4 da VPS: sim; para outro IP: não; sem registro: não", async () => {
    const { check, resolve4 } = make();
    resolve4.mockImplementation(async (h) => (h === "a.cliente.example" ? [OWN4] : h === "longe.cliente.example" ? ["198.51.100.7"] : []));
    expect(await check("a.cliente.example")).toBe(true);
    expect(await check("longe.cliente.example")).toBe(false);
    expect(await check("nada.cliente.example")).toBe(false);
  });

  it("IPv6 (escrito de outro jeito) também vale; qualquer um dos registros basta", async () => {
    const { check, resolve4, resolve6 } = make();
    resolve4.mockResolvedValue(["198.51.100.7"]);
    resolve6.mockResolvedValue(["2001:0DB8:0:0:0:0:0:10"]);
    expect(await check("v6.cliente.example")).toBe(true);
  });

  it("o resolvedor segue o CNAME: o que importa é o IP final devolvido", async () => {
    const { check, resolve4 } = make();
    resolve4.mockResolvedValue([OWN4]); // cliente.example -> CNAME -> a VPS
    expect(await check("www.cliente.example")).toBe(true);
  });

  it("não saber o IP da VPS (nada configurado ou texto inválido): não autoriza e nem consulta o DNS", async () => {
    for (const ips of [[], ["", "   "], ["não é ip"]]) {
      const { check, resolve4, resolve6 } = make({ ownIps: () => ips });
      expect(await check("a.cliente.example")).toBe(false);
      expect(resolve4).not.toHaveBeenCalled();
      expect(resolve6).not.toHaveBeenCalled();
    }
  });

  it("só o IPv6 conhecido: nome que aponta para ele vale", async () => {
    const { check, resolve6 } = make({ ownIps: () => [`[${OWN6}]`] });
    resolve6.mockResolvedValue([OWN6]);
    expect(await check("a.cliente.example")).toBe(true);
  });

  it("erro do resolvedor ou resposta que não vem a tempo: não aponta (tempo limite curto)", async () => {
    const { check, resolve4, resolve6 } = make();
    resolve4.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    resolve6.mockImplementation(() => new Promise<string[]>(() => undefined)); // nunca responde
    const started = Date.now();
    expect(await check("a.cliente.example")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("um registro que responde a tempo vale mesmo que o outro tipo trave", async () => {
    const { check, resolve4, resolve6 } = make();
    resolve4.mockResolvedValue([OWN4]);
    resolve6.mockImplementation(() => new Promise<string[]>(() => undefined));
    expect(await check("a.cliente.example")).toBe(true);
  });

  it("cache positivo (5 min) e negativo (60 s): a segunda pergunta não consulta de novo; depois do prazo, consulta", async () => {
    const { check, resolve4, clock } = make();
    resolve4.mockImplementation(async (h) => (h === "ok.cliente.example" ? [OWN4] : []));
    expect(await check("ok.cliente.example")).toBe(true);
    expect(await check("no.cliente.example")).toBe(false);
    expect(resolve4).toHaveBeenCalledTimes(2);
    expect(await check("ok.cliente.example")).toBe(true);
    expect(await check("no.cliente.example")).toBe(false);
    expect(resolve4).toHaveBeenCalledTimes(2);
    clock.advance(61_000); // o negativo venceu, o positivo ainda vale
    expect(await check("ok.cliente.example")).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(2);
    // o cliente acabou de criar o registro: a nova consulta enxerga
    resolve4.mockImplementation(async () => [OWN4]);
    expect(await check("no.cliente.example")).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(3);
    clock.advance(5 * 60_000 + 1);
    expect(await check("ok.cliente.example")).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(4);
  });

  it("várias perguntas ao mesmo tempo sobre o mesmo nome fazem uma consulta só", async () => {
    const { check, resolve4, resolve6 } = make();
    let release: (v: string[]) => void = () => undefined;
    resolve4.mockImplementation(() => new Promise<string[]>((r) => (release = r)));
    const all = Promise.all([check("a.cliente.example"), check("a.cliente.example"), check("a.cliente.example")]);
    await vi.waitFor(() => expect(resolve4).toHaveBeenCalledTimes(1));
    release([OWN4]);
    expect(await all).toEqual([true, true, true]);
    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(resolve6).toHaveBeenCalledTimes(1);
  });

  it("o cache não cresce sem limite (inclusive com tudo ainda válido)", async () => {
    const { check, resolve4 } = make();
    resolve4.mockResolvedValue([OWN4]);
    for (let i = 0; i < 5_100; i++) await check(`n${i}.cliente.example`);
    // continua funcionando depois de passar do teto
    expect(await check("final.cliente.example")).toBe(true);
  });

  it("nunca escreve o nome em log", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const { check, resolve4 } = make();
    resolve4.mockRejectedValue(new Error("falhou"));
    await check("segredo.cliente.example");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
