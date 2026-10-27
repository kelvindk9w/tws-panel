/**
 * Migração da rede dos projetos (A4): containers antigos com alias de nome do
 * painel (`tws-panel`, `paas-*`) recebem aviso no boot; o painel não derruba
 * container de projeto sozinho.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaddyManager } from "@paas/deploy";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-reserved-aliases-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const servico = () =>
  new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: null,
    port: 9000,
  } as unknown as ServerConfig);

describe("DeployService.warnReservedNetworkAliases", () => {
  it("avisa, em português, cada container com alias reservado e diz o que fazer", async () => {
    vi.spyOn(CaddyManager.prototype, "reservedAliases").mockResolvedValue([{ container: "atacante-web-1", alias: "tws-panel" }]);
    const warn = vi.fn();
    await servico().warnReservedNetworkAliases({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const texto = String(warn.mock.calls[0]![0]);
    expect(texto).toContain("atacante-web-1");
    expect(texto).toContain("tws-panel");
    expect(texto).toMatch(/docker network disconnect paas-net atacante-web-1/);
  });

  it("nada a avisar: silêncio", async () => {
    vi.spyOn(CaddyManager.prototype, "reservedAliases").mockResolvedValue([]);
    const warn = vi.fn();
    await servico().warnReservedNetworkAliases({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falha ao olhar a rede nunca derruba o boot", async () => {
    vi.spyOn(CaddyManager.prototype, "reservedAliases").mockRejectedValue(new Error("docker ocupado"));
    const warn = vi.fn();
    await expect(servico().warnReservedNetworkAliases({ warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("docker ocupado");
  });
});
