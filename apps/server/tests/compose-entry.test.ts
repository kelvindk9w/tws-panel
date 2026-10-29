/**
 * Entrada HTTP do compose (serviço e porta que recebem o tráfego do painel):
 * ao alterar, o serviço tem de existir no compose detectado e não pode ser um
 * que usa a rede de outro (`network_mode: service:X`) — esse não entra na
 * rede do painel; a entrada é o X. Estrutura do caso real (vitrine): o caddy
 * atende dentro do ledger, por isso a entrada é ledger:80.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeServiceInfo } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-entry-"));
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never },
  );
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function service(name: string, extra: Partial<ComposeServiceInfo> = {}): ComposeServiceInfo {
  return {
    name,
    image: null,
    build: null,
    publishedPorts: [],
    internalPorts: [],
    networkModeService: null,
    dependsOn: [],
    healthcheck: null,
    ...extra,
  };
}

async function composeProject(services?: ComposeServiceInfo[], name = "loja") {
  const p = await svc.createProject({ name, ingestMode: "git", source: `https://github.com/k/${name}`, branch: "main", domain: `${name}.localhost` });
  const proj = (await svc.getProject(p.id))!;
  proj.detection = {
    type: "compose",
    composeFile: "compose.yaml",
    outputDir: null,
    packageManager: null,
    buildCommand: null,
    proxyService: "ledger",
    proxyPort: 80,
    warnings: [],
    details: [],
    ...(services ? { services } : {}),
  };
  return p;
}

const VITRINE = [
  service("db", { image: "postgres:18-alpine" }),
  service("ledger", { build: { context: ".", dockerfile: "Dockerfile" } }),
  service("caddy", { image: "caddy:2-alpine", networkModeService: "ledger" }),
];

describe("alterar a entrada HTTP do compose", () => {
  it("aceita um serviço que existe, com a porta", async () => {
    const p = await composeProject(VITRINE);
    const updated = await svc.updateProject(p.id, { proxyService: "db", proxyPort: 5432 });
    expect(updated.proxyService).toBe("db");
    expect(updated.proxyPort).toBe(5432);
  });

  it("recusa serviço que não existe no compose, listando os que existem", async () => {
    const p = await composeProject(VITRINE);
    await expect(svc.updateProject(p.id, { proxyService: "site" })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_proxy_service",
      message: expect.stringContaining("db, ledger, caddy"),
    });
  });

  it("recusa serviço que usa a rede de outro e aponta o certo", async () => {
    const p = await composeProject(VITRINE);
    await expect(svc.updateProject(p.id, { proxyService: "caddy" })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_proxy_service",
      message: expect.stringMatching(/rede do "ledger".*escolha "ledger"/),
    });
  });

  it("voltar ao automático (null) e detecção antiga sem lista continuam valendo", async () => {
    const p = await composeProject(VITRINE);
    expect((await svc.updateProject(p.id, { proxyService: null, proxyPort: null })).proxyService).toBeNull();
    const antigo = await composeProject(undefined, "antigo");
    expect((await svc.updateProject(antigo.id, { proxyService: "qualquer" })).proxyService).toBe("qualquer");
  });
});
