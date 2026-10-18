/**
 * trustProxy (A4): o painel só confia no X-Forwarded-For de quem é o Caddy
 * (ou o loopback). Com `trustProxy: true`, qualquer um que alcançasse a porta
 * do painel escolhia o próprio IP — burlando o limite de tentativas de login
 * e falsificando a auditoria.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { TrustedProxies, caddyAddresses } from "../src/services/trusted-proxies.js";

async function appWith(proxies: TrustedProxies) {
  const app = Fastify({ trustProxy: proxies.isTrusted });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  return app;
}

describe("Fastify com TrustedProxies", () => {
  it("par desconhecido forjando X-Forwarded-For: o IP é o do par, não o forjado", async () => {
    const app = await appWith(new TrustedProxies(async () => ["172.30.0.2"]));
    const res = await app.inject({ url: "/ip", remoteAddress: "172.30.0.99", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.json()).toEqual({ ip: "172.30.0.99" });
  });

  it("o Caddy (IP descoberto) informa o cliente por X-Forwarded-For", async () => {
    const proxies = new TrustedProxies(async () => ["172.30.0.2"]);
    await proxies.refresh();
    const app = await appWith(proxies);
    const res = await app.inject({ url: "/ip", remoteAddress: "172.30.0.2", headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(res.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("o loopback continua confiável (acesso por túnel/dev)", async () => {
    const app = await appWith(new TrustedProxies(async () => []));
    const res = await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(res.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("o Caddy tem IP novo (container recriado): a próxima consulta o aprende", async () => {
    let atual = ["172.30.0.2"];
    const proxies = new TrustedProxies(async () => atual, { minRefreshGapMs: 0 });
    await proxies.refresh();
    atual = ["172.30.0.9"];
    expect(proxies.isTrusted("172.30.0.9", 0)).toBe(false);
    await proxies.refresh();
    expect(proxies.isTrusted("172.30.0.9", 0)).toBe(true);
    expect(proxies.isTrusted("172.30.0.2", 0)).toBe(false);
  });

  it("par privado desconhecido dispara uma releitura (sem prender a requisição)", async () => {
    let leituras = 0;
    const proxies = new TrustedProxies(async () => (leituras++, ["172.30.0.2"]), { minRefreshGapMs: 0 });
    expect(proxies.isTrusted("172.30.0.2", 0)).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(leituras).toBe(1);
    expect(proxies.isTrusted("172.30.0.2", 0)).toBe(true);
    // público nunca dispara
    proxies.isTrusted("203.0.113.5", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(leituras).toBe(1);
  });

  it("falha na consulta ao Docker mantém o que já se sabia", async () => {
    let falha = false;
    const proxies = new TrustedProxies(async () => {
      if (falha) throw new Error("docker fora");
      return ["172.30.0.2"];
    });
    await proxies.refresh();
    falha = true;
    await proxies.refresh();
    expect(proxies.isTrusted("172.30.0.2", 0)).toBe(true);
  });
});

describe("caddyAddresses", () => {
  it("lê os IPs do Caddy em todas as redes em que ele está", () => {
    const json = JSON.stringify({ "paas-net": { IPAddress: "172.20.0.2" }, "paas-panel": { IPAddress: "172.21.0.2" }, vazia: { IPAddress: "" } });
    expect(caddyAddresses(json)).toEqual(["172.20.0.2", "172.21.0.2"]);
  });
  it("saída ilegível → vazio", () => {
    expect(caddyAddresses("não é json")).toEqual([]);
    expect(caddyAddresses("null")).toEqual([]);
  });
});
