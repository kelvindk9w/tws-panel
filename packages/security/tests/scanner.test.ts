/**
 * scanner.test.ts — telemetria de timing por check (onCheckTiming):
 * introduzida na investigação da regressão de scan em VPS (2.1s → 133.4s
 * com um check travado ~120s). O callback recebe SOMENTE id + duração —
 * nunca saída/conteúdo do comando.
 */
import { describe, expect, it } from "vitest";
import { runSecurityScan } from "../src/scanner.js";
import {
  LYNIS_CHECK_CMD,
  LYNIS_INSTALL_CMD,
  LYNIS_MTIME_CMD,
  LYNIS_REPORT_CMD,
  LYNIS_RUN_CMD,
} from "../src/host-bridge.js";
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

  it("senha e chaves de cada usuário vão ao relatório (a tela da Fase 01 mostra o que vai acontecer)", async () => {
    const report = await runSecurityScan(runnerWithSudoOutput("sudo-user kelvin 1001 P 1\nsudo-user novo 1002 L 0\n"));
    expect(report.nonRootSudoUsers).toEqual(["kelvin", "novo"]);
    expect(report.nonRootSudoUserAccess).toEqual({
      kelvin: { hasPassword: true, keyCount: 1 },
      novo: { hasPassword: false, keyCount: 0 },
    });
  });

  it("saída antiga (sem senha/chaves): nada é afirmado sobre o acesso", async () => {
    const report = await runSecurityScan(runnerWithSudoOutput("sudo-user kelvin 1001\n"));
    expect(report.nonRootSudoUserAccess).toEqual({});
  });

  it("nome inválido na saída é descartado; o válido permanece", async () => {
    const report = await runSecurityScan(
      runnerWithSudoOutput("sudo-user Bad;Name 1000\nsudo-user deploy 1000\n"),
    );
    expect(report.nonRootSudoUsers).toEqual(["deploy"]);
  });
});

/**
 * Validação real: a nota do Lynis oscilou (86 → 79 → 86 → 80) e a tela
 * mostrava 86 enquanto o relatório mais recente no disco dizia 80. O
 * comando terminava em "|| true" e o painel lia /var/log/lynis-report.dat
 * sem conferir se ELA tinha sido gravada por esta execução — um Lynis
 * interrompido (ou recusado por já haver outro rodando) fazia o painel
 * apresentar a nota ANTIGA como a de agora.
 */
describe("runSecurityScan — nota do Lynis", () => {
  function hostRunner(opts: { installed: boolean; installWorks?: boolean; reportWritten: boolean; index?: number }) {
    const calls: string[] = [];
    let installed = opts.installed;
    let mtime = 1000;
    const runner: TargetRunner = {
      label: "host",
      profile: "host",
      ensureReady: () => Promise.resolve(),
      exec: (cmd: string) => {
        calls.push(cmd);
        const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" });
        if (cmd === LYNIS_INSTALL_CMD) {
          if (opts.installWorks !== false) installed = true;
          return ok();
        }
        if (cmd === LYNIS_CHECK_CMD) return Promise.resolve({ code: installed ? 0 : 1, stdout: "", stderr: "" });
        if (cmd === LYNIS_MTIME_CMD) return ok(`${mtime}\n`);
        if (cmd === LYNIS_RUN_CMD) {
          if (opts.reportWritten) mtime += 60;
          return ok();
        }
        if (cmd === LYNIS_REPORT_CMD) return ok(`hardening_index=${opts.index ?? 80}\n`);
        return ok();
      },
      execStream: () => Promise.resolve(0),
      uploadDir: () => Promise.resolve(),
    };
    return { runner, calls };
  }

  it("relatório gravado por esta execução: usa a nota do Lynis", async () => {
    const { runner } = hostRunner({ installed: true, reportWritten: true, index: 80 });
    const report = await runSecurityScan(runner);
    expect(report.hardeningIndexSource).toBe("lynis");
    expect(report.hardeningIndex).toBe(80);
  });

  it("relatório NÃO foi regravado (Lynis interrompido/recusado): nunca apresenta a nota antiga como atual", async () => {
    const { runner } = hostRunner({ installed: true, reportWritten: false, index: 86 });
    const report = await runSecurityScan(runner);
    expect(report.hardeningIndexSource).toBe("internal");
    expect(report.hardeningIndex).not.toBe(86);
    expect(report.lynisNote).toMatch(/não concluiu/i);
  });

  it("Lynis ausente na VPS: a verificação o instala (repositório do Ubuntu) antes de rodar", async () => {
    const { runner, calls } = hostRunner({ installed: false, reportWritten: true, index: 58 });
    const report = await runSecurityScan(runner);
    expect(calls.indexOf(LYNIS_INSTALL_CMD)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(LYNIS_INSTALL_CMD)).toBeLessThan(calls.indexOf(LYNIS_RUN_CMD));
    expect(report.hardeningIndexSource).toBe("lynis");
    expect(report.hardeningIndex).toBe(58);
  });

  it("instalação falhou: segue com o índice interno e diz o motivo", async () => {
    const { runner } = hostRunner({ installed: false, installWorks: false, reportWritten: true });
    const report = await runSecurityScan(runner);
    expect(report.hardeningIndexSource).toBe("internal");
    expect(report.lynisNote).toMatch(/não foi possível instalar/i);
  });

  it("alvo de desenvolvimento (container): não instala nada", async () => {
    const calls: string[] = [];
    await runSecurityScan(
      fakeRunner((cmd: string) => {
        calls.push(cmd);
        return Promise.resolve({ code: cmd.startsWith("command -v lynis") ? 1 : 0, stdout: "", stderr: "" });
      }),
    );
    expect(calls).not.toContain(LYNIS_INSTALL_CMD);
  });
});
