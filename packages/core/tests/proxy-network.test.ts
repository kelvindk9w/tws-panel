/**
 * Rede do proxy por projeto (`paas-proxy-<slug>`): nome, reconhecimento e sub-rede da faixa própria, que não colide
 * com a do e-mail.
 */
import { describe, expect, it } from "vitest";
import {
  MAIL_SUBNET_POOL_DEFAULT,
  PROXY_SUBNET_POOL_DEFAULT,
  allocateMailSubnet,
  allocateProxySubnet,
  ipv4CidrsOverlap,
  isPanelMailNetworkName,
  isProjectProxyNetworkName,
  projectProxyNetworkName,
  projectSubnetPool,
  proxySubnetPool,
} from "../src/index";

describe("rede do proxy por projeto: nome", () => {
  it("projectProxyNetworkName: paas-proxy-<slug>; slug fora da allowlist lança", () => {
    expect(projectProxyNetworkName("loja")).toBe("paas-proxy-loja");
    expect(projectProxyNetworkName("meu-site-2")).toBe("paas-proxy-meu-site-2");
    for (const bad of ["", "Loja", "a b", "a;rm", "x".repeat(64), "loja_1"]) expect(() => projectProxyNetworkName(bad), bad).toThrow(/slug inválido/);
  });

  it("isProjectProxyNetworkName: só o formato do painel (rede de compose tem `_`)", () => {
    expect(isProjectProxyNetworkName("paas-proxy-loja")).toBe(true);
    expect(isProjectProxyNetworkName("paas-proxy-proxy-x")).toBe(true);
    for (const n of ["paas-net", "paas-proxy-", "paas-proxy-x_default", "paas-proxy-Loja", "paas-mail-loja", "outra"]) expect(isProjectProxyNetworkName(n), n).toBe(false);
  });

  it("a rede do proxy nunca é confundida com rede de e-mail do painel", () => {
    expect(isPanelMailNetworkName(projectProxyNetworkName("mail-x"))).toBe(false);
  });
});

describe("rede do proxy por projeto: sub-rede", () => {
  it("faixa padrão própria, sem sobrepor a do e-mail", () => {
    expect(PROXY_SUBNET_POOL_DEFAULT).toBe("10.214.0.0/16");
    expect(ipv4CidrsOverlap(PROXY_SUBNET_POOL_DEFAULT, MAIL_SUBNET_POOL_DEFAULT)).toBe(false);
  });

  it("proxySubnetPool: só faixa privada e /26 ou maior; senão a padrão", () => {
    expect(proxySubnetPool(undefined)).toBe(PROXY_SUBNET_POOL_DEFAULT);
    expect(proxySubnetPool(null)).toBe(PROXY_SUBNET_POOL_DEFAULT);
    expect(proxySubnetPool("172.29.3.9/24")).toBe("172.29.3.0/24");
    for (const bad of ["203.0.113.0/24", "10.0.0.0/27", "lixo", ""]) expect(proxySubnetPool(bad), bad).toBe(PROXY_SUBNET_POOL_DEFAULT);
    expect(projectSubnetPool("lixo", "10.9.0.0/16")).toBe("10.9.0.0/16");
  });

  it("allocateProxySubnet: determinístico, /26 da faixa do proxy e sem colidir com redes existentes", () => {
    const a = allocateProxySubnet("loja", []);
    expect(a).toMatch(/^10\.214\.\d+\.\d+\/26$/);
    expect(allocateProxySubnet("loja", [])).toBe(a);
    expect(allocateProxySubnet("loja", [a!])).not.toBe(a);
    // a mesma conta do e-mail, cada uma na sua faixa
    expect(allocateMailSubnet("loja", [])).toMatch(/^10\.213\./);
    const used: string[] = ["172.17.0.0/16"];
    for (let i = 0; i < 200; i++) {
      const b = allocateProxySubnet(`p-${i}`, used)!;
      expect(used.some((u) => ipv4CidrsOverlap(u, b))).toBe(false);
      used.push(b);
    }
  });

  it("faixa cheia → null; faixa trocada é respeitada", () => {
    expect(allocateProxySubnet("x", ["10.214.0.0/16"])).toBeNull();
    expect(allocateProxySubnet("x", [], "192.168.77.0/26")).toBe("192.168.77.0/26");
    expect(allocateProxySubnet("x", [], "203.0.113.0/24")).toMatch(/^10\.214\./);
  });
});
