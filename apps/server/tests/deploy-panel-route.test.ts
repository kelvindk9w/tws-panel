/**
 * Acesso ao painel por HTTPS: com PAAS_PANEL_DOMAIN definido, o Caddy central
 * sobe JUNTO com o painel (não só no primeiro deploy) já com o site do painel
 * — sem isso, uma instalação nova ficaria sem acesso até alguém fazer deploy.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployEngine } from "@paas/deploy";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-panel-route-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function servico(panelDomain: string | null): DeployService {
  return new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain,
    port: 9000,
  } as unknown as ServerConfig);
}

describe("DeployService.ensurePanelRoute", () => {
  it("com domínio do painel: aplica o Caddyfile (que sempre inclui o site do painel)", async () => {
    const sync = vi.spyOn(DeployEngine.prototype, "syncCaddy").mockResolvedValue(undefined);
    const svc = servico("203-0-113-10.sslip.io");
    await expect(svc.ensurePanelRoute()).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(svc.panelSite).toEqual({ domain: "203-0-113-10.sslip.io", upstream: "tws-panel:9000" });
  });

  it("sem domínio (acesso por túnel): não sobe o Caddy à toa", async () => {
    const sync = vi.spyOn(DeployEngine.prototype, "syncCaddy").mockResolvedValue(undefined);
    const svc = servico(null);
    await expect(svc.ensurePanelRoute()).resolves.toBe(false);
    expect(sync).not.toHaveBeenCalled();
    expect(svc.panelSite).toBeNull();
  });
});

/**
 * No boot o Docker pode ainda estar ocupado (reboot da VPS, daemon subindo):
 * uma falha não pode deixar o painel sem endereço até alguém reiniciar tudo.
 */
describe("DeployService.startPanelRoute — tenta de novo no boot", () => {
  it("falhou: registra, espera e tenta de novo até conseguir", async () => {
    vi.useFakeTimers();
    try {
      const svc = servico("203-0-113-10.sslip.io");
      const ensure = vi
        .spyOn(svc, "ensurePanelRoute")
        .mockRejectedValueOnce(new Error("daemon ocupado"))
        .mockResolvedValueOnce(true);
      const log = { info: vi.fn(), warn: vi.fn() };
      svc.startPanelRoute(log, { attempts: 3, delayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/daemon ocupado/));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/https:\/\/203-0-113-10\.sslip\.io/));
    } finally {
      vi.useRealTimers();
    }
  });

  it("desiste depois do limite, dizendo o que fazer", async () => {
    vi.useFakeTimers();
    try {
      const svc = servico("203-0-113-10.sslip.io");
      const ensure = vi.spyOn(svc, "ensurePanelRoute").mockRejectedValue(new Error("sem docker"));
      const log = { info: vi.fn(), warn: vi.fn() };
      svc.startPanelRoute(log, { attempts: 2, delayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenLastCalledWith(expect.stringMatching(/desistindo.*reinicie o painel/i));
    } finally {
      vi.useRealTimers();
    }
  });

  it("acesso por túnel: não faz nada", async () => {
    const svc = servico(null);
    const ensure = vi.spyOn(svc, "ensurePanelRoute");
    svc.startPanelRoute({ info: vi.fn(), warn: vi.fn() });
    expect(ensure).not.toHaveBeenCalled();
  });
});
