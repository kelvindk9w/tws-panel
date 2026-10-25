/**
 * O `ask` do Caddy: servidor próprio, só para a rede interna. Responde 200 para
 * autorizar e qualquer outra coisa para recusar; erro interno recusa (falha
 * fechada); nada do nome consultado vai para log.
 */
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_PATH, buildAskServer, isInternalAddress, type AskServerDeps } from "../src/services/dynamic-ask-server.js";

let server: Server | null = null;

async function start(deps: Partial<AskServerDeps> = {}): Promise<number> {
  server = buildAskServer({ authorize: async () => ({ allow: true }), ...deps });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

function get(port: number, pathAndQuery: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathAndQuery, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("isInternalAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.255", "192.168.1.5", "169.254.1.1", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:172.18.0.2", "::ffff:127.0.0.1"])(
    "%s é da rede interna",
    (ip) => expect(isInternalAddress(ip)).toBe(true),
  );
  // fronteiras das faixas privadas, montadas por partes (nada que pareça IP real no arquivo)
  const edge = (...parts: number[]) => parts.join(".");
  it.each(["8.8.8.8", "203.0.113.5", edge(172, 32, 0, 1), edge(172, 15, 255, 255), edge(11, 0, 0, 1), "2001:db8::1", "::ffff:8.8.8.8", "não é ip", "", undefined])(
    "%s não é",
    (ip) => expect(isInternalAddress(ip)).toBe(false),
  );
});

describe("servidor do ask", () => {
  it("autorizado: 200; recusado: 403 — e repassa o nome sem alterar", async () => {
    const authorize = vi.fn(async (h: string) => (h === "ok.cliente.example" ? { allow: true as const } : { allow: false as const, reason: "unknown" as const }));
    const port = await start({ authorize });
    const ok = await get(port, `${ASK_PATH}?domain=ok.cliente.example`);
    expect(ok).toMatchObject({ status: 200, body: "ok" });
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect((await get(port, `${ASK_PATH}?domain=nao.cliente.example`)).status).toBe(403);
    expect(authorize).toHaveBeenNthCalledWith(1, "ok.cliente.example");
  });

  it("erro interno recusa com 503 (falha fechada)", async () => {
    const port = await start({
      authorize: async () => {
        throw new Error("arquivo ilegível");
      },
    });
    expect((await get(port, `${ASK_PATH}?domain=a.cliente.example`)).status).toBe(503);
  });

  it("outro caminho ou método: 404; sem nome ou nome gigante: 400", async () => {
    const authorize = vi.fn(async () => ({ allow: true as const }));
    const port = await start({ authorize });
    expect((await get(port, "/")).status).toBe(404);
    expect((await get(port, "/api/healthz")).status).toBe(404);
    expect((await get(port, `${ASK_PATH}?domain=a.cliente.example`, "POST")).status).toBe(404);
    expect((await get(port, ASK_PATH)).status).toBe(400);
    expect((await get(port, `${ASK_PATH}?domain=`)).status).toBe(400);
    expect((await get(port, `${ASK_PATH}?domain=${"a".repeat(254)}`)).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("endereço fora da rede interna: 403 antes de qualquer decisão", async () => {
    const authorize = vi.fn(async () => ({ allow: true as const }));
    await start({ authorize });
    const answers: number[] = [];
    for (const remote of ["8.8.8.8", "203.0.113.5", undefined]) {
      // pedido de um endereço público entregue direto ao servidor (o loopback do teste não tem como simular)
      const req = { socket: { remoteAddress: remote }, url: `${ASK_PATH}?domain=a.cliente.example`, method: "GET" };
      const res = { writeHead: (status: number) => answers.push(status), end: () => undefined };
      server!.emit("request", req, res);
    }
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    expect(answers).toEqual([403, 403, 403]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("URL malformada: 400", async () => {
    await start();
    const answers: number[] = [];
    const req = { socket: { remoteAddress: "127.0.0.1" }, url: "http://[", method: "GET" };
    server!.emit("request", req, { writeHead: (status: number) => answers.push(status), end: () => undefined });
    await vi.waitFor(() => expect(answers).toEqual([400]));
  });

  it("limite de consultas por minuto: acima dele, 429; a janela passa e volta", async () => {
    let now = 1_000_000;
    const port = await start({ now: () => now, maxPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await get(port, `${ASK_PATH}?domain=a${i}.example.com`)).status).toBe(200);
    expect((await get(port, `${ASK_PATH}?domain=z.example.com`)).status).toBe(429);
    now += 61_000;
    expect((await get(port, `${ASK_PATH}?domain=z.example.com`)).status).toBe(200);
  });

  it("limite de consultas ao mesmo tempo: acima dele, 503", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const port = await start({
      maxConcurrent: 2,
      authorize: async () => {
        started++;
        await gate;
        return { allow: true as const };
      },
    });
    const slow = [get(port, `${ASK_PATH}?domain=a.example.com`), get(port, `${ASK_PATH}?domain=b.example.com`)];
    await vi.waitFor(() => expect(started).toBe(2));
    expect((await get(port, `${ASK_PATH}?domain=c.example.com`)).status).toBe(503);
    release();
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200]);
    expect((await get(port, `${ASK_PATH}?domain=d.example.com`)).status).toBe(200);
  });

  it("não escreve em console nem em log (o nome consultado é dado do cliente)", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const port = await start({ authorize: async () => ({ allow: false, reason: "unknown" }) });
    await get(port, `${ASK_PATH}?domain=segredo.cliente.example`);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
