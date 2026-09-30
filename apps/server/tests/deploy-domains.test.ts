/**
 * deploy-domains.test.ts — vários domínios por projeto (Domínios do projeto).
 *
 * Validação real (30/09/2026): para testar devlink.tws.tec.br era preciso
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
  await rm(dataDir, { recursive: true, force: true });
});

async function projeto(domain = "devlink.203-0-113-10.sslip.io") {
  return svc.createProject({ name: "devLink", ingestMode: "git", source: "https://github.com/k/devLink", branch: "main", domain });
}

describe("domínios do projeto", () => {
  it("conectar um domínio adicional mantém o principal", async () => {
    const p = await projeto();
    const up = await svc.addDomain(p.id, "DevLink.TWS.tec.br");
    expect(up.domain).toBe("devlink.203-0-113-10.sslip.io");
    expect(up.aliases).toEqual(["devlink.tws.tec.br"]);
  });

  it("recusa domínio inválido, repetido, de outro projeto ou o do próprio painel", async () => {
    const a = await projeto();
    const b = await svc.createProject({ name: "outro", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "outro.203-0-113-10.sslip.io" });
    await svc.addDomain(a.id, "devlink.tws.tec.br");
    await expect(svc.addDomain(a.id, "nao é domínio")).rejects.toMatchObject({ code: "invalid_domain" });
    await expect(svc.addDomain(a.id, "devlink.tws.tec.br")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.addDomain(b.id, "devlink.tws.tec.br")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.addDomain(b.id, "203-0-113-10.sslip.io")).rejects.toMatchObject({ code: "domain_in_use" });
    // e criar/editar outro projeto também enxerga os adicionais
    await expect(svc.updateProject(b.id, { domain: "devlink.tws.tec.br" })).rejects.toMatchObject({ code: "domain_in_use" });
  });

  it("tornar principal troca de lugar com o antigo, que vira adicional", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "devlink.tws.tec.br");
    const up = await svc.setPrimaryDomain(p.id, "devlink.tws.tec.br");
    expect(up.domain).toBe("devlink.tws.tec.br");
    expect(up.aliases).toEqual(["devlink.203-0-113-10.sslip.io"]);
  });

  it("remover um adicional; o principal só sai se outro virar principal antes", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "devlink.tws.tec.br");
    await expect(svc.removeDomain(p.id, "devlink.203-0-113-10.sslip.io")).rejects.toMatchObject({ code: "primary_domain" });
    const up = await svc.removeDomain(p.id, "devlink.tws.tec.br");
    expect(up.aliases).toEqual([]);
  });

  it("projeto publicado: cada mudança recarrega o Caddy na hora; não publicado: só grava", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "a.tws.tec.br");
    expect(sync).not.toHaveBeenCalled();
    (await svc.getProject(p.id))!.lastDeployStatus = "success";
    await svc.addDomain(p.id, "b.tws.tec.br");
    await svc.setPrimaryDomain(p.id, "b.tws.tec.br");
    await svc.removeDomain(p.id, "a.tws.tec.br");
    expect(sync).toHaveBeenCalledTimes(3);
  });
});

describe("porta por domínio", () => {
  it("define e limpa a porta de um domínio; remover o domínio apaga a porta dele", async () => {
    const p = await projeto();
    await svc.addDomain(p.id, "carteira.tws.tec.br");
    let up = await svc.setDomainPort(p.id, "carteira.tws.tec.br", 8009);
    expect(up.domainPorts).toEqual({ "carteira.tws.tec.br": 8009 });
    up = await svc.setDomainPort(p.id, "carteira.tws.tec.br", null);
    expect(up.domainPorts).toEqual({});
    await svc.setDomainPort(p.id, "carteira.tws.tec.br", 8009);
    up = await svc.removeDomain(p.id, "carteira.tws.tec.br");
    expect(up.domainPorts).toEqual({});
  });

  it("porta inválida ou domínio de fora do projeto → recusa", async () => {
    const p = await projeto();
    await expect(svc.setDomainPort(p.id, "devlink.203-0-113-10.sslip.io", 70000)).rejects.toMatchObject({ code: "invalid_port" });
    await expect(svc.setDomainPort(p.id, "outro.com", 8009)).rejects.toMatchObject({ code: "domain_not_found" });
  });
});
