/**
 * panel-domain.test.ts — Configurações → Domínio do painel (serviço).
 *
 * Sem Docker e sem DNS de verdade: o proxy, o certificado e os resolvedores
 * são dublês. O que importa aqui é a regra:
 *  - o DNS é conferido no resolvedor público (o do sistema só quando o
 *    público não responde), como o e-mail faz;
 *  - com o DNS certo, o domínio entra no bloco do painel JUNTO do endereço
 *    pelo IP (os dois respondem);
 *  - "Desativar o acesso pelo IP" só com a página aberta pelo domínio novo,
 *    certificado válido e o domínio digitado;
 *  - nunca o painel sem endereço: remover/trocar o domínio reativa o IP;
 *  - a escolha fica gravada em <dataDir>/panel-domain.json e volta no boot.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CertificateItem } from "@paas/core";
import {
  checkPanelDomainDns,
  disableIpBlockers,
  normalizePanelDomainInput,
  PanelDomainService,
  type PanelDomainAuditSink,
  type PanelDomainDeps,
  type PanelDomainResolver,
} from "../src/services/panel-domain.js";

const IP_HOST = "203-0-113-10.sslip.io";
const DOMAIN = "painel.exemplo.com.br";

function resolver(answers: { a?: string[] | Error; aaaa?: string[] | Error }): PanelDomainResolver {
  const pick = (v: string[] | Error | undefined) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? []));
  return { resolve4: vi.fn(() => pick(answers.a)), resolve6: vi.fn(() => pick(answers.aaaa)) };
}

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function cert(state: CertificateItem["state"]): CertificateItem {
  return {
    host: DOMAIN,
    owner: { kind: "panel", projectId: null, projectName: null },
    mode: "automatic",
    coveredBy: null,
    state,
    issuer: state === "valid" ? "Let's Encrypt" : null,
    validTo: null,
    renewsAround: null,
    lastError: null,
    manual: null,
    canRetry: state !== "valid",
  };
}

describe("normalizePanelDomainInput", () => {
  it("aceita subdomínio próprio, em minúsculas e sem espaços, ponto final ou https://", () => {
    expect(normalizePanelDomainInput("  Painel.Exemplo.com.br. ", IP_HOST)).toEqual({ ok: true, domain: DOMAIN });
    expect(normalizePanelDomainInput("https://painel.exemplo.com.br/", IP_HOST)).toEqual({ ok: true, domain: DOMAIN });
  });

  it.each([
    ["", /Informe/],
    ["painel", /domínio completo/],
    ["203.0.113.10", /IP/],
    ["x.203-0-113-10.sslip.io", /sslip\.io/],
    [IP_HOST, /sslip\.io/],
    ["painel.localhost", /localhost/],
    ["*.exemplo.com.br", /inválido/],
    ["painel exemplo.com.br", /inválido/],
    ["a".repeat(64) + ".exemplo.com.br", /inválido/],
  ])("recusa %j", (raw, msg) => {
    const r = normalizePanelDomainInput(raw, IP_HOST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(msg);
  });
});

describe("checkPanelDomainDns — resolvedor público, como o e-mail", () => {
  const base = { domain: DOMAIN, expectedIp: "203.0.113.10", expectedIpv6: null, now: () => 0 };

  it("A apontando para a VPS → ok", async () => {
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: ["203.0.113.10"], aaaa: dnsError("ENODATA") }) });
    expect(r.ok).toBe(true);
    expect(r.problem).toBe("ok");
    expect(r.ipv4).toEqual(["203.0.113.10"]);
    expect(r.message).toMatch(/aponta para esta VPS/);
  });

  it("sem registro → missing, dizendo qual registro criar e a nuvem cinza", async () => {
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: dnsError("ENOTFOUND"), aaaa: dnsError("ENOTFOUND") }) });
    expect(r.problem).toBe("missing");
    expect(r.message).toContain("203.0.113.10");
    expect(r.message).toMatch(/nuvem cinza/);
  });

  it("nuvem laranja da Cloudflare → cloudflare", async () => {
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: ["104.16.1.1", "172.67.1.1"] }) });
    expect(r.problem).toBe("cloudflare");
    expect(r.message).toMatch(/nuvem cinza/);
  });

  it("A apontando para outro IP (ou para dois lugares) → wrong_ip", async () => {
    expect((await checkPanelDomainDns({ ...base, primary: resolver({ a: ["198.51.100.7"] }) })).problem).toBe("wrong_ip");
    const dois = await checkPanelDomainDns({ ...base, primary: resolver({ a: ["203.0.113.10", "198.51.100.7"] }) });
    expect(dois.problem).toBe("wrong_ip");
    expect(dois.message).toContain("198.51.100.7");
  });

  it("AAAA para outro lugar → wrong_ipv6 (o Let's Encrypt prefere IPv6)", async () => {
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: ["203.0.113.10"], aaaa: ["2001:db8::1"] }) });
    expect(r.problem).toBe("wrong_ipv6");
    expect(r.message).toMatch(/AAAA/);
  });

  it("AAAA igual ao IPv6 da VPS → ok", async () => {
    const r = await checkPanelDomainDns({
      ...base,
      expectedIpv6: "2001:db8::10",
      primary: resolver({ a: ["203.0.113.10"], aaaa: ["2001:db8::10"] }),
    });
    expect(r.ok).toBe(true);
  });

  it("DNS público sem resposta → pergunta ao do sistema", async () => {
    const fallback = resolver({ a: ["203.0.113.10"] });
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: dnsError("ETIMEOUT"), aaaa: dnsError("ETIMEOUT") }), fallback });
    expect(r.ok).toBe(true);
    expect(fallback.resolve4).toHaveBeenCalledWith(DOMAIN);
  });

  it("nenhum DNS respondeu → unavailable (nunca 'ok' sem resposta)", async () => {
    const r = await checkPanelDomainDns({
      ...base,
      primary: resolver({ a: dnsError("ETIMEOUT") }),
      fallback: resolver({ a: new Error("sem rede") }),
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toBe("unavailable");
  });

  it("IPv6 sem resposta não derruba a conferência do A", async () => {
    const r = await checkPanelDomainDns({ ...base, primary: resolver({ a: ["203.0.113.10"], aaaa: dnsError("ETIMEOUT") }) });
    expect(r.ok).toBe(true);
  });

  it("sem o IP da VPS → no_server_ip", async () => {
    const r = await checkPanelDomainDns({ ...base, expectedIp: null, primary: resolver({ a: ["203.0.113.10"] }) });
    expect(r.problem).toBe("no_server_ip");
    expect(r.ok).toBe(false);
  });
});

describe("disableIpBlockers — quando o botão 'Desativar o acesso pelo IP' é liberado", () => {
  const pronto = {
    mode: "https" as const,
    domain: DOMAIN,
    domainActive: true,
    ipAccessDisabled: false,
    certificateValid: true,
    currentHost: DOMAIN,
  };

  it("domínio ativo, certificado válido e página aberta pelo domínio novo → liberado", () => {
    expect(disableIpBlockers(pronto)).toEqual([]);
  });

  it("aberta pelo endereço do IP → bloqueado, mandando abrir pelo domínio novo", () => {
    const b = disableIpBlockers({ ...pronto, currentHost: IP_HOST });
    expect(b.join(" ")).toContain(`https://${DOMAIN}`);
  });

  it("certificado ainda não válido → bloqueado", () => {
    expect(disableIpBlockers({ ...pronto, certificateValid: false }).join(" ")).toMatch(/certificado/);
  });

  it("sem domínio, domínio sem DNS conferido, já desativado ou modo túnel → bloqueado", () => {
    expect(disableIpBlockers({ ...pronto, domain: null, domainActive: false })).not.toEqual([]);
    expect(disableIpBlockers({ ...pronto, domainActive: false }).join(" ")).toMatch(/DNS/);
    expect(disableIpBlockers({ ...pronto, ipAccessDisabled: true }).join(" ")).toMatch(/já está desativado/);
    expect(disableIpBlockers({ ...pronto, mode: "tunnel" }).join(" ")).toMatch(/túnel/);
  });
});

describe("PanelDomainService", () => {
  let dataDir: string;
  let applied: Array<{ primary: string; aliases: string[] } | null>;
  let reserved: string[][];
  let certState: CertificateItem["state"] | null;
  let dns: PanelDomainResolver;
  let audit: { record: Mock<PanelDomainAuditSink["record"]> };
  let inUse: Set<string>;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-panel-domain-"));
    applied = [];
    reserved = [];
    certState = null;
    dns = resolver({ a: ["203.0.113.10"] });
    audit = { record: vi.fn(async () => undefined) };
    inUse = new Set();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function deps(over: Partial<PanelDomainDeps> = {}): PanelDomainDeps {
    return {
      dataDir,
      ipAddress: IP_HOST,
      serverIp: "203.0.113.10",
      serverIpv6: null,
      hostRepoDir: "/opt/tws-panel",
      applyAddresses: vi.fn(async (site) => {
        applied.push(site);
      }),
      setReserved: (names) => {
        reserved.push(names);
      },
      certificate: vi.fn(async () => (certState ? cert(certState) : null)),
      domainInUse: async (d) => inUse.has(d),
      resolver: dns,
      fallbackResolver: null,
      audit,
      ...over,
    };
  }

  async function stored(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(dataDir, "panel-domain.json"), "utf8")) as Record<string, unknown>;
  }

  it("sem nada cadastrado: só o endereço pelo IP; o caminho da configuração e o comando de volta aparecem", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    const s = await svc.status(IP_HOST);
    expect(s.mode).toBe("https");
    expect(s.domain).toBeNull();
    expect(s.addresses).toEqual([IP_HOST]);
    expect(s.openedVia).toBe("ip");
    expect(s.disableIp.allowed).toBe(false);
    expect(s.reactivateCommand).toBe("cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh");
    expect(s.configFile).toMatch(/panel-domain\.json/);
    expect(applied).toEqual([{ primary: IP_HOST, aliases: [] }]);
  });

  it("cadastrar: grava, reserva o nome, NÃO mexe no proxy antes do DNS e registra na auditoria", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    applied = [];
    const s = await svc.setDomain("Painel.Exemplo.com.br", "admin");
    expect(s.domain).toBe(DOMAIN);
    expect(s.domainActive).toBe(false);
    expect(s.addresses).toEqual([IP_HOST]);
    expect(applied).toEqual([]);
    expect(reserved.at(-1)).toEqual([DOMAIN]);
    expect(await stored()).toMatchObject({ domain: DOMAIN, active: false, ipAccessDisabled: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.set", target: DOMAIN, actor: "admin" }));
  });

  it("cadastrar recusa domínio inválido (400) e domínio já usado por projeto ou e-mail (409)", async () => {
    inUse.add("loja.exemplo.com.br");
    const svc = new PanelDomainService(deps());
    await svc.init();
    await expect(svc.setDomain("203.0.113.10", "admin")).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.setDomain("loja.exemplo.com.br", "admin")).rejects.toMatchObject({ statusCode: 409, code: "domain_in_use" });
  });

  it("verificar com DNS certo: ativa e acrescenta o domínio ao bloco do painel (os DOIS respondem)", async () => {
    const d = deps();
    const svc = new PanelDomainService(d);
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    const r = await svc.verify("admin", IP_HOST);
    expect(r.check.ok).toBe(true);
    expect(r.status.domainActive).toBe(true);
    expect(r.status.addresses).toEqual([DOMAIN, IP_HOST]);
    expect(applied.at(-1)).toEqual({ primary: DOMAIN, aliases: [IP_HOST] });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.activated", target: DOMAIN }));
    expect((await stored()).lastCheck).toMatchObject({ ok: true });
  });

  it("verificar de novo um domínio já ativo não reaplica o proxy nem audita outra vez", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    const antes = applied.length;
    await svc.verify("admin", IP_HOST);
    expect(applied.length).toBe(antes);
    expect(audit.record.mock.calls.filter((c) => (c[0] as { action: string }).action === "panel_domain.activated")).toHaveLength(1);
  });

  it("verificar com DNS errado: continua inativo e o proxy fica como está", async () => {
    const svc = new PanelDomainService(deps({ resolver: resolver({ a: ["198.51.100.7"] }) }));
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    applied = [];
    const r = await svc.verify("admin", IP_HOST);
    expect(r.check.problem).toBe("wrong_ip");
    expect(r.status.domainActive).toBe(false);
    expect(applied).toEqual([]);
  });

  it("verificar sem domínio cadastrado → 409", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await expect(svc.verify("admin", IP_HOST)).rejects.toMatchObject({ statusCode: 409, code: "no_domain" });
  });

  it("falha ao aplicar no proxy: não fica marcado como ativo (tenta de novo no próximo 'Verificar')", async () => {
    const d = deps();
    const svc = new PanelDomainService(d);
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    vi.mocked(d.applyAddresses).mockRejectedValueOnce(new Error("caddy fora"));
    await expect(svc.verify("admin", IP_HOST)).rejects.toThrow(/caddy fora/);
    expect((await svc.status(IP_HOST)).domainActive).toBe(false);
  });

  it("certificado válido, mas a página aberta pelo IP: 'Desativar' fica bloqueado (409) e nada muda", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    const s = await svc.status(IP_HOST);
    expect(s.certificate?.state).toBe("valid");
    expect(s.disableIp.allowed).toBe(false);
    await expect(svc.disableIp(DOMAIN, IP_HOST, "admin")).rejects.toMatchObject({ statusCode: 409, code: "disable_ip_blocked" });
    expect(applied.at(-1)).toEqual({ primary: DOMAIN, aliases: [IP_HOST] });
  });

  it("aberta pelo domínio novo, mas sem certificado válido → bloqueado", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "issuing";
    await expect(svc.disableIp(DOMAIN, DOMAIN, "admin")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("confirmação errada (domínio digitado diferente) → 400", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    await expect(svc.disableIp("painel.exemplo.com", DOMAIN, "admin")).rejects.toMatchObject({ statusCode: 400, code: "confirm_mismatch" });
  });

  it("desativar o IP: o bloco do painel fica SÓ com o domínio novo, gravado e auditado; reativar devolve os dois", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    expect((await svc.status(DOMAIN)).disableIp.allowed).toBe(true);
    const off = await svc.disableIp(` ${DOMAIN.toUpperCase()} `, DOMAIN, "admin");
    expect(off.ipAccessDisabled).toBe(true);
    expect(off.addresses).toEqual([DOMAIN]);
    expect(applied.at(-1)).toEqual({ primary: DOMAIN, aliases: [] });
    expect(await stored()).toMatchObject({ ipAccessDisabled: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.ip_disabled" }));

    const on = await svc.enableIp("admin");
    expect(on.ipAccessDisabled).toBe(false);
    expect(applied.at(-1)).toEqual({ primary: DOMAIN, aliases: [IP_HOST] });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.ip_enabled" }));
  });

  it("reativar com o IP já ativo não mexe em nada", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    applied = [];
    await svc.enableIp("admin");
    expect(applied).toEqual([]);
  });

  it("falha do proxy ao desativar: a escolha volta atrás (o painel continua nos dois endereços)", async () => {
    const d = deps();
    const svc = new PanelDomainService(d);
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    vi.mocked(d.applyAddresses).mockRejectedValueOnce(new Error("caddy fora"));
    await expect(svc.disableIp(DOMAIN, DOMAIN, "admin")).rejects.toThrow(/caddy fora/);
    expect((await svc.status(DOMAIN)).ipAccessDisabled).toBe(false);
    expect(await stored()).toMatchObject({ ipAccessDisabled: false });
  });

  it("remover o domínio com o IP desativado: o IP volta ANTES (nunca fica sem endereço)", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    await svc.disableIp(DOMAIN, DOMAIN, "admin");
    const s = await svc.removeDomain("admin");
    expect(s.domain).toBeNull();
    expect(s.ipAccessDisabled).toBe(false);
    expect(s.addresses).toEqual([IP_HOST]);
    expect(applied.at(-1)).toEqual({ primary: IP_HOST, aliases: [] });
    expect(reserved.at(-1)).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.removed", target: DOMAIN }));
  });

  it("remover sem domínio cadastrado → 409", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await expect(svc.removeDomain("admin")).rejects.toMatchObject({ statusCode: 409, code: "no_domain" });
  });

  it("trocar o domínio: o novo começa sem DNS conferido, o antigo sai do proxy e o IP volta", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    await svc.disableIp(DOMAIN, DOMAIN, "admin");
    const s = await svc.setDomain("acesso.exemplo.com.br", "admin");
    expect(s.domain).toBe("acesso.exemplo.com.br");
    expect(s.domainActive).toBe(false);
    expect(s.ipAccessDisabled).toBe(false);
    expect(applied.at(-1)).toEqual({ primary: IP_HOST, aliases: [] });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "panel_domain.set", detail: expect.stringMatching(/troc/i) }));
  });

  it("cadastrar o mesmo domínio de novo não desfaz nada", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    const s = await svc.setDomain(DOMAIN, "admin");
    expect(s.domainActive).toBe(true);
  });

  it("a escolha sobrevive ao reinício do painel: um serviço novo lê o arquivo e reaplica só o domínio", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    await svc.disableIp(DOMAIN, DOMAIN, "admin");
    applied = [];
    const depois = new PanelDomainService(deps());
    await depois.init();
    expect(applied).toEqual([{ primary: DOMAIN, aliases: [] }]);
    expect(reserved.at(-1)).toEqual([DOMAIN]);
  });

  it("arquivo inválido ou incoerente (IP desativado sem domínio ativo) não tranca ninguém fora", async () => {
    await writeFile(path.join(dataDir, "panel-domain.json"), JSON.stringify({ domain: null, active: false, ipAccessDisabled: true }));
    const svc = new PanelDomainService(deps());
    await svc.init();
    expect(applied).toEqual([{ primary: IP_HOST, aliases: [] }]);
    await writeFile(path.join(dataDir, "panel-domain.json"), "{ lixo");
    applied = [];
    const outro = new PanelDomainService(deps());
    await outro.init();
    expect(applied).toEqual([{ primary: IP_HOST, aliases: [] }]);
  });

  it("modo túnel: sem endereço pelo IP; cadastrar é recusado com explicação (409 tunnel_mode)", async () => {
    const svc = new PanelDomainService(deps({ ipAddress: null, serverIp: null }));
    await svc.init();
    const s = await svc.status("127.0.0.1");
    expect(s.mode).toBe("tunnel");
    expect(s.addresses).toEqual([]);
    expect(s.openedVia).toBe("other");
    expect(applied).toEqual([]);
    await expect(svc.setDomain(DOMAIN, "admin")).rejects.toMatchObject({ statusCode: 409, code: "tunnel_mode" });
  });

  it("certificado que não dá para conferir agora não derruba a tela", async () => {
    const svc = new PanelDomainService(deps({ certificate: vi.fn(async () => Promise.reject(new Error("caddy fora"))) }));
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    const s = await svc.status(DOMAIN);
    expect(s.certificate).toBeNull();
    expect(s.disableIp.allowed).toBe(false);
  });

  it("facts (roteiro de primeiros passos): o que está feito e por onde a página foi aberta", async () => {
    const svc = new PanelDomainService(deps());
    await svc.init();
    await svc.setDomain(DOMAIN, "admin");
    await svc.verify("admin", IP_HOST);
    certState = "valid";
    expect(await svc.facts(DOMAIN)).toEqual({
      ipAddress: IP_HOST,
      domain: DOMAIN,
      active: true,
      certificateValid: true,
      ipAccessDisabled: false,
      openedViaDomain: true,
    });
    expect((await svc.facts(IP_HOST)).openedViaDomain).toBe(false);
  });
});
