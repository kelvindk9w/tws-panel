/**
 * scanner.test.ts — telemetria de timing por check (onCheckTiming):
 * introduzida na investigação da regressão de scan em VPS (2.1s → 133.4s
 * com um check travado ~120s). O callback recebe SOMENTE id + duração —
 * nunca saída/conteúdo do comando.
 */
import { describe, expect, it } from "vitest";
import { runSecurityScan } from "../src/scanner.js";
import { SECURITY_CHECKS } from "../src/checks.js";
import { partitionChecksForProfile } from "../src/profiles.js";
import type { ExecResult, TargetRunner } from "../src/runner.js";

/** Runner falso: todo comando retorna rápido, Lynis ausente. */
function fakeRunner(execImpl?: (cmd: string) => Promise<ExecResult>): TargetRunner {
  return {
    label: "container:fake",
    profile: "container",
    ensureReady: () => Promise.resolve(),
    exec:
      execImpl ??
      ((cmd: string) => {
        // Lynis ausente → scan usa o índice interno e termina rápido
        const code = cmd.startsWith("command -v lynis") ? 1 : 0;
        return Promise.resolve({ code, stdout: "", stderr: "" });
      }),
    execStream: () => Promise.resolve(0),
    uploadDir: () => Promise.resolve(),
  };
}

describe("runSecurityScan — timing por check", () => {
  it("chama onCheckTiming uma vez por check aplicável, com id e duração válidos", async () => {
    const timings: Array<{ id: string; ms: number }> = [];
    const report = await runSecurityScan(fakeRunner(), {
      onCheckTiming: (id, ms) => timings.push({ id, ms }),
    });

    const applicable = partitionChecksForProfile(SECURITY_CHECKS, "container").run;
    // um timing por check executado, na mesma ordem do relatório
    expect(timings.map((t) => t.id)).toEqual(report.checks.map((c) => c.id));
    expect(timings).toHaveLength(applicable.length);
    for (const t of timings) {
      expect(t.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(t.ms)).toBe(true);
    }
  });

  it("o timing reflete a duração real de um check lento (≥ o atraso injetado)", async () => {
    const slowCheckId = "update.pending-packages";
    const runner = fakeRunner((cmd: string) => {
      if (cmd.startsWith("command -v lynis")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "" });
      }
      const isSlow = cmd === SECURITY_CHECKS.find((c) => c.id === slowCheckId)?.command;
      return new Promise<ExecResult>((resolve) =>
        setTimeout(() => resolve({ code: 0, stdout: "0\n", stderr: "" }), isSlow ? 60 : 0),
      );
    });
    const timings = new Map<string, number>();
    await runSecurityScan(runner, {
      onCheckTiming: (id, ms) => timings.set(id, ms),
    });

    expect(timings.get(slowCheckId)).toBeGreaterThanOrEqual(50);
    // checks instantâneos ficam bem abaixo do check lento
    expect(timings.get("user.only-root-uid0") ?? 999).toBeLessThan(50);
  });

  it("sem onCheckTiming o scan funciona normalmente (opção é opcional)", async () => {
    const report = await runSecurityScan(fakeRunner());
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.hardeningIndexSource).toBe("internal");
  });
});

/**
 * nonRootSudoUsers — o scan descobre no alvo os nomes dos usuários não-root
 * com sudo (cada instalação tem o seu, escolhido pelo operador no README) e
 * os expõe no relatório para a UI não precisar pedir que sejam digitados.
 */
describe("runSecurityScan — nonRootSudoUsers", () => {
  const SUDO_CMD = SECURITY_CHECKS.find((c) => c.id === "user.non-root-sudo")?.command ?? "";

  /** Runner que responde ao check de sudo com `stdout` e o resto vazio. */
  function runnerWithSudoOutput(stdout: string): TargetRunner {
    return fakeRunner((cmd: string) => {
      if (cmd.startsWith("command -v lynis")) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
      if (cmd === SUDO_CMD) return Promise.resolve({ code: 0, stdout, stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
  }

  it("um único usuário não-root com sudo: nome detectado", async () => {
    const report = await runSecurityScan(runnerWithSudoOutput("sudo-user deploy 1000\n"));
    expect(report.nonRootSudoUsers).toEqual(["deploy"]);
    expect(report.checks.find((c) => c.id === "user.non-root-sudo")?.status).toBe("pass");
  });

  it("vários usuários: todos detectados, na ordem da saída", async () => {
    const report = await runSecurityScan(
      runnerWithSudoOutput("sudo-user deploy 1000\nsudo-user kelvin 1001\n"),
    );
    expect(report.nonRootSudoUsers).toEqual(["deploy", "kelvin"]);
  });

  it("nenhum usuário não-root com sudo: lista vazia e check falhando", async () => {
    const report = await runSecurityScan(runnerWithSudoOutput(""));
    expect(report.nonRootSudoUsers).toEqual([]);
    expect(report.checks.find((c) => c.id === "user.non-root-sudo")?.status).toBe("fail");
  });

  it("saída malformada: lista vazia, sem exceção", async () => {
    const report = await runSecurityScan(runnerWithSudoOutput("getent: not found\n?????\n"));
    expect(report.nonRootSudoUsers).toEqual([]);
  });

  it("nome inválido na saída é descartado; o válido permanece", async () => {
    const report = await runSecurityScan(
      runnerWithSudoOutput("sudo-user Bad;Name 1000\nsudo-user deploy 1000\n"),
    );
    expect(report.nonRootSudoUsers).toEqual(["deploy"]);
  });
});
