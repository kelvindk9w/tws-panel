/**
 * Ouvido do aviso de envio: só o Stalwart (segredo certo) entra; corpo grande,
 * excesso de pedidos, tentativas erradas, rota errada e JSON ruim são
 * recusados sem registrar nada; a resposta é imediata.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildMailHookServer, MAIL_HOOK_PATH, stalwartAddressResolver } from "../src/services/mail-send-hook-server.js";

const SECRET = "ab".repeat(32);
let app: FastifyInstance | null = null;
let now = 1_000_000;

function build(over: Partial<Parameters<typeof buildMailHookServer>[0]> = {}) {
  const submit = vi.fn((_p: unknown): "queued" | "invalid" | "dropped" => "queued");
  const verify = vi.fn(async (s: string) => s === SECRET);
  app = buildMailHookServer({ verify, submit, now: () => now, ...over });
  return { submit, verify };
}
const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }, payload: unknown = { a: 1 }, url = MAIL_HOOK_PATH) =>
  app!.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(payload) });

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("ouvido do aviso de envio", () => {
  it("segredo certo: aceita, entrega o aviso e responde 'accept'", async () => {
    const { submit } = build();
    const res = await post(undefined, { x: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ action: "accept" });
    expect(submit).toHaveBeenCalledWith({ x: 1 });
  });

  it.each([
    ["sem cabeçalho", {}],
    ["segredo errado", { authorization: "Bearer errado" }],
    ["esquema errado", { authorization: `Basic ${SECRET}` }],
    ["vazio", { authorization: "Bearer " }],
    ["enorme", { authorization: `Bearer ${"a".repeat(300)}` }],
  ])("recusa (%s) com 401 e não toca no registro", async (_n, headers) => {
    const { submit } = build();
    expect((await post(headers)).statusCode).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it("o segredo é conferido ANTES de ler o corpo: corpo grande sem segredo é 401, não 413", async () => {
    build({ bodyLimit: 100 });
    const res = await post({}, { x: "y".repeat(500) });
    expect(res.statusCode).toBe(401);
  });

  it("corpo acima do limite com o segredo certo: 413 e nada registrado", async () => {
    const { submit } = build({ bodyLimit: 100 });
    const res = await post(undefined, { x: "y".repeat(500) });
    expect(res.statusCode).toBe(413);
    expect(submit).not.toHaveBeenCalled();
  });

  it("só POST no caminho do aviso; o resto é 404", async () => {
    build();
    expect((await app!.inject({ method: "GET", url: MAIL_HOOK_PATH, headers: { authorization: `Bearer ${SECRET}` } })).statusCode).toBe(404);
    expect((await post(undefined, {}, "/api/projects")).statusCode).toBe(404);
    expect((await post(undefined, {}, "/")).statusCode).toBe(404);
  });

  it("JSON inválido ou outro tipo de conteúdo: erro 4xx", async () => {
    build();
    const bad = await app!.inject({ method: "POST", url: MAIL_HOOK_PATH, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: "{nao" });
    expect(bad.statusCode).toBe(400);
    const other = await app!.inject({ method: "POST", url: MAIL_HOOK_PATH, headers: { authorization: `Bearer ${SECRET}`, "content-type": "text/plain" }, payload: "x" });
    expect(other.statusCode).toBe(415);
  });

  it("aviso inválido = 400; fila cheia = 429", async () => {
    const { submit } = build();
    submit.mockReturnValueOnce("invalid").mockReturnValueOnce("dropped");
    expect((await post()).statusCode).toBe(400);
    expect((await post()).statusCode).toBe(429);
  });

  it("limite de pedidos por minuto e janela que reabre", async () => {
    build({ maxPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(429);
    now += 61_000;
    expect((await post()).statusCode).toBe(200);
  });

  it("muitas tentativas com segredo errado bloqueiam SÓ aquela origem; o Stalwart (outra origem) segue", async () => {
    const { submit } = build({ maxBadAuthPerMinute: 3 });
    const from = (remoteAddress: string, headers: Record<string, string>) =>
      app!.inject({ method: "POST", url: MAIL_HOOK_PATH, remoteAddress, headers: { "content-type": "application/json", ...headers }, payload: "{}" });
    for (let i = 0; i < 3; i++) expect((await from("10.0.0.9", { authorization: "Bearer x" })).statusCode).toBe(401);
    // o vizinho barulhento é barrado, até com o segredo certo (não confere mais nada para ele)...
    expect((await from("10.0.0.9", { authorization: `Bearer ${SECRET}` })).statusCode).toBe(429);
    // ...mas o envio de verdade, de outra origem, passa
    expect((await from("10.0.0.5", { authorization: `Bearer ${SECRET}` })).statusCode).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    now += 61_000;
    expect((await from("10.0.0.9", { authorization: `Bearer ${SECRET}` })).statusCode).toBe(200);
  });

  it("tentativas erradas de terceiros não gastam a cota de pedidos do Stalwart", async () => {
    build({ maxPerMinute: 2, maxBadAuthPerMinute: 1000 });
    for (let i = 0; i < 10; i++) expect((await post({ authorization: "Bearer x" })).statusCode).toBe(401);
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
  });

  it("origem IPv4 mapeada em IPv6 é reconhecida", async () => {
    build({ allowFrom: async () => ["172.18.0.2"] });
    const res = await app!.inject({ method: "POST", url: MAIL_HOOK_PATH, remoteAddress: "::ffff:172.18.0.2", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(200);
  });

  it("só o container do Stalwart pode chamar: outra origem leva 403 antes de qualquer conferência", async () => {
    const { submit, verify } = build({ allowFrom: async () => ["127.0.0.1"] });
    expect((await post()).statusCode).toBe(200);
    const other = await app!.inject({ method: "POST", url: MAIL_HOOK_PATH, remoteAddress: "10.9.9.9", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: "{}" });
    expect(other.statusCode).toBe(403);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("não resolveu o endereço do Stalwart: recusa tudo (403)", async () => {
    build({
      allowFrom: async () => {
        throw new Error("sem DNS");
      },
    });
    expect((await post()).statusCode).toBe(403);
  });

  it("pedidos simultâneos são limitados (memória): a vaga é devolvida ao fim de cada pedido", async () => {
    build({ maxConcurrent: 1 });
    for (let i = 0; i < 4; i++) expect((await post()).statusCode).toBe(200);
    await app!.close();
    build({ maxConcurrent: 0 });
    expect((await post()).statusCode).toBe(429);
  });

  it("não há cookie nem CSRF: pedido com Origin de outro site também passa (é o Stalwart, não um navegador)", async () => {
    build();
    expect((await post({ authorization: `Bearer ${SECRET}`, origin: "https://evil.example.com" })).statusCode).toBe(200);
  });
});

describe("endereços do Stalwart (cache com nova consulta ao IP desconhecido)", () => {
  it("guarda por 30 s; IP desconhecido refaz a consulta, no máximo a cada 5 s", async () => {
    let t = 0;
    let ips = ["10.0.0.2"];
    const lookup = vi.fn(async () => ips);
    const resolve = stalwartAddressResolver({ lookup, now: () => t });
    expect(await resolve("10.0.0.2")).toEqual(["10.0.0.2"]);
    expect(await resolve("10.0.0.2")).toEqual(["10.0.0.2"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    // o container foi recriado com outro IP: o primeiro pedido novo já acha o endereço certo
    ips = ["10.0.0.7"];
    t = 6_000;
    expect(await resolve("10.0.0.7")).toEqual(["10.0.0.7"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    // um desconhecido não força consulta a cada pedido
    t = 7_000;
    expect(await resolve("10.9.9.9")).toEqual(["10.0.0.7"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    t = 12_000;
    await resolve("10.9.9.9");
    expect(lookup).toHaveBeenCalledTimes(3);
    // IP conhecido só renova depois de 30 s
    t = 20_000;
    await resolve("10.0.0.7");
    expect(lookup).toHaveBeenCalledTimes(3);
    t = 43_000;
    await resolve("10.0.0.7");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("consulta que falha vira lista vazia e tenta de novo em 5 s; pedidos juntos dividem a mesma consulta", async () => {
    let t = 0;
    let fail = true;
    const lookup = vi.fn(async () => {
      if (fail) throw new Error("sem DNS");
      return ["10.0.0.2"];
    });
    const resolve = stalwartAddressResolver({ lookup, now: () => t });
    expect(await Promise.all([resolve("10.0.0.2"), resolve("10.0.0.2")])).toEqual([[], []]);
    expect(lookup).toHaveBeenCalledTimes(1);
    fail = false;
    t = 5_000;
    expect(await resolve("10.0.0.2")).toEqual(["10.0.0.2"]);
  });
});
