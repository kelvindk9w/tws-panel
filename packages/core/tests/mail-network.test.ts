import { describe, expect, it } from "vitest";
import {
  MAIL_SUBNET_POOL_DEFAULT,
  allocateMailSubnet,
  ipv4CidrsOverlap,
  isPanelMailNetworkName,
  isProjectMailNetworkName,
  mailExclusionText,
  mailLabelValue,
  mailServiceDecision,
  mailSubnetPool,
  parseIpv4Cidr,
  projectMailNetworkName,
} from "../src/mail-network";

describe("mailServiceDecision", () => {
  it("app, worker e imagem desconhecida entram", () => {
    expect(mailServiceDecision({ image: "minha-app:1" })).toEqual({ include: true });
    expect(mailServiceDecision({})).toEqual({ include: true });
    expect(mailServiceDecision({ image: null, buildBase: "node:22" })).toEqual({ include: true });
  });

  it("banco e cache reconhecidos ficam de fora, com registro e tag", () => {
    for (const image of ["mysql:8", "postgres:16-alpine", "docker.io/library/redis:7", "ghcr.io/x/valkey", "mcr.microsoft.com/mssql/server:2022", "mariadb"]) {
      expect(mailServiceDecision({ image })).toMatchObject({ include: false, reason: "database-image", image });
    }
  });

  it("serviço com build cujo Dockerfile parte de um banco fica de fora", () => {
    const d = mailServiceDecision({ image: null, buildBase: "postgres:16" });
    expect(d).toEqual({ include: false, reason: "database-build", image: "postgres:16" });
    expect(mailExclusionText(d)).toBe("Dockerfile parte da imagem de banco/cache postgres:16");
  });

  it("label tws.mail=true mantém um banco; =false tira um app", () => {
    expect(mailServiceDecision({ image: "postgres:16", label: "true" })).toEqual({ include: true, forced: true });
    expect(mailServiceDecision({ image: null, buildBase: "redis:7", label: " TRUE " })).toEqual({ include: true, forced: true });
    expect(mailServiceDecision({ image: "app:1", label: "true" })).toEqual({ include: true });
    const off = mailServiceDecision({ image: "app:1", label: "False" });
    expect(off).toEqual({ include: false, reason: "label" });
    expect(mailExclusionText(off)).toBe("label tws.mail=false");
    expect(mailServiceDecision({ image: "postgres:16", label: "talvez" })).toMatchObject({ include: false });
    expect(mailExclusionText(mailServiceDecision({ image: "mysql:8" }))).toBe("imagem de banco/cache mysql:8");
  });
});

describe("mailLabelValue e exclusão por rede compartilhada", () => {
  it("só true/false valem, sem diferenciar maiúsculas", () => {
    expect(mailLabelValue(" True ")).toBe("true");
    expect(mailLabelValue("FALSE")).toBe("false");
    expect(mailLabelValue("sim")).toBeNull();
    expect(mailLabelValue(null)).toBeNull();
    expect(mailLabelValue(undefined)).toBeNull();
  });
  it("texto do motivo shared-network cita o dono", () => {
    expect(mailExclusionText({ include: false, reason: "shared-network", image: "db" })).toMatch(/usa a rede de db .*tws\.mail=true em db/);
  });
});

describe("rede de e-mail por projeto: nomes", () => {
  it("paas-mail-<slug>; slug fora da allowlist é recusado", () => {
    expect(projectMailNetworkName("projeto-a")).toBe("paas-mail-projeto-a");
    for (const bad of ["", "A", "a b", "a;b", "a/b", "x".repeat(64)]) expect(() => projectMailNetworkName(bad), bad).toThrow(/slug inválido/);
  });

  it("slug 'admin' não forma a rede da administração do Stalwart", () => {
    expect(projectMailNetworkName("admin")).toBe("paas-mail--admin");
    expect(isProjectMailNetworkName("paas-mail--admin")).toBe(true);
  });

  it("isProjectMailNetworkName: só o formato da rede de projeto", () => {
    expect(isProjectMailNetworkName("paas-mail-projeto-a")).toBe(true);
    for (const n of ["paas-mail", "paas-mail-admin", "paas-mailweb", "paas-mailtest-a", "paas-mail-x_default", "paas-mail-", "paas-net", "paas-mail-A"]) {
      expect(isProjectMailNetworkName(n), n).toBe(false);
    }
  });

  it("isPanelMailNetworkName: toda rede paas-mail* do painel, nunca rede de compose", () => {
    for (const n of ["paas-mail", "paas-mail-admin", "paas-mailweb", "paas-mail-projeto-b", "paas-mailtest-a", "paas-mailtestadm-a", " PAAS-MAIL-X "]) {
      expect(isPanelMailNetworkName(n), n).toBe(true);
    }
    for (const n of ["paas-mailer_default", "paas-mail-x_default", "paas-net", "minha-paas-mail", "paas-mai"]) expect(isPanelMailNetworkName(n), n).toBe(false);
  });
});

describe("rede de e-mail por projeto: sub-rede", () => {
  it("parseIpv4Cidr alinha a base e recusa o que não é CIDR IPv4", () => {
    expect(parseIpv4Cidr("10.213.5.7/27")).toEqual({ base: (10 << 24 | 213 << 16 | 5 << 8 | 0) >>> 0, bits: 27 });
    expect(parseIpv4Cidr("0.0.0.0/0")).toEqual({ base: 0, bits: 0 });
    for (const bad of ["10.0.0.0", "10.0.0.256/24", "10.0.0.0/33", "fd00::/64", "x"]) expect(parseIpv4Cidr(bad), bad).toBeNull();
  });

  it("ipv4CidrsOverlap", () => {
    expect(ipv4CidrsOverlap("10.213.0.0/16", "10.213.4.32/27")).toBe(true);
    expect(ipv4CidrsOverlap("10.213.4.32/27", "10.213.4.64/27")).toBe(false);
    expect(ipv4CidrsOverlap("10.0.0.0/8", "172.17.0.0/16")).toBe(false);
    expect(ipv4CidrsOverlap("fd00::/64", "10.0.0.0/8")).toBe(false);
  });

  it("mailSubnetPool: só faixa privada e /26 ou maior; senão a padrão", () => {
    expect(mailSubnetPool(undefined)).toBe(MAIL_SUBNET_POOL_DEFAULT);
    expect(mailSubnetPool("172.30.1.9/24")).toBe("172.30.1.0/24");
    expect(mailSubnetPool("192.168.50.0/23")).toBe("192.168.50.0/23");
    for (const bad of ["203.0.113.0/24", "10.0.0.0/28", "10.0.0.0/27", "198.51.100.0/24", "0.0.0.0/0", "lixo", ""]) expect(mailSubnetPool(bad), bad).toBe(MAIL_SUBNET_POOL_DEFAULT);
  });

  it("allocateMailSubnet: determinístico, /26 dentro da faixa e sem colidir com nenhuma rede existente", () => {
    const a = allocateMailSubnet("projeto-a", []);
    expect(a).toMatch(/^10\.213\.\d+\.\d+\/26$/);
    expect(allocateMailSubnet("projeto-a", [])).toBe(a);
    expect(allocateMailSubnet("projeto-a", [a!])).not.toBe(a);
    // 300 projetos: todos com bloco próprio, nenhum sobreposto
    const used: string[] = ["172.17.0.0/16", "10.213.0.0/24"];
    for (let i = 0; i < 300; i++) {
      const b = allocateMailSubnet(`projeto-${i}`, used)!;
      expect(used.some((u) => ipv4CidrsOverlap(u, b))).toBe(false);
      used.push(b);
    }
  });

  it("allocateMailSubnet: faixa cheia → null; dá a volta no fim da faixa", () => {
    expect(allocateMailSubnet("x", ["10.213.0.0/16"])).toBeNull();
    expect(allocateMailSubnet("x", ["10.0.0.0/8"], "10.1.2.0/26")).toBeNull();
    expect(allocateMailSubnet("x", [], "10.1.2.0/26")).toBe("10.1.2.0/26");
    expect(allocateMailSubnet("x", ["10.1.2.64/26"], "10.1.2.0/25")).toBe("10.1.2.0/26");
    expect(allocateMailSubnet("x", ["10.1.2.0/26"], "10.1.2.0/25")).toBe("10.1.2.64/26");
    // uma rede /27 já criada (versão anterior desta regra) também conta como ocupada
    expect(allocateMailSubnet("x", ["10.1.2.0/27"], "10.1.2.0/25")).toBe("10.1.2.64/26");
  });
});
