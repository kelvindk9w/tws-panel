/**
 * Isenção do IP do webmail no bloqueio automático do Stalwart.
 *
 * Conferido no Stalwart v0.11.8 real (03/10/2026): com `server.auto-ban.auth.rate`
 * (padrão 100 senhas erradas por dia por IP), o IP que erra demais é
 * bloqueado PARA SEMPRE (fica em server.blocked-ip.<ip> no banco). Todo login
 * do webmail chega do IP do container dele: sem a isenção, 100 senhas erradas
 * de quaisquer visitantes num dia derrubariam o webmail de todo mundo. Pela
 * API (POST /api/settings + GET /api/reload) a isenção vale sem reiniciar, e
 * apagar server.blocked-ip.<ip> desfaz um bloqueio já feito.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StalwartClient } from "../src/client.js";

const requests: { method: string; url: string; body: unknown }[] = [];

function mockFetch(status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ data: null }), { status });
    }),
  );
}

afterEach(() => {
  requests.length = 0;
  vi.unstubAllGlobals();
});

describe("StalwartClient — IP isento do bloqueio automático", () => {
  const client = new StalwartClient("http://paas-stalwart:8080", "admin", "s");

  it("isenta o IP novo, desfaz bloqueio dele, tira o antigo e recarrega", async () => {
    mockFetch();
    await client.exemptIp("172.18.0.9", "172.18.0.4");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://paas-stalwart:8080/api/settings",
        body: [
          { type: "delete", keys: ["server.allowed-ip.172.18.0.4", "server.blocked-ip.172.18.0.9"] },
          { type: "insert", prefix: null, values: [["server.allowed-ip.172.18.0.9", ""]], assert_empty: false },
        ],
      },
      { method: "GET", url: "http://paas-stalwart:8080/api/reload", body: undefined },
    ]);
  });

  it("sem IP anterior (ou igual): só desfaz bloqueio e isenta", async () => {
    mockFetch();
    await client.exemptIp("172.18.0.9", "172.18.0.9");
    expect((requests[0]!.body as { keys?: string[] }[])[0]!.keys).toEqual(["server.blocked-ip.172.18.0.9"]);
  });

  it("remove a isenção ao desativar o webmail", async () => {
    mockFetch();
    await client.removeIpExemption("172.18.0.9");
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", "http://paas-stalwart:8080/api/settings", [{ type: "delete", keys: ["server.allowed-ip.172.18.0.9"] }]],
      ["GET", "http://paas-stalwart:8080/api/reload", undefined],
    ]);
  });

  it("recusa o que não é IP (vira chave de configuração)", async () => {
    mockFetch();
    await expect(client.exemptIp("1.2.3.4.evil", null)).rejects.toThrow(/IP inválido/);
    await expect(client.removeIpExemption("x")).rejects.toThrow(/IP inválido/);
    expect(requests).toHaveLength(0);
  });

  it("erro da API sobe", async () => {
    mockFetch(500);
    await expect(client.exemptIp("172.18.0.9", null)).rejects.toThrow(/Stalwart/);
  });
});
