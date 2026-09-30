/**
 * security-scan.test.ts — regressão da página Segurança travada ~2 min em
 * "Carregando…": o GET /api/security/scan SEM fresh usava um cache de 60s e,
 * vencido, disparava um scan completo (Lynis, ~115s) bloqueando a resposta.
 *
 * Comportamento garantido aqui:
 *  - sem fresh NUNCA executa varredura nova: devolve o último relatório
 *    (memória → disco) imediatamente;
 *  - com scan em andamento (fresh/agendador), devolve o último relatório +
 *    refreshing=true;
 *  - o relatório completo é persistido e servido após restart do painel;
 *  - sem relatório nenhum (primeiro uso), aí sim o scan executa.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityScanReport } from "@paas/core";
import { SecurityService } from "../src/services/security-service.js";
import type { ServerConfig } from "../src/config.js";

// runSecurityScan é mockado: o runner NUNCA deve ser acionado por GET sem
// fresh (assert via contagem de chamadas).
const { mockRunScan } = vi.hoisted(() => ({ mockRunScan: vi.fn() }));
vi.mock("@paas/security", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@paas/security")>();
  return { ...mod, runSecurityScan: mockRunScan };
});

const REPORT = (id: string, hardeningIndex = 75): SecurityScanReport => ({
  id,
  scannedAt: "2026-08-21T10:00:00.000Z",
  durationMs: 115_000,
  target: "host",
  hardeningIndex,
  hardeningIndexSource: "lynis",
  lynisAvailable: true,
  checks: [],
  summary: { total: 10, pass: 8, fail: 2, unknown: 0, critical: 0, warning: 2 },
  profile: "host",
  skippedChecks: [],
  profileNote: null,
});

describe("SecurityService.scan — GET sem fresh nunca dispara scan novo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-sec-scan-"));
    mockRunScan.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function service(): SecurityService {
    const config = {
      dataDir: dir,
      securityTarget: "container",
      securityTargetContainer: "paas-target-test",
      hardeningScriptsDir: "/tmp/nao-existe",
      hostHelperImage: "alpine:3",
      hostRepoDir: "/opt/tws-panel",
    } as ServerConfig;
    return new SecurityService(config);
  }

  it("com relatório em cache, sem fresh devolve o último SEM chamar o runner", async () => {
    mockRunScan.mockResolvedValue(REPORT("scan-1"));
    const svc = service();

    const fresh = await svc.scan(true);
    expect(fresh.report.id).toBe("scan-1");
    expect(mockRunScan).toHaveBeenCalledTimes(1);

    // Cache "vencido" (comportamento antigo dispararia scan novo aqui).
    const cached = await svc.scan(false);
    expect(cached).toEqual({ report: fresh.report, cached: true, refreshing: false });
    expect(mockRunScan).toHaveBeenCalledTimes(1); // runner NÃO foi chamado de novo
  });

  it("com scan em andamento, sem fresh devolve o último relatório + refreshing=true (sem bloquear)", async () => {
    mockRunScan.mockResolvedValueOnce(REPORT("scan-1"));
    const svc = service();
    await svc.scan(true); // semeia o último relatório

    // Scan fresco lento em andamento (simula os ~115s do Lynis).
    let resolveSlow!: (r: SecurityScanReport) => void;
    mockRunScan.mockImplementationOnce(
      () => new Promise<SecurityScanReport>((resolve) => (resolveSlow = resolve)),
    );
    const slowScan = svc.scan(true);

    const during = await svc.scan(false); // resolve imediatamente
    expect(during.report.id).toBe("scan-1");
    expect(during.cached).toBe(true);
    expect(during.refreshing).toBe(true);
    expect(mockRunScan).toHaveBeenCalledTimes(2); // só os dois fresh

    resolveSlow(REPORT("scan-2", 80));
    await slowScan;
    const after = await svc.scan(false);
    expect(after.report.id).toBe("scan-2");
    expect(after.refreshing).toBe(false);
  });

  it("após restart, devolve o relatório PERSISTIDO sem chamar o runner", async () => {
    mockRunScan.mockResolvedValue(REPORT("scan-1"));
    await service().scan(true); // instância antiga persiste em disco
    expect(mockRunScan).toHaveBeenCalledTimes(1);

    const cached = await service().scan(false); // instância "recém-iniciada"
    expect(cached.report.id).toBe("scan-1");
    expect(cached.cached).toBe(true);
    expect(mockRunScan).toHaveBeenCalledTimes(1);
  });

  it("sem relatório nenhum (primeiro uso), sem fresh executa o scan", async () => {
    mockRunScan.mockResolvedValue(REPORT("scan-1"));
    const result = await service().scan(false);
    expect(result.cached).toBe(false);
    expect(mockRunScan).toHaveBeenCalledTimes(1);
  });
});

/**
 * Modo manual (host): a fase 02 sem --user deixava o root entrar com chave e
 * não restringia quem entra por SSH — o passo a passo precisa ensinar o --user.
 */
/**
 * Acesso por HTTPS: o túnel SSH não é usado, e a fase 02 fecha também o
 * encaminhamento local (Lynis SSH-7408). O painel decide pelo próprio modo de
 * acesso (domínio HTTPS configurado) — o navegador não escolhe isso.
 */
describe("SecurityService — fase 02 conforme o modo de acesso", () => {
  async function withService(panelDomain: string | null, fn: (s: SecurityService) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-sec-access-"));
    try {
      const config = {
        dataDir: dir,
        securityTarget: "host",
        securityTargetContainer: "paas-target-test",
        hardeningScriptsDir: path.resolve(__dirname, "../../../scripts/hardening"),
        hostHelperImage: "alpine:3",
        hostRepoDir: "/opt/tws-panel",
        panelDomain,
      } as ServerConfig;
      await fn(new SecurityService(config));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("com HTTPS, a fase 02 vai com noTunnel; as outras não", async () => {
    await withService("203-0-113-10.sslip.io", async (s) => {
      const exec = (s as unknown as { executor: { startJob: (...a: unknown[]) => unknown } }).executor;
      const spy = vi.spyOn(exec, "startJob").mockResolvedValue({ id: "j" } as never);
      await s.apply("02", true, { sshUser: "kelvin" });
      expect(spy).toHaveBeenLastCalledWith("02", true, { sshUser: "kelvin", noTunnel: true });
      await s.apply("03", true);
      expect(spy).toHaveBeenLastCalledWith("03", true, undefined);
    });
  });

  it("no modo túnel, a fase 02 mantém o encaminhamento local", async () => {
    await withService(null, async (s) => {
      const exec = (s as unknown as { executor: { startJob: (...a: unknown[]) => unknown } }).executor;
      const spy = vi.spyOn(exec, "startJob").mockResolvedValue({ id: "j" } as never);
      await s.apply("02", true, { sshUser: "kelvin" });
      expect(spy).toHaveBeenLastCalledWith("02", true, { sshUser: "kelvin" });
    });
  });

  it("modo manual com HTTPS ensina o --no-tunnel", async () => {
    await withService("203-0-113-10.sslip.io", async (s) => {
      const res = await s.manualCommands("02");
      expect(res.commands[0]).toBe("sudo bash /opt/tws-panel/scripts/hardening/02-ssh.sh --user SEU_USUARIO --no-tunnel");
      expect(res.notes.join(" ")).toMatch(/--no-tunnel.*túnel/);
    });
  });
});

describe("SecurityService.manualCommands — fase 02 ensina o --user", () => {
  it("o comando da fase 02 leva --user e a nota explica o que ele faz", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-sec-manual-"));
    try {
      const config = {
        dataDir: dir,
        securityTarget: "host",
        securityTargetContainer: "paas-target-test",
        hardeningScriptsDir: path.resolve(__dirname, "../../../scripts/hardening"),
        hostHelperImage: "alpine:3",
        hostRepoDir: "/opt/tws-panel",
      } as ServerConfig;
      const res = await new SecurityService(config).manualCommands("02");
      expect(res.commands[0]).toBe("sudo bash /opt/tws-panel/scripts/hardening/02-ssh.sh --user SEU_USUARIO");
      expect(res.commands).toContain("sudo bash /opt/tws-panel/scripts/hardening/02-ssh.sh --confirm");
      expect(res.notes.join(" ")).toMatch(/root não entra por SSH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
