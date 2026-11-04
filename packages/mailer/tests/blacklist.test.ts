/**
 * Testes da checagem de listas de bloqueio (blacklist.ts) com resolver
 * simulado. Regra principal: o painel NUNCA diz "limpo" sem ter certeza de
 * que a lista respondeu de verdade — cada zona é testada antes com o ponto
 * de teste oficial (127.0.0.2 para IP, dbltest.com para domínio), e quem não
 * responde ao teste fica "não deu para verificar".
 */
import { describe, expect, it } from "vitest";
import {
  checkDomainBlacklists,
  checkIpBlacklists,
  defaultBlacklistResolver,
  DOMAIN_DNSBLS,
  IP_DNSBLS,
  isValidDqsKey,
  reversedIpv4,
  type BlacklistResolverLike,
} from "../src/blacklist.js";

const IP = "203.0.113.10";

function nx(): never {
  throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
}

/**
 * Resolver de mentira: os pontos de teste respondem como uma lista sadia
 * (listado); o resto segue `answer` (padrão: NXDOMAIN = não listado).
 */
function healthy(answer: (name: string) => string[] = () => nx(), queries: string[] = []): BlacklistResolverLike {
  return {
    resolve4: async (name) => {
      queries.push(name);
      if (name.startsWith("2.0.0.127.")) return ["127.0.0.2"];
      if (name.startsWith("dbltest.com.")) return ["127.0.1.2"];
      return answer(name);
    },
  };
}

function failing(code: string): BlacklistResolverLike {
  return { resolve4: () => Promise.reject(Object.assign(new Error(code), { code })) };
}

describe("defaultBlacklistResolver", () => {
  it("usa o resolver do sistema (sem fixar servidores públicos)", () => {
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

describe("isValidDqsKey", () => {
  it("aceita só letras minúsculas e números, de 20 a 64", () => {
    expect(isValidDqsKey("abcdefghij0123456789abcdef")).toBe(true);
    expect(isValidDqsKey("curta")).toBe(false);
    expect(isValidDqsKey("ABCDEFGHIJ0123456789ABCDEF")).toBe(false);
    expect(isValidDqsKey("abcdefghij0123456789.evil.com")).toBe(false);
    expect(isValidDqsKey("a".repeat(65))).toBe(false);
  });
});

describe("checkIpBlacklists", () => {
  it("consulta o IP invertido e o ponto de teste de cada zona", async () => {
    const queries: string[] = [];
    await checkIpBlacklists(IP, healthy(undefined, queries));
    for (const def of IP_DNSBLS) {
      expect(queries).toContain(`10.113.0.203.${def.zone}`);
      expect(queries).toContain(`2.0.0.127.${def.zone}`);
    }
  });

  it("lista sadia e IP fora dela → limpo, com a página para conferir", async () => {
    const results = await checkIpBlacklists(IP, healthy());
    expect(results.map((r) => r.status)).toEqual(IP_DNSBLS.map(() => "clean"));
    expect(results.every((r) => r.removalUrl === null)).toBe(true);
    expect(results.every((r) => typeof r.lookupUrl === "string" && r.lookupUrl.startsWith("https://"))).toBe(true);
  });

  it("ENODATA também conta como fora da lista", async () => {
    const results = await checkIpBlacklists(
      IP,
      healthy(() => {
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      }),
    );
    expect(results.every((r) => r.status === "clean")).toBe(true);
  });

  it("resposta 127.0.0.x → listado, com o link de remoção", async () => {
    const results = await checkIpBlacklists(IP, healthy(() => ["127.0.0.4"]));
    for (const r of results) {
      expect(r.status).toBe("listed");
      expect(r.removalUrl).toMatch(/^https:\/\//);
      expect(r.detail).toContain("127.0.0.4");
    }
  });

  it("127.255.255.x na consulta → não deu para verificar (a lista recusou), NUNCA listado", async () => {
    const results = await checkIpBlacklists(IP, healthy(() => ["127.255.255.254"]));
    for (const r of results) {
      expect(r.status).toBe("unknown");
      expect(r.detail).toContain("recusou");
      expect(r.removalUrl).toBeNull();
    }
  });

  it("resposta mista (127.0.0.x e 127.255.255.x) → listado vence", async () => {
    const results = await checkIpBlacklists(IP, healthy(() => ["127.255.255.254", "127.0.0.4"]));
    expect(results.every((r) => r.status === "listed")).toBe(true);
  });

  it("resposta que não é 127.x → limpo", async () => {
    const results = await checkIpBlacklists(IP, healthy(() => ["203.0.113.10"]));
    expect(results.every((r) => r.status === "clean")).toBe(true);
  });

  it("o ponto de teste não responde (resolvedor público, sem cadastro) → não deu para verificar, nunca limpo", async () => {
    // Tudo NXDOMAIN, inclusive o ponto de teste: a lista não está respondendo
    // a este servidor DNS, então "não listado" não vale nada.
    const results = await checkIpBlacklists(IP, failing("ENOTFOUND"));
    for (const r of results) {
      expect(r.status).toBe("unknown");
      expect(r.removalUrl).toBeNull();
      expect(r.lookupUrl).toMatch(/^https:\/\//);
    }
    const barracuda = results.find((r) => r.dnsbl === "barracuda")!;
    expect(barracuda.detail).toMatch(/cadastr/);
    expect(barracuda.detail).toMatch(/site/);
    const zen = results.find((r) => r.dnsbl === "spamhaus-zen")!;
    expect(zen.detail).toMatch(/DQS/);
  });

  it("o ponto de teste volta recusado (127.255.255.254) → não deu para verificar", async () => {
    const resolver: BlacklistResolverLike = { resolve4: async () => ["127.255.255.254"] };
    const results = await checkIpBlacklists(IP, resolver);
    expect(results.every((r) => r.status === "unknown")).toBe(true);
  });

  it("o ponto de teste não responde, mas o IP aparece listado → não deu para verificar (resposta não confiável)", async () => {
    const resolver: BlacklistResolverLike = {
      resolve4: async (name) => (name.startsWith("2.0.0.127.") ? nx() : ["127.0.0.2"]),
    };
    const results = await checkIpBlacklists(IP, resolver);
    expect(results.every((r) => r.status === "unknown")).toBe(true);
  });

  it("erro de rede inesperado → não deu para verificar, com o código", async () => {
    const results = await checkIpBlacklists(
      IP,
      healthy(() => {
        throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      }),
    );
    expect(results.every((r) => r.status === "unknown")).toBe(true);
    expect(results.every((r) => r.detail?.includes("ETIMEDOUT"))).toBe(true);
  });

  it("erro sem código → não deu para verificar, 'erro desconhecido'", async () => {
    const results = await checkIpBlacklists(
      IP,
      healthy(() => {
        throw new Error("boom");
      }),
    );
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

  it("resultado carrega a identidade da lista (id, nome)", async () => {
    const results = await checkIpBlacklists(IP, healthy());
    expect(results.find((r) => r.dnsbl === "spamhaus-zen")).toMatchObject({ label: "Spamhaus ZEN" });
    expect(results.map((r) => r.dnsbl)).toEqual(IP_DNSBLS.map((d) => d.id));
  });

  it("com a chave DQS, a Spamhaus é consultada pela zona da chave; as outras não mudam", async () => {
    const key = "abcdefghij0123456789abcdef";
    const queries: string[] = [];
    const results = await checkIpBlacklists(IP, healthy(undefined, queries), { dqsKey: key });
    expect(queries).toContain(`10.113.0.203.${key}.zen.dq.spamhaus.net`);
    expect(queries).toContain(`2.0.0.127.${key}.zen.dq.spamhaus.net`);
    expect(queries).not.toContain("10.113.0.203.zen.spamhaus.org");
    expect(queries).toContain("10.113.0.203.bl.spamcop.net");
    expect(results.find((r) => r.dnsbl === "spamhaus-zen")).toMatchObject({ label: "Spamhaus ZEN (DQS)", status: "clean" });
  });

  it("chave DQS inválida é ignorada (nunca vai parar no nome consultado)", async () => {
    const queries: string[] = [];
    await checkIpBlacklists(IP, healthy(undefined, queries), { dqsKey: "x.evil.example" });
    expect(queries).toContain("10.113.0.203.zen.spamhaus.org");
    expect(queries.some((q) => q.includes("evil"))).toBe(false);
  });

  it("chave DQS sem resposta ao ponto de teste → não deu para verificar, sugerindo conferir a chave", async () => {
    const key = "abcdefghij0123456789abcdef";
    const resolver: BlacklistResolverLike = {
      resolve4: async (name) => (name.includes(".dq.spamhaus.net") ? nx() : healthy().resolve4(name)),
    };
    const results = await checkIpBlacklists(IP, resolver, { dqsKey: key });
    const zen = results.find((r) => r.dnsbl === "spamhaus-zen")!;
    expect(zen.status).toBe("unknown");
    expect(zen.detail).toMatch(/chave/i);
  });

  it("chave DQS apagada (null) → zona pública", async () => {
    const queries: string[] = [];
    await checkIpBlacklists(IP, healthy(undefined, queries), { dqsKey: null });
    expect(queries).toContain("10.113.0.203.zen.spamhaus.org");
  });

  it("chave DQS recusada pela Spamhaus (127.255.255.x no ponto de teste) → não deu para verificar, sugerindo conferir a chave", async () => {
    const key = "abcdefghij0123456789abcdef";
    const resolver: BlacklistResolverLike = {
      resolve4: async (name) => (name.includes(".dq.spamhaus.net") ? ["127.255.255.250"] : healthy().resolve4(name)),
    };
    const results = await checkIpBlacklists(IP, resolver, { dqsKey: key });
    const zen = results.find((r) => r.dnsbl === "spamhaus-zen")!;
    expect(zen.status).toBe("unknown");
    expect(zen.detail).toMatch(/chave/i);
  });
});

describe("checkDomainBlacklists", () => {
  it("consulta o domínio e o domínio de teste em cada zona de domínio", async () => {
    const queries: string[] = [];
    const results = await checkDomainBlacklists("exemplo.com.br", healthy(undefined, queries));
    for (const def of DOMAIN_DNSBLS) {
      expect(queries).toContain(`exemplo.com.br.${def.zone}`);
      expect(queries).toContain(`dbltest.com.${def.zone}`);
    }
    expect(results.every((r) => r.status === "clean")).toBe(true);
  });

  it("domínio listado → listado", async () => {
    const results = await checkDomainBlacklists("spam.example", healthy(() => ["127.0.1.2"]));
    expect(results.every((r) => r.status === "listed")).toBe(true);
  });

  it("sem resposta ao domínio de teste → não deu para verificar", async () => {
    const results = await checkDomainBlacklists("exemplo.com.br", failing("ENOTFOUND"));
    expect(results.every((r) => r.status === "unknown")).toBe(true);
  });

  it("com a chave DQS, a DBL vai pela zona da chave", async () => {
    const key = "abcdefghij0123456789abcdef";
    const queries: string[] = [];
    await checkDomainBlacklists("exemplo.com.br", healthy(undefined, queries), { dqsKey: key });
    expect(queries).toContain(`exemplo.com.br.${key}.dbl.dq.spamhaus.net`);
    expect(queries).toContain(`dbltest.com.${key}.dbl.dq.spamhaus.net`);
  });
});
