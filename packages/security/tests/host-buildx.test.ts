/**
 * buildx do Docker da VPS (host-buildx.ts): leitura do estado, pacote certo por origem, allowlist estrita
 * e comandos manuais. Tudo puro (sem Docker).
 */
import { describe, expect, it } from "vitest";
import {
  BUILDX_PACKAGE_BY_ORIGIN,
  HOST_BUILDX_STATUS_COMMAND,
  buildBuildxInstallCommand,
  buildxManualCommands,
  isBuildxCommand,
  isFixableDockerOrigin,
  parseBuildxStatus,
} from "../src/host-buildx.js";
import { isAllowedHostCommand } from "../src/host-bridge.js";

const REMOTE_DIR = "/opt/paas-hardening";

describe("parseBuildxStatus", () => {
  it.each([
    ["buildx=1\norigin=docker-ce\n", { buildx: true, origin: "docker-ce" }],
    ["buildx=0\norigin=docker.io\n", { buildx: false, origin: "docker.io" }],
    ["buildx=0\r\norigin=snap\r\n", { buildx: false, origin: "snap" }],
    ["buildx=0\norigin=unknown\n", { buildx: false, origin: "unknown" }],
    ["buildx=1\norigin=podman\n", { buildx: true, origin: "unknown" }],
    ["", { buildx: null, origin: "unknown" }],
    ["lixo\n", { buildx: null, origin: "unknown" }],
  ])("lê %j", (saida, esperado) => {
    expect(parseBuildxStatus(saida)).toEqual(esperado);
  });
});

describe("instalação do plugin", () => {
  it("repositório oficial instala docker-buildx-plugin e confere com docker buildx version", () => {
    const cmd = buildBuildxInstallCommand("docker-ce");
    expect(cmd).toContain("apt-get install -y -qq docker-buildx-plugin");
    expect(cmd).toContain("NEEDRESTART_MODE=l");
    expect(cmd.endsWith("docker buildx version")).toBe(true);
    expect(cmd).not.toMatch(/docker-ce\b/);
  });

  it("pacote docker.io do Ubuntu instala docker-buildx", () => {
    expect(buildBuildxInstallCommand("docker.io")).toContain("apt-get install -y -qq docker-buildx &&");
  });

  it("só as origens da tabela são instaláveis", () => {
    expect(Object.keys(BUILDX_PACKAGE_BY_ORIGIN)).toEqual(["docker-ce", "docker.io"]);
    expect(isFixableDockerOrigin("docker-ce")).toBe(true);
    expect(isFixableDockerOrigin("snap")).toBe(false);
    expect(isFixableDockerOrigin("unknown")).toBe(false);
    expect(isFixableDockerOrigin("toString")).toBe(false);
  });
});

describe("allowlist", () => {
  it("aceita a leitura e as duas instalações exatas", () => {
    for (const cmd of [HOST_BUILDX_STATUS_COMMAND, buildBuildxInstallCommand("docker-ce"), buildBuildxInstallCommand("docker.io")]) {
      expect(isBuildxCommand(cmd)).toBe(true);
      expect(isAllowedHostCommand(cmd, REMOTE_DIR)).toBe(true);
    }
  });

  it("recusa variações: outro pacote, comando extra, espaço a mais", () => {
    const base = buildBuildxInstallCommand("docker-ce");
    for (const cmd of [
      base.replace("docker-buildx-plugin", "docker-buildx-plugin curl"),
      `${base}; rm -rf /`,
      ` ${base}`,
      base.replace("docker-buildx-plugin", "docker-ce"),
      "apt-get install -y docker-buildx-plugin",
      `${HOST_BUILDX_STATUS_COMMAND} ; id`,
    ]) {
      expect(isBuildxCommand(cmd)).toBe(false);
      expect(isAllowedHostCommand(cmd, REMOTE_DIR)).toBe(false);
    }
  });
});

describe("buildxManualCommands", () => {
  it("origem conhecida: o pacote certo e a conferência", () => {
    expect(buildxManualCommands("docker-ce")).toEqual(["sudo apt-get update", "sudo apt-get install -y docker-buildx-plugin", "docker buildx version"]);
    expect(buildxManualCommands("docker.io")[1]).toBe("sudo apt-get install -y docker-buildx");
  });
  it("snap: atualizar o snap", () => {
    expect(buildxManualCommands("snap")).toContain("sudo snap refresh docker");
  });
  it("origem desconhecida: mostra as duas alternativas", () => {
    const linhas = buildxManualCommands("unknown").join("\n");
    expect(linhas).toContain("docker-buildx-plugin");
    expect(linhas).toContain("install -y docker-buildx\n");
    expect(linhas.endsWith("docker buildx version")).toBe(true);
  });
});
