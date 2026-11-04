/**
 * ansi.test.ts — sanitização central de ANSI na saída dos checks.
 *
 * Regressão do bug real do check docker.sock-mounted: via PTY (visão dupla),
 * o `grep` coloriza a saída e os códigos de cor (ESC[01;31m…ESC[mESC[K)
 * chegavam crus ao `detail` exibido como texto na UI.
 */
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/ansi.js";
import { runSecurityScan } from "../src/scanner.js";
import { SECURITY_CHECKS } from "../src/checks.js";
import type { ExecResult, TargetRunner } from "../src/runner.js";

describe("stripAnsi", () => {
  it("remove cores e erase-line do grep colorido (caso real do docker.sock-mounted)", () => {
    const dirty = "\x1b[01;31m\x1b[K/paas-web \x1b[m\x1b[K/var/run/docker.sock";
    expect(stripAnsi(dirty)).toBe("/paas-web /var/run/docker.sock");
  });

  it("remove reset, bold e sequências de cursor", () => {
    expect(stripAnsi("\x1b[0m\x1b[1mtexto\x1b[2J\x1b[H")).toBe("texto");
  });

  it("não altera texto limpo", () => {
    expect(stripAnsi("UFW ativo\nDefault: deny (incoming)")).toBe("UFW ativo\nDefault: deny (incoming)");
  });
});

describe("runSecurityScan — sanitização ANSI no detail", () => {
  it("nenhum detail do relatório contém sequências de escape, mesmo com saída colorida", async () => {
    const sockCheck = SECURITY_CHECKS.find((c) => c.id === "docker.sock-mounted");
    const runner: TargetRunner = {
      label: "container:fake",
      profile: "container",
      ensureReady: () => Promise.resolve(),
      exec: (cmd: string): Promise<ExecResult> => {
        if (cmd.startsWith("command -v lynis")) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
        // o check do docker.sock devolve saída colorida pelo grep (PTY)
        if (cmd === sockCheck?.command) {
          return Promise.resolve({
            code: 0,
            stdout: "\x1b[01;31m\x1b[K/paas-web \x1b[m\x1b[K/var/run/docker.sock\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      execStream: () => Promise.resolve(0),
      uploadDir: () => Promise.resolve(),
    };

    const report = await runSecurityScan(runner);
    const sock = report.checks.find((c) => c.id === "docker.sock-mounted");
    expect(sock?.status).toBe("fail");
    expect(sock?.detail).toBe("/paas-web /var/run/docker.sock");
    // garantia central: NENHUM check vaza ANSI, não só o do socket
    for (const c of report.checks) {
      expect(c.detail ?? "").not.toMatch(/\x1b|\x9b/);
    }
  });
});
