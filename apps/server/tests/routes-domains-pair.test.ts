/**
 * /api/domains/check com o par (com/sem www): cada nome é consultado à parte,
 * o resultado do nome digitado nunca depende do par, e o par traz o estado
 * (apontado / sem registro / outro lugar / Cloudflare laranja / DNS mudo) e
 * quem já usa o nome. Também cobre a consulta usada pelo proxy (makeHostState).
 * O DNS real é substituído por um resolvedor controlado por nome.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";

const { resolve4 } = vi.hoisted(() => ({
  resolve4: vi.fn<(name: string) => Promise<string[]>>(),
}));

vi.mock("node:dns/promises", () => ({
  default: { resolve4 },
}));

import domainsRoutes, { makeHostState, probeHostDns, publicIpFromConfig } from "../src/routes/domains.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PUBLIC_IP = "203.0.113.10";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;
let savedPublicIp: string | undefined;

/** Respostas de DNS por nome; nome fora do mapa = NXDOMAIN. */
function dnsFor(map: Record<string, string[] | Error>) {
  resolve4.mockImplementation(async (name) => {
    const v = map[name];
    if (v instanceof Error) throw v;
    if (v) return v;
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  });
}

beforeEach(async () => {
  savedPublicIp = process.env.PAAS_PUBLIC_IP;
  process.env.PAAS_PUBLIC_IP = PUBLIC_IP;
  resolve4.mockReset();
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
});

afterEach(async () => {
  vi.useRealTimers();
  if (savedPublicIp === undefined) delete process.env.PAAS_PUBLIC_IP;
  else process.env.PAAS_PUBLIC_IP = savedPublicIp;
  await closeAuthTestApp(ctx);
});

async function check(domain: string, project?: string) {
  return app.inject({
    method: "GET",
    url: `/api/domains/check?domain=${encodeURIComponent(domain)}${project ? `&project=${project}` : ""}`,
    headers: auth,
  });
}

describe("GET /api/domains/check — par com/sem www", () => {
  beforeEach(async () => {
    await app.register(domainsRoutes);
  });

  it("apex digitado: confere o apex e o www, cada um com o seu resultado", async () => {
    dnsFor({ "example.com": [PUBLIC_IP], "www.example.com": [PUBLIC_IP] });
    const body = (await check("example.com")).json();
    expect(body).toMatchObject({ domain: "example.com", ok: true, state: "pointed" });
    expect(body.pair).toMatchObject({ domain: "www.example.com", role: "www", ok: true, state: "pointed", resolvedIps: [PUBLIC_IP] });
    expect(body.pair.occupiedBy).toBeUndefined();
    expect(resolve4).toHaveBeenCalledWith("example.com");
    expect(resolve4).toHaveBeenCalledWith("www.example.com");
  });

  it("www digitado: o par é o apex", async () => {
    dnsFor({ "www.example.com": [PUBLIC_IP] });
    const body = (await check("WWW.Example.com")).json();
    expect(body.domain).toBe("www.example.com");
    expect(body.pair).toMatchObject({ domain: "example.com", role: "apex", ok: false, state: "missing" });
  });

  it("TLD composto: example.com.br <-> www.example.com.br", async () => {
    dnsFor({ "example.com.br": [PUBLIC_IP], "www.example.com.br": [PUBLIC_IP] });
    const body = (await check("example.com.br")).json();
    expect(body.pair).toMatchObject({ domain: "www.example.com.br", ok: true });
    const body2 = (await check("www.example.co.uk")).json();
    expect(body2.pair.domain).toBe("example.co.uk");
  });

  it("par que falha é aviso: o nome digitado continua ok", async () => {
    dnsFor({ "example.com": [PUBLIC_IP] });
    const body = (await check("example.com")).json();
    expect(body.ok).toBe(true);
    expect(body.state).toBe("pointed");
    expect(body.pair).toMatchObject({ ok: false, state: "missing" });
    expect(body.pair.message).toMatch(/ainda não aponta.*registro do tipo A.*203\.0\.113\.10/);
  });

  it("cada estado do par: outro lugar, Cloudflare laranja e DNS mudo", async () => {
    dnsFor({ "example.com": [PUBLIC_IP], "www.example.com": ["198.51.100.7"] });
    let pair = (await check("example.com")).json().pair;
    expect(pair).toMatchObject({ state: "elsewhere", ok: false, resolvedIps: ["198.51.100.7"] });
    expect(pair.message).toContain("198.51.100.7");

    dnsFor({ "example.com": [PUBLIC_IP], "www.example.com": ["104.16.1.1", "172.67.0.1"] });
    pair = (await check("example.com")).json().pair;
    expect(pair).toMatchObject({ state: "cloudflare", ok: false });
    expect(pair.message).toMatch(/nuvem cinza/);

    dnsFor({ "example.com": [PUBLIC_IP], "www.example.com": Object.assign(new Error("t"), { code: "ETIMEOUT" }) });
    pair = (await check("example.com")).json().pair;
    expect(pair).toMatchObject({ state: "unavailable", ok: false, resolvedIps: [] });
    expect(pair.message).toMatch(/não respondeu/);
  });

  it("o nome digitado também traz o estado (Cloudflare laranja, outro lugar, sem registro)", async () => {
    dnsFor({ "example.com": ["104.16.1.1"], "www.example.com": [PUBLIC_IP] });
    let body = (await check("example.com")).json();
    expect(body).toMatchObject({ ok: false, state: "cloudflare" });
    expect(body.pair.ok).toBe(true);

    dnsFor({ "example.com": ["198.51.100.7"] });
    body = (await check("example.com")).json();
    expect(body).toMatchObject({ ok: false, state: "elsewhere" });

    dnsFor({});
    body = (await check("example.com")).json();
    expect(body).toMatchObject({ ok: false, state: "missing" });
  });

  it("subdomínio comum, sslip.io e IP não têm par e não consultam um segundo nome", async () => {
    dnsFor({ "app.example.com": [PUBLIC_IP] });
    for (const d of ["app.example.com", "www.app.example.com", "loja.203-0-113-10.sslip.io"]) {
      resolve4.mockClear();
      const body = (await check(d)).json();
      expect(body.pair).toBeUndefined();
      expect(resolve4).toHaveBeenCalledTimes(1);
    }
  });

  it(".localhost: sem DNS e sem par", async () => {
    const body = (await check("www.localhost")).json();
    expect(body.devLocal).toBe(true);
    expect(body.pair).toBeUndefined();
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("quem já usa o nome do par: outro projeto, o painel ou o próprio projeto", async () => {
    dnsFor({ "example.com": [PUBLIC_IP], "www.example.com": [PUBLIC_IP] });
    const occupantOf = vi.fn((_host: string, _project: string | null): "other_project" | "panel" | "same_project" | null => "other_project");
    app.decorate("deployService", { occupantOf } as never);
    let pair = (await check("example.com", "p1")).json().pair;
    expect(pair.occupiedBy).toBe("other_project");
    expect(occupantOf).toHaveBeenCalledWith("www.example.com", "p1");

    occupantOf.mockReturnValue("panel");
    expect((await check("example.com")).json().pair.occupiedBy).toBe("panel");
    expect(occupantOf).toHaveBeenLastCalledWith("www.example.com", null);

    occupantOf.mockReturnValue("same_project");
    expect((await check("example.com", "p1")).json().pair.occupiedBy).toBe("same_project");

    occupantOf.mockReturnValue(null);
    pair = (await check("example.com", "p1")).json().pair;
    expect(pair.occupiedBy).toBeUndefined();
  });

  it("parâmetro project fora do formato é recusado pelo schema", async () => {
    const res = await app.inject({ method: "GET", url: `/api/domains/check?domain=example.com&project=${"x".repeat(65)}`, headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it("ponto final e maiúsculas no domínio: o schema recusa o ponto; maiúsculas viram minúsculas", async () => {
    dnsFor({ "example.com": [PUBLIC_IP] });
    expect((await check("example.com.")).statusCode).toBe(400);
    expect((await check("EXAMPLE.com")).json().domain).toBe("example.com");
  });
});

describe("probeHostDns", () => {
  const mine = [PUBLIC_IP, "127.0.0.1"];

  it("aponta, sem registro, outro lugar, Cloudflare e IPs misturados", async () => {
    dnsFor({ a: [PUBLIC_IP], b: ["198.51.100.1"], c: ["104.16.1.1"], d: ["198.51.100.1", PUBLIC_IP], e: ["104.16.1.1", "198.51.100.1"] });
    expect(await probeHostDns("a", mine)).toEqual({ state: "pointed", resolved: [PUBLIC_IP] });
    expect((await probeHostDns("b", mine)).state).toBe("elsewhere");
    expect((await probeHostDns("c", mine)).state).toBe("cloudflare");
    expect((await probeHostDns("d", mine)).state).toBe("pointed");
    expect((await probeHostDns("e", mine)).state).toBe("elsewhere");
    expect(await probeHostDns("nada", mine)).toEqual({ state: "missing", resolved: [] });
  });

  it("resolvedor mudo é 'unavailable'; erro sem código ou desconhecido é 'sem registro'", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EAI_AGAIN", "ECANCELLED"]) {
      resolve4.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect((await probeHostDns("x", mine)).state).toBe("unavailable");
    }
    resolve4.mockRejectedValueOnce(new Error("sem código"));
    expect((await probeHostDns("x", mine)).state).toBe("missing");
    resolve4.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENODATA" }));
    expect((await probeHostDns("x", mine)).state).toBe("missing");
    resolve4.mockRejectedValueOnce(undefined);
    expect((await probeHostDns("x", mine)).state).toBe("missing");
  });
});

describe("makeHostState (consulta do proxy)", () => {
  it("devolve o estado do nome contra o IP público informado", async () => {
    dnsFor({ "www.example.com": ["192.0.2.55"] });
    expect(await makeHostState(() => "192.0.2.55")("www.example.com")).toBe("pointed");
    expect(await makeHostState(() => "192.0.2.56")("www.example.com")).toBe("elsewhere");
    expect(await makeHostState(() => null)("sem.example.com")).toBe("missing");
  });

  it("resolvedor que trava passa a 'unavailable' em 6 s", async () => {
    vi.useFakeTimers();
    resolve4.mockImplementation(() => new Promise(() => undefined));
    const pending = makeHostState(() => PUBLIC_IP)("www.example.com");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toBe("unavailable");
  });
});

describe("publicIpFromConfig", () => {
  it("PAAS_PUBLIC_IP vence; senão o IP do endereço sslip.io do painel; senão null", () => {
    expect(publicIpFromConfig("1-2-3-4.sslip.io")).toBe(PUBLIC_IP);
    delete process.env.PAAS_PUBLIC_IP;
    expect(publicIpFromConfig("1-2-3-4.sslip.io")).toBe("1.2.3.4");
    expect(publicIpFromConfig("painel.example.com")).toBeNull();
    expect(publicIpFromConfig(null)).toBeNull();
  });
});
