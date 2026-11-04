/**
 * Resolvedores padrão da verificação de DNS, sem sair para a rede: o módulo
 * node:dns/promises é trocado por um dublê. Confere que o resolver público
 * nasce com prazo e tentativas explícitos e que, sem resolvedor injetado, o
 * DNS do sistema entra como segunda opção quando o público não responde
 * (validação real, 02/10/2026).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<{ options: unknown; servers: string[] }> = [];
const timeout = () => Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }));
const notFound = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

vi.mock("node:dns/promises", () => {
  class FakeResolver {
    constructor(options?: unknown) {
      created.push({ options, servers: [] });
    }
    setServers(servers: string[]) {
      created.at(-1)!.servers = servers;
    }
    resolve4 = timeout;
    resolve6 = timeout;
    resolveMx = timeout;
    resolveTxt = timeout;
    reverse = timeout;
  }
  const system = {
    Resolver: FakeResolver,
    resolve4: async (name: string) => (name === "vmi1234567.contaboserver.net" ? ["203.0.113.10"] : notFound()),
    resolve6: notFound,
    resolveMx: notFound,
    resolveTxt: notFound,
    reverse: async () => ["vmi1234567.contaboserver.net"],
  };
  return { default: system, ...system };
});

const { buildDnsChecklist, PUBLIC_DNS_OPTIONS, verifyDnsRecords } = await import("../src/dns-checklist.js");

const CHECKLIST = buildDnsChecklist({
  domain: "exemplo.com.br",
  mailHostname: "mail.exemplo.com.br",
  serverIp: "203.0.113.10",
  serverIpv6: null,
  dkimSelector: "paas",
  dkimPublicKey: "MIIB",
  dmarcStage: "none",
});

beforeEach(() => {
  created.length = 0;
});

describe("resolvedores padrão", () => {
  it("o resolver público nasce com prazo, tentativas e os servidores 1.1.1.1/8.8.8.8", async () => {
    await verifyDnsRecords(CHECKLIST, undefined, { fallback: null });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ options: PUBLIC_DNS_OPTIONS, servers: ["1.1.1.1", "8.8.8.8"] });
  });

  it("sem resolvedor injetado, o DNS do sistema responde quando o público não responde", async () => {
    const logs: string[] = [];
    const result = await verifyDnsRecords(CHECKLIST, undefined, { log: (m) => logs.push(m) });
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.found).toEqual(["vmi1234567.contaboserver.net"]);
    expect(logs.some((m) => m.includes("respondida pelo DNS do sistema"))).toBe(true);
  });
});
