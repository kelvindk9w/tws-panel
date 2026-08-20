/**
 * Testes do monitoramento de blacklist DNSBL (blacklist.ts) com resolver
 * mockado: listed (127.0.0.x), clean (NXDOMAIN), unknown (127.255.255.x =
 * zona recusou a consulta) e validação de IP.
 */
import { describe, expect, it } from "vitest";
import {
  checkDomainBlacklists,
  checkIpBlacklists,
  defaultBlacklistResolver,
  DOMAIN_DNSBLS,
  IP_DNSBLS,
  reversedIpv4,
  type BlacklistResolverLike,
} from "../src/blacklist.js";

function resolverReturning(answers: string[]): BlacklistResolverLike {
  return { resolve4: async () => answers };
}

function resolverFailing(code: string): BlacklistResolverLike {
  return {
    resolve4: () => Promise.reject(Object.assign(new Error(code), { code })),
  };
}

describe("defaultBlacklistResolver", () => {
  it("usa o resolver do sistema (sem fixar servidores públicos)", () => {
    // DNSBLs sérias recusam resolvedores abertos — o padrão é o do sistema
    const resolver = defaultBlacklistResolver();
    expect(typeof resolver.resolve4).toBe("function");
  });
});

describe("reversedIpv4", () => {
  it("inverte os octetos para a consulta DNSBL", () => {
    expect(reversedIpv4("203.0.113.10")).toBe("10.113.0.203");
    expect(reversedIpv4("1.2.3.4")).toBe("4.3.2.1");
  });
});

describe("checkIpBlacklists", () => {
  it("consulta o IP invertido em todas as zonas de IP", async () => {
    const queries: string[] = [];
    const resolver: BlacklistResolverLike = {
      resolve4: async (name) => {
        queries.push(name);
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    };
    await checkIpBlacklists("203.0.113.10", resolver);
    expect(queries).toHaveLength(IP_DNSBLS.length);
    expect(queries[0]).toBe("10.113.0.203.zen.spamhaus.org");
  });

  it("resposta 127.0.0.x → listed com URL de remoção", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverReturning(["127.0.0.2"]));
    for (const result of results) {
      expect(result.status).toBe("listed");
      expect(result.removalUrl).toBeTruthy();
      expect(result.detail).toContain("127.0.0.2");
    }
  });

  it("NXDOMAIN/ENODATA → clean sem URL de remoção", async () => {
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      const results = await checkIpBlacklists("203.0.113.10", resolverFailing(code));
      expect(results.every((r) => r.status === "clean")).toBe(true);
      expect(results.every((r) => r.removalUrl === null)).toBe(true);
    }
  });

  it("127.255.255.x → unknown (zona recusou a consulta), NUNCA listed", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverReturning(["127.255.255.254"]));
    for (const result of results) {
      expect(result.status).toBe("unknown");
      expect(result.detail).toContain("recusou");
      expect(result.removalUrl).toBeNull();
    }
  });

  it("edge: resposta mista com 127.0.0.x e 127.255.255.x → listed vence", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverReturning(["127.255.255.254", "127.0.0.4"]));
    expect(results.every((r) => r.status === "listed")).toBe(true);
  });

  it("edge: resposta A que não é 127.x → clean", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverReturning(["203.0.113.10"]));
    expect(results.every((r) => r.status === "clean")).toBe(true);
  });

  it("erro de rede inesperado → unknown com detalhe", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverFailing("ETIMEDOUT"));
    expect(results.every((r) => r.status === "unknown")).toBe(true);
    expect(results.every((r) => r.detail?.includes("ETIMEDOUT"))).toBe(true);
  });

  it("erro sem código (falha genérica) → unknown com 'erro desconhecido'", async () => {
    const resolver: BlacklistResolverLike = {
      resolve4: () => Promise.reject(new Error("boom")),
    };
    const results = await checkIpBlacklists("203.0.113.10", resolver);
    expect(results.every((r) => r.status === "unknown")).toBe(true);
    expect(results.every((r) => r.detail?.includes("erro desconhecido"))).toBe(true);
  });

  it("IP inválido → lista vazia sem consultar o resolver", async () => {
    let called = false;
    const resolver: BlacklistResolverLike = {
      resolve4: async () => {
        called = true;
        return [];
      },
    };
    for (const invalid of ["999.1.2.3", "nao-e-um-ip", "2001:db8::1", "1.2.3", ""]) {
      expect(await checkIpBlacklists(invalid, resolver), invalid).toEqual([]);
    }
    expect(called).toBe(false);
  });

  it("resultado carrega identidade da DNSBL (id, label, removalUrl)", async () => {
    const results = await checkIpBlacklists("203.0.113.10", resolverFailing("ENOTFOUND"));
    const zen = results.find((r) => r.dnsbl === "spamhaus-zen");
    expect(zen).toMatchObject({ label: "Spamhaus ZEN" });
    expect(results.map((r) => r.dnsbl)).toEqual(IP_DNSBLS.map((d) => d.id));
  });
});

describe("checkDomainBlacklists", () => {
  it("consulta o domínio nas zonas de domínio", async () => {
    const queries: string[] = [];
    const resolver: BlacklistResolverLike = {
      resolve4: async (name) => {
        queries.push(name);
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    };
    const results = await checkDomainBlacklists("exemplo.com.br", resolver);
    expect(queries).toEqual(DOMAIN_DNSBLS.map((d) => `exemplo.com.br.${d.zone}`));
    expect(results.every((r) => r.status === "clean")).toBe(true);
  });

  it("domínio listado → listed", async () => {
    const results = await checkDomainBlacklists("spam.invalid", resolverReturning(["127.0.1.2"]));
    expect(results.every((r) => r.status === "listed")).toBe(true);
  });
});
