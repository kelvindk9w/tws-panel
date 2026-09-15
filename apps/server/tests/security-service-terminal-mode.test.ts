/**
 * security-service-terminal-mode.test.ts — a SecurityService monta o runner
 * conforme o modo escolhido na instalação:
 *  - legado (sem PAAS_TERMINAL_USER) e root explícito: tudo no terminal, sem sudo;
 *  - senha: tudo no terminal com sudo; falha do sudo derruba a varredura
 *    inteira com mensagem (nunca vira relatório com checks "unknown");
 *  - segundo-plano: host bridge (NsenterHostRunner, auditado) + espelho que
 *    não escreve no terminal do usuário.
 * O `docker` do host bridge é simulado (child_process mockado) — nenhum
 * container real é criado.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NsenterHostRunner, SECURITY_CHECKS } from "@paas/security";
import type { ServerConfig } from "../src/config.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { SecurityService } from "../src/services/security-service.js";
import { BackgroundMirrorRunner, TerminalRelayRunner } from "../src/services/terminal-runner.js";
import { SudoElevationError, TerminalService } from "../src/services/terminal-service.js";

const { execFileCalls } = vi.hoisted(() => ({ execFileCalls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  const execFile = (file: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push([file, ...args]);
    const inspect = args[0] === "image";
    cb(null, { stdout: inspect ? "[]" : "Status: active\n", stderr: "" });
  };
  return { ...mod, execFile };
});

/** PTY que responde sozinho: sudo -v ok; comando elevado → senha errada 3x. */
class ScriptedPty implements RemotePty {
  readonly inputs: string[] = [];
  readonly stream: Duplex;
  constructor() {
    this.stream = new Duplex({
      write: (chunk, _enc, cb) => {
        const line = Buffer.from(chunk).toString("utf8");
        this.inputs.push(line);
        const nonce = /PAAS_EXIT_([0-9a-f]+):/.exec(line)?.[1];
        if (nonce) {
          setImmediate(() => {
            if (line.includes(" -v;")) this.stream.push(`:::PAAS_EXIT_${nonce}:0\r\n`);
            else
              this.stream.push(
                `[sudo] senha para kelvin: \r\nsudo: 3 incorrect password attempts\r\n:::PAAS_EXIT_${nonce}:1\r\n`,
              );
          });
        }
        cb();
      },
      read: () => undefined,
    });
  }
  resize(): void {}
  async kill(): Promise<void> {
    this.stream.push(null);
  }
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-sec-mode-"));
  execFileCalls.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function build(over: Partial<ServerConfig>) {
  const config = {
    dataDir: dir,
    securityTarget: "host",
    securityTargetContainer: "paas-target-test",
    hardeningScriptsDir: "/tmp/nao-existe",
    hostHelperImage: "alpine:3",
    hostRepoDir: "/opt/tws-panel",
    terminalUser: null,
    terminalRootMode: null,
    ...over,
  } as ServerConfig;
  const ptys: ScriptedPty[] = [];
  const terminal = new TerminalService({
    openPty: () => {
      const pty = new ScriptedPty();
      ptys.push(pty);
      return Promise.resolve(pty);
    },
    watchSudoPrompt: config.terminalRootMode === "senha",
  });
  const audits: Array<{ action: string; detail: string }> = [];
  const service = new SecurityService(config, {
    terminal,
    audit: (action, detail) => audits.push({ action, detail }),
  });
  const runner = (service as unknown as { runner: unknown }).runner;
  return { service, terminal, ptys, audits, runner };
}

describe("SecurityService — runner por modo do terminal", () => {
  it("legado (sem PAAS_TERMINAL_USER): terminal sem sudo, como sempre", () => {
    const { runner } = build({});
    expect(runner).toBeInstanceOf(TerminalRelayRunner);
    expect((runner as unknown as { elevate: boolean }).elevate).toBe(false);
  });

  it("root explícito: igual ao legado", () => {
    const { runner } = build({ terminalUser: "root" });
    expect(runner).toBeInstanceOf(TerminalRelayRunner);
    expect((runner as unknown as { elevate: boolean }).elevate).toBe(false);
  });

  it("alvo container (dev) com usuário configurado: usuário/modo não se aplicam", () => {
    const { runner } = build({ securityTarget: "container", terminalUser: "kelvin", terminalRootMode: "senha" });
    expect(runner).toBeInstanceOf(TerminalRelayRunner);
    expect((runner as unknown as { elevate: boolean }).elevate).toBe(false);
  });

  it("senha: terminal com sudo", () => {
    const { runner } = build({ terminalUser: "kelvin", terminalRootMode: "senha" });
    expect(runner).toBeInstanceOf(TerminalRelayRunner);
    expect((runner as unknown as { elevate: boolean }).elevate).toBe(true);
  });

  it("segundo-plano: host bridge auditado + espelho, sem digitar no terminal do usuário", async () => {
    const { runner, terminal, ptys, audits } = build({ terminalUser: "kelvin", terminalRootMode: "segundo-plano" });
    expect(runner).toBeInstanceOf(BackgroundMirrorRunner);
    expect((runner as unknown as { base: unknown }).base).toBeInstanceOf(NsenterHostRunner);
    const view: string[] = [];
    terminal.onOutput((c) => view.push(c));

    const cmd = SECURITY_CHECKS[0]!.command; // comando fixo da allowlist
    const result = await (runner as BackgroundMirrorRunner).exec(cmd);
    expect(result.stdout).toBe("Status: active\n");
    // executado pelo helper nsenter (host bridge), com o comando como argumento do bash -c
    expect(execFileCalls.at(-1)).toEqual(expect.arrayContaining(["docker", "run", "--privileged", cmd]));
    expect(audits).toEqual([{ action: "hardening.host-exec", detail: `host-exec: ${cmd}`.slice(0, 401) }]);
    expect(view.join("")).toContain("[segundo plano]");
    expect(view.join("")).toContain("Status: active");
    expect(ptys).toHaveLength(0); // terminal do usuário intocado
  });
});

describe("SecurityService.scan — modo senha", () => {
  it("falha do sudo durante a varredura derruba o scan com a mensagem (sem relatório gravado)", async () => {
    const { service, ptys } = build({ terminalUser: "kelvin", terminalRootMode: "senha" });
    const err = await service.scan(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SudoElevationError);
    expect((err as Error).message).toMatch(/recusou a senha 3 vezes/);
    // só o sudo -v e UM comando elevado foram digitados: a trava impediu os outros
    const typed = ptys[0]!.inputs.join("");
    expect(typed.match(/ -v;/g)).toHaveLength(1);
    expect(typed.match(/bash -c/g)).toHaveLength(1);
    expect(await readdir(dir)).not.toContain("security-last-scan.json");
  });
});
