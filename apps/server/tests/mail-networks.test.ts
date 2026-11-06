/**
 * Redes do e-mail (mail-networks.ts): leitura das sub-redes/gateways, cache e leitor do socket do Docker; e o efeito
 * na coleta das recusas (gateway = "unknown", fora da sub-rede = "external").
 */
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailNetworksProvider, dockerNetworkFetcher, dockerProjectMailNetworksLister, parseNetworkDoc } from "../src/services/mail-networks.js";
import { MailEnviosService, type MailEnviosDeps } from "../src/services/mail-envios-service.js";
import { removeDir } from "./helpers/tmp.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-networks-"));
});
afterEach(async () => {
  await removeDir(dir);
});

const DOC = { IPAM: { Config: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }, { Subnet: "fd00:dead:beef::/64" }, { Gateway: "x" }, { Subnet: "sem-barra" }, null] } };

describe("parseNetworkDoc", () => {
  it("lê sub-rede e gateway; ignora entradas inválidas e documentos estranhos", () => {
    expect(parseNetworkDoc(DOC)).toEqual([
      { subnet: "172.20.0.0/16", gateway: "172.20.0.1" },
      { subnet: "fd00:dead:beef::/64", gateway: null },
    ]);
    expect(parseNetworkDoc(null)).toEqual([]);
    expect(parseNetworkDoc({ IPAM: { Config: "x" } })).toEqual([]);
    expect(parseNetworkDoc({ IPAM: { Config: [{ Subnet: "10.0.0.0/8", Gateway: "" }] } })).toEqual([{ subnet: "10.0.0.0/8", gateway: null }]);
  });
});

describe("MailNetworksProvider", () => {
  it("junta as redes lidas, guarda em cache e consulta uma vez só em chamadas paralelas", async () => {
    let clock = 0;
    const fetchNetwork = vi.fn(async (name: string) => (name === "paas-mail" ? DOC : name === "paas-net" ? { IPAM: { Config: [{ Subnet: "10.9.0.0/24", Gateway: "10.9.0.1" }] } } : null));
    const p = new MailNetworksProvider({ fetchNetwork, now: () => clock });
    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(fetchNetwork).toHaveBeenCalledTimes(3);
    clock += 5 * 60_000;
    await p.get();
    expect(fetchNetwork).toHaveBeenCalledTimes(3);
    clock += 6 * 60_000;
    await p.get();
    expect(fetchNetwork).toHaveBeenCalledTimes(6);
  });

  it("falha (nenhuma rede lida) = null, tentando de novo só depois de 1 minuto", async () => {
    let clock = 0;
    const fetchNetwork = vi.fn(async (): Promise<unknown | null> => {
      throw new Error("sem docker");
    });
    const p = new MailNetworksProvider({ fetchNetwork, now: () => clock });
    expect(await p.get()).toBeNull();
    expect(await p.get()).toBeNull();
    expect(fetchNetwork).toHaveBeenCalledTimes(3);
    clock += 61_000;
    expect(await p.get()).toBeNull();
    expect(fetchNetwork).toHaveBeenCalledTimes(6);
  });

  it("usa o relógio padrão e os nomes padrão (paas-mail, paas-mailweb e paas-net)", async () => {
    const seen: string[] = [];
    const p = new MailNetworksProvider({
      fetchNetwork: async (n) => {
        seen.push(n);
        return null;
      },
    });
    await p.get();
    expect(seen.sort()).toEqual(["paas-mail", "paas-mailweb", "paas-net"]);
  });

  it("rede por projeto: junta as redes de e-mail de cada projeto; falha na lista não derruba as outras", async () => {
    const projeto = { Name: "paas-mail-projeto-a", IPAM: { Config: [{ Subnet: "10.213.4.32/27", Gateway: "10.213.4.33" }] } };
    const p = new MailNetworksProvider({ fetchNetwork: async () => null, listProjectNetworks: async () => [projeto] });
    expect(await p.get()).toEqual([{ subnet: "10.213.4.32/27", gateway: "10.213.4.33" }]);
    const q = new MailNetworksProvider({
      fetchNetwork: async (n) => (n === "paas-mail" ? DOC : null),
      listProjectNetworks: async () => {
        throw new Error("sem docker");
      },
    });
    expect(await q.get()).toHaveLength(2);
  });
});

describe("dockerNetworkFetcher", () => {
  async function serve(handler: http.RequestListener): Promise<{ socket: string; close: () => Promise<void> }> {
    const socket = path.join(dir, "docker.sock");
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return { socket, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("lê /networks/<nome>; 404, JSON ruim e nome inválido = null", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/networks/paas-mail") res.end(JSON.stringify(DOC));
      else if (req.url === "/networks/ruim") res.end("{nao-json");
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    try {
      const fetcher = dockerNetworkFetcher(s.socket);
      expect(await fetcher("paas-mail")).toEqual(DOC);
      expect(await fetcher("ruim")).toBeNull();
      expect(await fetcher("nao-existe")).toBeNull();
      expect(await fetcher("../containers/json")).toBeNull();
    } finally {
      await s.close();
    }
  });

  it("socket inexistente = null", async () => {
    expect(await dockerNetworkFetcher(path.join(dir, "nada.sock"))("paas-mail")).toBeNull();
  });

  it("dockerProjectMailNetworksLister: filtra pela label do painel e só aceita o nome no formato; erro = lista vazia", async () => {
    let body = "";
    let status = 200;
    let url = "";
    const s = await serve((req, res) => {
      url = req.url ?? "";
      res.statusCode = status;
      res.end(body);
    });
    try {
      const lister = dockerProjectMailNetworksLister(s.socket);
      body = JSON.stringify([{ Name: "paas-mail-projeto-a" }, { Name: "paas-mail-admin" }, { Name: "paas-mail-x_default" }, { Name: 3 }, null]);
      expect(await lister()).toEqual([{ Name: "paas-mail-projeto-a" }]);
      expect(decodeURIComponent(url)).toBe('/networks?filters={"label":["paas.mail.project"]}');
      body = "{}";
      expect(await lister()).toEqual([]);
      body = "{ruim";
      expect(await lister()).toEqual([]);
      status = 500;
      body = "[]";
      expect(await lister()).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe("coleta das recusas com as redes", () => {
  const line = (ip: string, at: string) => `${at} INFO Evento (auth.failed) listenerId = "submission", remoteIp = ${ip}, id = "loja@example.com"`;

  function deps(lines: string[], over: Partial<MailEnviosDeps> = {}): MailEnviosDeps {
    return {
      dataDir: dir,
      serverCreated: async () => true,
      listQueue: async () => ({ items: [], total: 0 }),
      retry: async () => true,
      cancel: async () => true,
      senders: async () => [{ address: "loja@example.com", mailbox: "loja@example.com", projectId: "p1", system: false }],
      projectNames: async () => new Map([["p1", "Loja"]]),
      readLogs: async (_since, onLine) => {
        for (const l of lines) onLine(l);
      },
      now: () => Date.parse("2026-10-30T15:00:00Z"),
      ...over,
    };
  }

  it("container na sub-rede = do app; gateway = unknown (não conta); privado fora das redes = externo", async () => {
    const lines = [line("172.20.0.7", "2026-10-30T14:00:00Z"), line("172.20.0.1", "2026-10-30T14:01:00Z"), line("192.168.5.5", "2026-10-30T14:02:00Z")];
    const svc = new MailEnviosService(deps(lines, { internalNetworks: async () => [{ subnet: "172.20.0.0/16", gateway: "172.20.0.1" }] }));
    await svc.collect();
    expect((await svc.refusals({ projectId: "p1" })).items.map((i) => i.at)).toEqual(["2026-10-30T14:00:00.000Z"]);
    expect((await svc.refusals({ scope: "external" })).items.map((i) => i.origin)).toEqual(["external", "unknown"]);
  });

  it("sem redes (consulta falhou ou lançou): plano B por faixa privada, a coleta não falha", async () => {
    const lines = [line("172.20.0.7", "2026-10-30T14:00:00Z")];
    for (const internalNetworks of [async () => null, async (): Promise<null> => Promise.reject(new Error("x"))]) {
      const svc = new MailEnviosService(deps(lines, { internalNetworks, dataDir: await mkdtemp(path.join(dir, "d-")) }));
      await svc.collect();
      expect((await svc.refusals({ projectId: "p1" })).total).toBe(1);
    }
  });
});
