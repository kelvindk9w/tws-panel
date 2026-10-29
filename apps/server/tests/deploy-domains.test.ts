/**
 * deploy-domains.test.ts — vários domínios por projeto (Domínios do projeto).
 *
 * Validação real (30/09/2026): para testar loja.example.com era preciso
 * "editar" o domínio atual, perdendo o endereço automático. Agora o projeto
 * tem um domínio principal e quantos adicionais quiser: conectar, remover,
 * tornar principal. Publicado, a mudança vale na hora (Caddy recarregado).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;
let sync: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-domains-"));
  svc = new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: "203-0-113-10.sslip.io",
    port: 9000,
  } as unknown as ServerConfig);
  sync = vi.fn(async () => undefined);
  (svc as unknown as { engine: { syncCaddy: typeof sync } }).engine.syncCaddy = sync;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function projeto(domain = "catalog.203-0-113-10.sslip.io") {
  return svc.createProject({ name: "catalog", ingestMode: "git", source: "https://github.com/k/catalog", branch: "main", domain });
}

describe("domínios do projeto", () => {
  it("conectar um domínio adicional mantém o principal", async () => {
    const p = await projeto();
    const up = await svc.addDomain(p.id, "Loja.EXAMPLE.com");
    expect(up.domain).toBe("catalog.203-0-113-10.sslip.io");
    expect(up.aliases).toEqual(["loja.example.com"]);
  });

  it("recusa domínio inválido, repetido, de outro projeto ou o do próprio painel", async () => {
    const a = await projeto();
    const b = await svc.createProject({ name: "outro", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "outro.203-0-113-10.sslip.io" });
    await svc.addDomain(a.id, "loja.example.com");
    await expect(svc.addDomain(a.id, "nao é domínio")).rejects.toMatchObject({ code: "invalid_domain" });
    await expect(svc.addDomain(a.id, "loja.example.com")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.addDomain(b.id, "loja.example.com")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.addDomain(b.id, "203-0-113-10.sslip.io")).rejects.toMatchObject({ code: "domain_in_use" });
    // e criar/editar outro projeto também enxerga os adicionais
    await expect(svc.updateProject(b.id, { domain: "loja.example.com" })).rejects.toMatchObject({ code: "domain_in_use" });
  });

  it("tornar principal troca de lugar com o antigo, que vira adicional", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "loja.example.com");
    const up = await svc.setPrimaryDomain(p.id, "loja.example.com");
    expect(up.domain).toBe("loja.example.com");
    expect(up.aliases).toEqual(["catalog.203-0-113-10.sslip.io"]);
  });

  /**
   * Investigação (endereço temporário que "some"): conectar o domínio oficial NUNCA tira o
   * endereço automático (POST /domains só acrescenta; "Tornar principal" rebaixa o antigo a
   * adicional). Quem o descarta é o assistente de novo projeto ao escolher "Meu domínio", que
   * troca o principal por PATCH — o antigo sai da lista e nada o recoloca.
   */
  it("conectar e tornar principal o domínio oficial preservam o endereço automático; só o PATCH do principal o substitui", async () => {
    const auto = "catalog.203-0-113-10.sslip.io";
    const p = await projeto(auto);
    const comAlias = await svc.addDomain(p.id, "loja.example.com");
    expect([comAlias.domain, ...(comAlias.aliases ?? [])]).toEqual([auto, "loja.example.com"]);
    const prim = await svc.setPrimaryDomain(p.id, "loja.example.com");
    expect([prim.domain, ...(prim.aliases ?? [])]).toEqual(["loja.example.com", auto]);

    const q = await svc.createProject({ name: "outro", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "outro.203-0-113-10.sslip.io" });
    const trocado = await svc.updateProject(q.id, { domain: "site.example.com" });
    expect([trocado.domain, ...(trocado.aliases ?? [])]).toEqual(["site.example.com"]);
  });

  it("remover um adicional; o principal só sai se outro virar principal antes", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "loja.example.com");
    await expect(svc.removeDomain(p.id, "catalog.203-0-113-10.sslip.io")).rejects.toMatchObject({ code: "primary_domain" });
    const up = await svc.removeDomain(p.id, "loja.example.com");
    expect(up.aliases).toEqual([]);
  });

  /**
   * Pedido do dono do produto (01/10/2026): domínio conectado antes do primeiro
   * deploy precisa responder ("site em configuração", com HTTPS) para dar para
   * conferir o DNS. Então toda mudança recarrega o Caddy, publicado ou não.
   */
  it("cada mudança de domínio recarrega o Caddy na hora, mesmo antes do primeiro deploy", async () => {
    const p = await projeto();
    sync.mockClear();
    await svc.addDomain(p.id, "a.example.com");
    await svc.addDomain(p.id, "b.example.com");
    await svc.setPrimaryDomain(p.id, "b.example.com");
    await svc.removeDomain(p.id, "a.example.com");
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it("trocar o domínio principal na edição do projeto (o assistente faz isso) recarrega o Caddy", async () => {
    const p = await projeto();
    sync.mockClear();
    await svc.updateProject(p.id, { websocket: true });
    expect(sync).not.toHaveBeenCalled();
    await svc.updateProject(p.id, { domain: "loja.example.com" });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("criar o projeto já coloca o endereço dele no Caddy", async () => {
    await projeto();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("falha ao recarregar o Caddy não desfaz a mudança gravada", async () => {
    const p = await projeto();
    sync.mockRejectedValueOnce(new Error("caddy fora do ar"));
    const up = await svc.addDomain(p.id, "c.example.com");
    expect(up.aliases).toEqual(["c.example.com"]);
  });
});

describe("porta por domínio", () => {
  it("define e limpa a porta de um domínio; remover o domínio apaga a porta dele", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "pagamentos.example.com");
    let up = await svc.setDomainPort(p.id, "pagamentos.example.com", 8009);
    expect(up.domainPorts).toEqual({ "pagamentos.example.com": 8009 });
    up = await svc.setDomainPort(p.id, "pagamentos.example.com", null);
    expect(up.domainPorts).toEqual({});
    await svc.setDomainPort(p.id, "pagamentos.example.com", 8009);
    up = await svc.removeDomain(p.id, "pagamentos.example.com");
    expect(up.domainPorts).toEqual({});
  });

  it("porta inválida ou domínio de fora do projeto → recusa", async () => {
    const p = await projeto();
    await expect(svc.setDomainPort(p.id, "catalog.203-0-113-10.sslip.io", 70000)).rejects.toMatchObject({ code: "invalid_port" });
    await expect(svc.setDomainPort(p.id, "outro.com", 8009)).rejects.toMatchObject({ code: "domain_not_found" });
  });
});
