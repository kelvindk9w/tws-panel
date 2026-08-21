/**
 * Testes do host bridge (host-bridge.ts): montagem do argv do helper nsenter,
 * construção/validação dos comandos de fase e a allowlist que protege o host.
 * Tudo aqui é puro (sem Docker) — a execução real é coberta por E2E manual.
 */
import { describe, expect, it } from "vitest";
import { SECURITY_PHASES } from "@paas/core";
import { SECURITY_CHECKS } from "../src/checks.js";
import { BASELINE_COMMANDS } from "../src/baseline.js";
import {
  HOST_HELPER_IMAGE_DEFAULT,
  LYNIS_CHECK_CMD,
  LYNIS_REPORT_CMD,
  LYNIS_RUN_CMD,
  buildNsenterArgv,
  buildNsenterUploadArgv,
  buildPhaseScriptCommand,
  fixedReadOnlyCommands,
  isAllowedHostCommand,
  parsePhaseScriptCommand,
} from "../src/host-bridge.js";

const REMOTE = "/opt/paas-hardening";
// chave ed25519 realista (formato, não é uma chave real em uso)
const KEY = `ssh-ed25519 ${"A".repeat(68)} operador@laptop`;

describe("buildNsenterArgv", () => {
  it("monta o helper descartável privilegiado entrando nos namespaces do PID 1", () => {
    const argv = buildNsenterArgv("alpine:3", "ufw status", "paas-host-exec-abcd");
    expect(argv).toEqual([
      "run", "--rm", "--name", "paas-host-exec-abcd",
      "--privileged", "--pid=host",
      "alpine:3",
      "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
      "bash", "-c", "ufw status",
    ]);
  });

  it("nome do helper é opcional", () => {
    const argv = buildNsenterArgv("alpine:3", "hostname");
    expect(argv).not.toContain("--name");
  });
});

describe("buildNsenterUploadArgv", () => {
  it("usa apenas o namespace de mount e extrai tar do stdin", () => {
    const argv = buildNsenterUploadArgv("alpine:3", REMOTE);
    expect(argv).toContain("-i");
    const shell = argv[argv.length - 1] ?? "";
    expect(shell).toBe(`mkdir -p '${REMOTE}' && tar -xf - -C '${REMOTE}'`);
    // sem -n/-p: upload só precisa do mount namespace
    const nsenterArgs = argv.slice(argv.indexOf("nsenter"));
    expect(nsenterArgs).not.toContain("-n");
    expect(nsenterArgs).not.toContain("-p");
  });

  it("rejeita remoteDir inválido", () => {
    expect(() => buildNsenterUploadArgv("alpine:3", "caminho relativo")).toThrow();
    expect(() => buildNsenterUploadArgv("alpine:3", "/tmp/x'; rm -rf /;'")).toThrow();
  });

  it("aceita nome de helper opcional", () => {
    const argv = buildNsenterUploadArgv("alpine:3", REMOTE, "paas-host-upload-1");
    expect(argv).toContain("--name");
    expect(argv).toContain("paas-host-upload-1");
  });
});

describe("buildPhaseScriptCommand", () => {
  it("monta comando simples de fase", () => {
    expect(buildPhaseScriptCommand({ remoteDir: REMOTE, script: "00-update.sh" })).toBe(
      "bash '/opt/paas-hardening/00-update.sh'",
    );
  });

  it("monta dry-run com janela de rollback", () => {
    expect(
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "03-firewall.sh", dryRun: true, rollbackDelaySec: 300 }),
    ).toBe("PAAS_ROLLBACK_DELAY=300 bash '/opt/paas-hardening/03-firewall.sh' --dry-run");
  });

  it("monta rollback e confirm", () => {
    expect(buildPhaseScriptCommand({ remoteDir: REMOTE, script: "02-ssh.sh", rollback: true })).toBe(
      "bash '/opt/paas-hardening/02-ssh.sh' --rollback",
    );
    expect(buildPhaseScriptCommand({ remoteDir: REMOTE, script: "02-ssh.sh", confirm: true })).toBe(
      "bash '/opt/paas-hardening/02-ssh.sh' --confirm",
    );
  });

  it("monta fase 01 com usuário e chave pública", () => {
    expect(
      buildPhaseScriptCommand({
        remoteDir: REMOTE,
        script: "01-user.sh",
        sshUser: "deploy",
        sshPublicKey: KEY,
        rollbackDelaySec: 300,
      }),
    ).toBe(`PAAS_ROLLBACK_DELAY=300 bash '/opt/paas-hardening/01-user.sh' --user deploy --pubkey '${KEY}'`);
  });

  it("rejeita script fora das fases conhecidas", () => {
    expect(() => buildPhaseScriptCommand({ remoteDir: REMOTE, script: "evil.sh" })).toThrow(/allowlist/);
    expect(() => buildPhaseScriptCommand({ remoteDir: REMOTE, script: "../../../etc/passwd" })).toThrow();
  });

  it("rejeita remoteDir inválido", () => {
    expect(() => buildPhaseScriptCommand({ remoteDir: "opt/x", script: "00-update.sh" })).toThrow();
  });

  it("rejeita modos mutuamente exclusivos combinados", () => {
    expect(() => buildPhaseScriptCommand({ remoteDir: REMOTE, script: "00-update.sh", dryRun: true, rollback: true })).toThrow();
    expect(() => buildPhaseScriptCommand({ remoteDir: REMOTE, script: "00-update.sh", rollback: true, confirm: true })).toThrow();
  });

  it("rejeita rollbackDelaySec fora do intervalo", () => {
    for (const bad of [0, -5, 1.5, 100_000]) {
      expect(() => buildPhaseScriptCommand({ remoteDir: REMOTE, script: "00-update.sh", rollbackDelaySec: bad })).toThrow();
    }
  });

  it("rejeita usuário/chave inválidos (defesa em profundidade)", () => {
    expect(() =>
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "01-user.sh", sshUser: "root" }),
    ).toThrow();
    expect(() =>
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "01-user.sh", sshUser: "a'; rm -rf /;'" }),
    ).toThrow();
    expect(() =>
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "01-user.sh", sshPublicKey: "ssh-ed25519 CURTA" }),
    ).toThrow();
    expect(() =>
      buildPhaseScriptCommand({
        remoteDir: REMOTE,
        script: "01-user.sh",
        sshPublicKey: `ssh-ed25519 ${"A".repeat(68)}' ; rm -rf / '`,
      }),
    ).toThrow();
  });
});

describe("fixedReadOnlyCommands", () => {
  it("contém todos os checks, comandos do baseline e do Lynis", () => {
    const fixed = fixedReadOnlyCommands();
    for (const c of SECURITY_CHECKS) expect(fixed.has(c.command), c.id).toBe(true);
    for (const c of BASELINE_COMMANDS) expect(fixed.has(c)).toBe(true);
    for (const c of [LYNIS_CHECK_CMD, LYNIS_RUN_CMD, LYNIS_REPORT_CMD]) expect(fixed.has(c)).toBe(true);
  });
});

describe("isAllowedHostCommand", () => {
  it("permite todos os comandos fixos somente-leitura", () => {
    for (const cmd of fixedReadOnlyCommands()) {
      expect(isAllowedHostCommand(cmd, REMOTE), cmd.slice(0, 60)).toBe(true);
    }
  });

  it("permite invocações de fase construídas pelo builder (roundtrip)", () => {
    const samples = [
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "00-update.sh" }),
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "01-user.sh", sshUser: "deploy", sshPublicKey: KEY, rollbackDelaySec: 300 }),
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "02-ssh.sh", confirm: true }),
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "03-firewall.sh", rollback: true }),
      buildPhaseScriptCommand({ remoteDir: REMOTE, script: "06-audit.sh", dryRun: true, rollbackDelaySec: 300 }),
    ];
    for (const cmd of samples) expect(isAllowedHostCommand(cmd, REMOTE), cmd).toBe(true);
  });

  it("permite todas as fases conhecidas", () => {
    for (const p of SECURITY_PHASES) {
      expect(isAllowedHostCommand(`bash '${REMOTE}/${p.script}'`, REMOTE)).toBe(true);
    }
  });

  it("NEGA comandos arbitrários e tentativas de injeção", () => {
    const denied = [
      "rm -rf /",
      "bash -c 'rm -rf /'",
      `bash '${REMOTE}/00-update.sh'; rm -rf /`,
      `bash '${REMOTE}/00-update.sh' && cat /etc/shadow`,
      `bash '${REMOTE}/00-update.sh' | tee /tmp/x`,
      `bash '${REMOTE}/99-evil.sh'`,
      `bash '${REMOTE}/lib.sh'`,
      `bash '/etc/00-update.sh'`,
      `bash '${REMOTE}/00-update.sh' --foo`,
      `bash '${REMOTE}/01-user.sh' --user root`,
      `bash '${REMOTE}/01-user.sh' --user deploy --pubkey 'não-é-chave'`,
      `bash '${REMOTE}/01-user.sh' --pubkey`,
      `bash '${REMOTE}/00-update.sh' --dry-run --dry-run2`,
      "PAAS_ROLLBACK_DELAY=abc bash '/opt/paas-hardening/00-update.sh'",
      "",
    ];
    for (const cmd of denied) expect(isAllowedHostCommand(cmd, REMOTE), cmd).toBe(false);
  });

  it("nega tudo quando o remoteDir é inválido", () => {
    expect(isAllowedHostCommand(`bash '${REMOTE}/00-update.sh'`, "dir relativo")).toBe(false);
  });
});

describe("parsePhaseScriptCommand", () => {
  it("extrai script e args de comando bem formado", () => {
    const parsed = parsePhaseScriptCommand(
      `PAAS_ROLLBACK_DELAY=300 bash '${REMOTE}/01-user.sh' --user deploy --pubkey '${KEY}'`,
      REMOTE,
    );
    expect(parsed?.script).toBe("01-user.sh");
    expect(parsed?.args).toContain("--user deploy");
  });

  it("retorna null para comando que não é invocação de fase", () => {
    expect(parsePhaseScriptCommand("ls -la /", REMOTE)).toBeNull();
  });

  it("rejeita --user sem valor e --pubkey sem aspas/formato", () => {
    expect(parsePhaseScriptCommand(`bash '${REMOTE}/01-user.sh' --user`, REMOTE)).toBeNull();
    expect(parsePhaseScriptCommand(`bash '${REMOTE}/01-user.sh' --pubkey ssh-ed25519`, REMOTE)).toBeNull();
    // chave válida mas sem aspas: tokenizer divide nos espaços → rejeitado
    expect(parsePhaseScriptCommand(`bash '${REMOTE}/01-user.sh' --pubkey ${KEY}`, REMOTE)).toBeNull();
  });
});

describe("constantes do helper", () => {
  it("imagem padrão é alpine:3", () => {
    expect(HOST_HELPER_IMAGE_DEFAULT).toBe("alpine:3");
  });
});
