/**
 * monitor-service-host-bridge.test.ts — alvo real do monitoramento recorrente.
 *
 * Bug real: no perfil "host" o MonitorService usava `HostRunner`, que roda
 * `bash -c` LOCALMENTE — dentro do container do próprio painel. A linha de
 * base e os scans recorrentes descreviam o container, não a VPS: uma porta
 * nova, um pacote novo ou um sshd_config alterado na VPS nunca gerava alerta.
 * Corrigido para usar o host bridge (`NsenterHostRunner`), com a imagem
 * auxiliar da configuração e auditoria de cada comando executado no host —
 * o mesmo mecanismo da SecurityService, SEM passar pelo terminal ao vivo.
 *
 * Também cobre a migração da linha de base já gravada: uma linha de base do
 * perfil host coletada pelo mecanismo antigo (sem a marca `collector:
 * "host-bridge"`) é recoletada sem gerar alertas, com registro em auditoria.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityBaseline } from "@paas/core";
import { AlertsService } from "../src/services/alerts-service.js";
import type { ServerConfig } from "../src/config.js";

const collectBaselineMock = vi.hoisted(() => vi.fn());
const nsenterCtor = vi.hoisted(() => vi.fn());
const hostRunnerCtor = vi.hoisted(() => vi.fn());
const containerCtor = vi.hoisted(() => vi.fn());

function fakeRunner(label: string, profile: "host" | "container") {
  return {
    label,
    profile,
    ensureReady: () => Promise.resolve(),
    exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    execStream: () => Promise.resolve(0),
    uploadDir: () => Promise.resolve(),
  };
}

vi.mock("@paas/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/security")>();
  // Vitest 4: mock instanciado com `new` precisa de `function` (não arrow).
  nsenterCtor.mockImplementation(function () {
    return fakeRunner("host", "host");
  });
  hostRunnerCtor.mockImplementation(function () {
    return fakeRunner("host", "host");
  });
  containerCtor.mockImplementation(function () {
    return fakeRunner("container:fake", "container");
  });
  return {
    ...actual,
    collectBaseline: collectBaselineMock,
    NsenterHostRunner: nsenterCtor,
    HostRunner: hostRunnerCtor,
    ContainerRunner: containerCtor,
  };
});

const { MonitorService } = await import("../src/services/monitor-service.js");

let dir: string;
let alerts: AlertsService;
let hostConfig: ServerConfig;
let containerConfig: ServerConfig;

function snapshot(target: string, overrides: Partial<SecurityBaseline> = {}): SecurityBaseline {
  return {
    id: `snap-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    target,
    packages: ["openssh-server=1:9.6"],
    ports: [{ proto: "tcp", port: 22, process: "sshd" }],
    files: { "/etc/ssh/sshd_config": "a".repeat(64) },
    ...overrides,
  };
}

async function writeBaselineFile(content: object): Promise<void> {
  await mkdir(path.join(dir, "security"), { recursive: true });
  await writeFile(path.join(dir, "security", "baseline.json"), JSON.stringify(content), "utf8");
}

async function readBaselineFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, "security", "baseline.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-monitor-host-"));
  alerts = new AlertsService(dir);
  const base = {
    dataDir: dir,
    securityTargetContainer: "paas-target-test",
    hostHelperImage: "registry.local/helper:9",
    monitorIntervalMs: 60_000,
  };
  hostConfig = { ...base, securityTarget: "host" } as ServerConfig;
  containerConfig = { ...base, securityTarget: "container" } as ServerConfig;
  collectBaselineMock.mockReset();
  nsenterCtor.mockClear();
  hostRunnerCtor.mockClear();
  containerCtor.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("perfil host — alcança a VPS real pelo host bridge", () => {
  it("usa o NsenterHostRunner com a imagem auxiliar da configuração, nunca o HostRunner local", async () => {
    collectBaselineMock.mockResolvedValue(snapshot("host"));
    const monitor = new MonitorService(hostConfig, alerts, () => undefined, { audit: () => undefined });

    expect(hostRunnerCtor).not.toHaveBeenCalled();
    expect(containerCtor).not.toHaveBeenCalled();
    expect(nsenterCtor).toHaveBeenCalledTimes(1);
    const opts = nsenterCtor.mock.calls[0]?.[0] as { image?: string };
    expect(opts.image).toBe("registry.local/helper:9");

    // a coleta recebe exatamente o runner do host bridge
    await monitor.createBaseline();
    expect(collectBaselineMock).toHaveBeenCalledWith(nsenterCtor.mock.results[0]?.value);
  });

  it("registra em auditoria cada comando executado no host", () => {
    const audit = vi.fn();
    new MonitorService(hostConfig, alerts, () => undefined, { audit });
    const opts = nsenterCtor.mock.calls[0]?.[0] as { onAudit?: (detail: string) => void };
    expect(typeof opts.onAudit).toBe("function");

    opts.onAudit?.("host-exec: ss -tulpnH");
    opts.onAudit?.("host-exec: dpkg-query -W");
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenNthCalledWith(1, "monitor.host-exec", "host-exec: ss -tulpnH");
    expect(audit).toHaveBeenNthCalledWith(2, "monitor.host-exec", "host-exec: dpkg-query -W");
  });

  it("avisa no log quando nenhum gancho de auditoria foi injetado", () => {
    const log = vi.fn();
    new MonitorService(hostConfig, alerts, log);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/auditoria/i));
  });

  it("a linha de base criada no perfil host fica marcada como coletada pelo host bridge", async () => {
    collectBaselineMock.mockResolvedValue(snapshot("host"));
    const monitor = new MonitorService(hostConfig, alerts, () => undefined, { audit: () => undefined });
    await monitor.createBaseline();
    expect((await readBaselineFile())["collector"]).toBe("host-bridge");
  });
});

describe("perfil container — nada muda", () => {
  it("usa o ContainerRunner com o container alvo e não toca no host bridge", async () => {
    collectBaselineMock.mockResolvedValue(snapshot("container:fake"));
    const monitor = new MonitorService(containerConfig, alerts, () => undefined);
    expect(containerCtor).toHaveBeenCalledWith({ name: "paas-target-test" });
    expect(nsenterCtor).not.toHaveBeenCalled();
    expect(hostRunnerCtor).not.toHaveBeenCalled();

    // linha de base sem marca continua sendo comparada normalmente
    await writeBaselineFile(snapshot("container:fake", { ports: [] }));
    const result = await monitor.runNow();
    expect(result.diff?.newPorts).toEqual([{ proto: "tcp", port: 22, process: "sshd" }]);
    expect(result.alertsCreated).toBeGreaterThan(0);
  });
});

describe("linha de base gravada pelo mecanismo antigo", () => {
  it("é recoletada pelo host bridge sem gerar alertas, com registro em auditoria e log", async () => {
    // baseline.json antigo: coletado DENTRO do container do painel (HostRunner),
    // com o mesmo rótulo "host" e sem a marca de origem.
    await writeBaselineFile(
      snapshot("host", {
        id: "antiga",
        packages: ["libc6=2.36"],
        ports: [{ proto: "tcp", port: 3000, process: "node" }],
        files: { "/etc/ssh/sshd_config": null },
      }),
    );
    const vps = snapshot("host", { id: "vps-real" });
    collectBaselineMock.mockResolvedValue(vps);
    const audit = vi.fn();
    const log = vi.fn();
    const monitor = new MonitorService(hostConfig, alerts, log, { audit });

    const result = await monitor.runNow();

    expect(result.alertsCreated).toBe(0);
    expect(result.diff).toBeNull();
    expect(result.note).toMatch(/linha de base/i);
    expect(result.baselineId).toBe("vps-real");
    expect((await alerts.list({})).total).toBe(0);

    const saved = await readBaselineFile();
    expect(saved["id"]).toBe("vps-real");
    expect(saved["collector"]).toBe("host-bridge");

    expect(audit).toHaveBeenCalledWith("monitor.baseline-recollected", expect.stringContaining("antiga"));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/linha de base/i));
  });

  it("uma linha de base do perfil container também é recoletada ao passar para o perfil host", async () => {
    await writeBaselineFile({ ...snapshot("container:paas-target-test", { ports: [] }), collector: "container" });
    collectBaselineMock.mockResolvedValue(snapshot("host"));
    const monitor = new MonitorService(hostConfig, alerts, () => undefined, { audit: () => undefined });
    const result = await monitor.runNow();
    expect(result.alertsCreated).toBe(0);
    expect((await readBaselineFile())["collector"]).toBe("host-bridge");
  });

  it("linha de base nova (do host bridge) é comparada normalmente e gera alertas", async () => {
    await writeBaselineFile({ ...snapshot("host", { id: "nova", ports: [] }), collector: "host-bridge" });
    collectBaselineMock.mockResolvedValue(snapshot("host", { id: "atual" }));
    const audit = vi.fn();
    const monitor = new MonitorService(hostConfig, alerts, () => undefined, { audit });

    const result = await monitor.runNow();

    expect(result.baselineId).toBe("nova");
    expect(result.diff?.newPorts).toEqual([{ proto: "tcp", port: 22, process: "sshd" }]);
    expect(result.alertsCreated).toBe(1);
    expect((await readBaselineFile())["id"]).toBe("nova"); // não substituída
    expect(audit).not.toHaveBeenCalledWith("monitor.baseline-recollected", expect.anything());
  });
});

describe("allowlist do host bridge", () => {
  it("todos os comandos da linha de base passam pela allowlist (sem relaxá-la)", async () => {
    const actual = await vi.importActual<typeof import("@paas/security")>("@paas/security");
    expect(actual.BASELINE_COMMANDS).toHaveLength(3);
    for (const cmd of actual.BASELINE_COMMANDS) {
      expect(actual.isAllowedHostCommand(cmd, "/opt/paas-hardening")).toBe(true);
    }
  });
});
