/**
 * Administração HTTP do Stalwart só para a rede do painel.
 *
 * Defeito: o ouvinte HTTP (porta 8080: API de gerenciamento e console) escutava em todas as interfaces do container,
 * e o Stalwart está nas redes de e-mail de cada projeto e na do webmail — qualquer container de projeto chegava à
 * administração. Agora `server.http.allowed-endpoint` devolve 403 a quem não vem da paas-mail-admin (nem do gateway,
 * por onde chega a porta publicada em 127.0.0.1 do host). A linguagem do Stalwart não tem "IP em CIDR": a sub-rede
 * vira prefixos de texto que a cobrem exatamente.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_DENIED_STATUS,
  adminAccessCondition,
  adminAccessSection,
  cidrTerms,
  decideAdminAccess,
  isIpv4,
  normalizeAdminAccess,
  parseIpamConfig,
  sameAdminAccess,
  type AdminAccessFacts,
} from "../src/admin-access.js";

describe("cidrTerms — sub-rede em prefixos de texto exatos", () => {
  it("octetos inteiros: um prefixo com ponto no fim (10.1. nunca casa 10.10.x)", () => {
    expect(cidrTerms("10.213.0.0/16")).toEqual(["^10.213."]);
    expect(cidrTerms("10.0.0.0/8")).toEqual(["^10."]);
    expect(cidrTerms("192.0.2.0/24")).toEqual(["^192.0.2."]);
  });

  it("máscara fora do octeto: um termo por bloco, alinhado mesmo com endereço base desalinhado", () => {
    const t = cidrTerms("172.20.16.0/20")!;
    expect(t).toHaveLength(16);
    expect(t[0]).toBe("^172.20.16.");
    expect(t[15]).toBe("^172.20.31.");
    expect(cidrTerms("172.20.17.5/20")).toEqual(t);
    expect(cidrTerms("10.0.0.0/9")).toHaveLength(128);
  });

  it("maior que /24: IPs exatos", () => {
    expect(cidrTerms("192.0.2.64/30")).toEqual(["=192.0.2.64", "=192.0.2.65", "=192.0.2.66", "=192.0.2.67"]);
    expect(cidrTerms("192.0.2.9/32")).toEqual(["=192.0.2.9"]);
  });

  it("recusa o que não é sub-rede IPv4 válida ou é larga demais", () => {
    for (const bad of ["", "10.0.0.0", "10.0.0.0/7", "10.0.0.0/33", "10.0.0.0/x", "256.0.0.0/16", "fd00::/64", "1.2.3/24", "10.0.0.0/16/1"]) {
      expect(cidrTerms(bad)).toBeNull();
    }
  });

  it("isIpv4", () => {
    expect(isIpv4("203.0.113.1")).toBe(true);
    expect(isIpv4(" 203.0.113.1 ")).toBe(true);
    expect(isIpv4("203.0.113.256")).toBe(false);
    expect(isIpv4("::1")).toBe(false);
  });
});

describe("condição e seção do config.toml", () => {
  it("permite a sub-rede e os gateways; o resto recebe 403", () => {
    const access = { cidrs: ["10.99.0.0/16"], ips: ["172.18.0.1", "10.99.0.1"] };
    expect(adminAccessCondition(access)).toBe(
      "remote_ip == '10.99.0.1' || remote_ip == '172.18.0.1' || starts_with(remote_ip, '10.99.')",
    );
    const section = adminAccessSection(access);
    expect(section).toContain("[server.http]");
    expect(section.find((l) => l.startsWith("allowed-endpoint"))).toBe(
      `allowed-endpoint = [{if = "${adminAccessCondition(access)}", then = 200}, {else = ${ADMIN_DENIED_STATUS}}]`,
    );
    expect(ADMIN_DENIED_STATUS).toBe(403);
  });

  it("sem restrição, vazia ou com valor inválido: nenhuma seção (fica como antes, nada de texto livre no TOML)", () => {
    expect(adminAccessSection(null)).toEqual([]);
    expect(adminAccessSection(undefined)).toEqual([]);
    expect(adminAccessSection({ cidrs: [], ips: [] })).toEqual([]);
    expect(adminAccessCondition({ cidrs: ["10.0.0.0/16'"], ips: [] })).toBeNull();
    expect(adminAccessCondition({ cidrs: ["10.0.0.0/16"], ips: ["1.2.3.4' || true"] })).toBeNull();
  });

  it("forma canônica e comparação independem de ordem e repetição", () => {
    expect(normalizeAdminAccess({ cidrs: [" b ", "a", "a"], ips: ["2", "1"] })).toEqual({ cidrs: ["a", "b"], ips: ["1", "2"] });
    expect(sameAdminAccess({ cidrs: ["a"], ips: ["1", "2"] }, { cidrs: ["a"], ips: ["2", "1"] })).toBe(true);
    expect(sameAdminAccess({ cidrs: ["a"], ips: [] }, { cidrs: ["b"], ips: [] })).toBe(false);
    expect(sameAdminAccess({ cidrs: ["a"], ips: ["1"] }, { cidrs: ["a"], ips: [] })).toBe(false);
    expect(sameAdminAccess(null, undefined)).toBe(true);
    expect(sameAdminAccess(null, { cidrs: [], ips: [] })).toBe(false);
    expect(sameAdminAccess({ cidrs: [], ips: [] }, null)).toBe(false);
  });
});

describe("parseIpamConfig", () => {
  it("lê a lista do IPAM; saída ilegível ou que não é lista vira null", () => {
    expect(parseIpamConfig('[{"Subnet":"10.99.0.0/16","Gateway":"10.99.0.1"}, null, 3]\n')).toEqual([
      { Subnet: "10.99.0.0/16", Gateway: "10.99.0.1" },
    ]);
    expect(parseIpamConfig("")).toBeNull();
    expect(parseIpamConfig("{}")).toBeNull();
    expect(parseIpamConfig("não é json")).toBeNull();
  });
});

describe("decideAdminAccess", () => {
  const base: AdminAccessFacts = {
    adminNetwork: "paas-mail-admin",
    stalwartNetworks: ["paas-mail-admin", "paas-mail", "paas-mailweb", "paas-mail-loja"],
    panelNetworks: ["paas-net", "paas-mail-admin", "paas-proxy-loja"],
    adminIpam: [{ Subnet: "10.99.0.0/16", Gateway: "10.99.0.1" }],
    gatewayIpams: [[{ Subnet: "10.99.0.0/16", Gateway: "10.99.0.1" }], [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }, {}]],
  };

  it("caso normal: a sub-rede da administração e os gateways (sem repetir)", () => {
    expect(decideAdminAccess(base)).toEqual({ access: { cidrs: ["10.99.0.0/16"], ips: ["10.99.0.1", "172.18.0.1"] } });
  });

  it("qualquer dúvida que trancaria o painel: não restringe e diz por quê", () => {
    const cases: Array<[Partial<AdminAccessFacts>, RegExp]> = [
      [{ stalwartNetworks: ["paas-mail"] }, /servidor de e-mail não está na rede paas-mail-admin/],
      [{ panelNetworks: ["paas-net"] }, /painel não está na rede paas-mail-admin/],
      [{ stalwartNetworks: [...base.stalwartNetworks, "paas-net"] }, /dividem a rede paas-net/],
      [{ adminIpam: [] }, /não informou sub-rede/],
      [{ adminIpam: [{ Gateway: "10.99.0.1" }] }, /não informou sub-rede/],
      [{ adminIpam: [{ Subnet: "10.99.0.0/16" }, { Subnet: "fd00:1::/64" }] }, /IPv6/],
      [{ adminIpam: [{ Subnet: "10.0.0.0/6" }] }, /não dá para expressar/],
    ];
    for (const [patch, reason] of cases) {
      const decision = decideAdminAccess({ ...base, ...patch });
      expect("unsafe" in decision && decision.unsafe).toMatch(reason);
    }
  });
});
