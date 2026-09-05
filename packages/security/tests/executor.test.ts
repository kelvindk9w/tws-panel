/**
 * executor.test.ts — SecurityExecutor (packages/security/src/executor.ts).
 *
 * Achado do review: a peça mais crítica do módulo de segurança (mutex,
 * parsing de steps, rollback agendado, fluxo de confirmação) tinha cobertura
 * só indireta. Uma regressão aqui custa perder o acesso SSH da VPS — os
 * testes abaixo cobrem os quatro comportamentos diretamente, com um
 * TargetRunner falso (nenhum comando real é executado), mais o
 * restoreJobs() usado pela persistência de jobs em disco (bug do painel
 * reiniciando durante "awaiting_confirmation" e respondendo 404).
 */
import { describe, expect, it, vi } from "vitest";
import type { SecurityJob } from "@paas/core";
import { SecurityExecutor } from "../src/executor.js";
import type { ExecResult, TargetRunner } from "../src/runner.js";

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function makeRunner(overrides: Partial<TargetRunner> = {}): TargetRunner {
  return {
    label: "container:fake",
    profile: "container",
    ensureReady: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" } satisfies ExecResult),
    execStream: vi.fn().mockResolvedValue(0),
    uploadDir: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** execStream que emite chunks fixos por chamada (uma entrada por invocação). */
function scriptedExecStream(calls: Array<{ code: number; chunks?: string[] }>) {
  let call = 0;
  return vi.fn(async (_cmd: string, onData: (chunk: string) => void) => {
    const step = calls[Math.min(call, calls.length - 1)];
    call += 1;
    for (const chunk of step?.chunks ?? []) onData(chunk);
    return step?.code ?? 0;
  });
}

describe("SecurityExecutor — mutex", () => {
  it("recusa um segundo startJob() enquanto o primeiro ainda está em andamento", async () => {
    const runner = makeRunner({ execStream: vi.fn(() => new Promise<number>(() => {})) }); // nunca resolve
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });

    const job1 = await executor.startJob("00", true);
    // run() já começou a executar de forma síncrona até o primeiro await
    // (ensureReady), então o status observável aqui é "running", não mais
    // o "queued" inicial atribuído na criação do objeto.
    expect(["queued", "running"]).toContain(job1.status);
    expect(executor.isBusy).toBe(true);

    await expect(executor.startJob("00", true)).rejects.toThrow(/já existe um job de hardening/i);
  });

  it("libera o mutex quando o job termina, permitindo o próximo", async () => {
    const runner = makeRunner({ execStream: vi.fn().mockResolvedValue(0) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });

    await executor.startJob("00", true);
    await flushMicrotasks();
    expect(executor.isBusy).toBe(false);

    const job2 = await executor.startJob("01", true);
    expect(job2.phase).toBe("01");
  });
});

describe("SecurityExecutor — parsing de steps", () => {
  it("marcadores :::PAAS_STEP/:::PAAS_FAIL viram passos com o status correto, na ordem", async () => {
    const runner = makeRunner({
      execStream: scriptedExecStream([
        {
          code: 0,
          chunks: [
            ":::PAAS_STEP primeiro passo\nfazendo coisas\n",
            ":::PAAS_STEP segundo passo\n:::PAAS_FAIL segundo passo\n",
            ":::PAAS_STEP terceiro passo\ntudo certo\n",
          ],
        },
      ]),
    });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });

    const job = await executor.startJob("00", true);
    await flushMicrotasks();

    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("success");
    expect(finished.steps.map((s) => s.name)).toEqual(["primeiro passo", "segundo passo", "terceiro passo"]);
    // o 1º e o 3º terminam "done" quando o passo seguinte começa (ou o script acaba);
    // o 2º é explicitamente marcado "failed" pelo :::PAAS_FAIL.
    expect(finished.steps.map((s) => s.status)).toEqual(["done", "failed", "done"]);
    expect(finished.log).toContain("fazendo coisas");
  });

  it("passo sem marcador de fim é fechado como 'done' quando o script termina", async () => {
    const runner = makeRunner({
      execStream: scriptedExecStream([{ code: 0, chunks: [":::PAAS_STEP único passo\nsaída qualquer\n"] }]),
    });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", true);
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.steps).toEqual([{ name: "único passo", status: "done" }]);
  });
});

describe("SecurityExecutor — rollback agendado (fases de risco)", () => {
  it("fase de risco em modo real fica awaiting_confirmation com deadline, e expira sozinha para rolled_back", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeRunner({ execStream: vi.fn().mockResolvedValue(0) });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

      const job = await executor.startJob("02", false); // SSH, não dry-run → fase de risco
      await flushMicrotasks();

      let current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("awaiting_confirmation");
      expect(current.rollbackScheduled).toBe(true);
      expect(current.rollbackDeadline).not.toBeNull();

      // janela (5s) + folga (15s) sem confirmação → o executor assume que o
      // rollback agendado NO ALVO reverteu.
      await vi.advanceTimersByTimeAsync(5_000 + 15_000);
      current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("rolled_back");
      expect(current.rollbackScheduled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dry-run em fase de risco NÃO agenda rollback (vira success direto)", async () => {
    const runner = makeRunner({ execStream: vi.fn().mockResolvedValue(0) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("03", true); // firewall, dry-run
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("success");
    expect(finished.rollbackScheduled).toBe(false);
  });

  it("falha do script (exit != 0) em modo real dispara rollback imediato via --rollback", async () => {
    const calls: string[] = [];
    const runner = makeRunner({
      execStream: vi.fn(async (cmd: string) => {
        calls.push(cmd);
        return cmd.includes("--rollback") ? 0 : 1; // script principal falha; rollback funciona
      }),
    });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", false);
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("failed");
    expect(calls.some((c) => c.includes("--rollback"))).toBe(true);
  });
});

describe("SecurityExecutor — fluxo de confirmação", () => {
  it("confirmAccess() cancela o rollback agendado, roda --confirm e marca success", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const runner = makeRunner({
        execStream: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          return 0;
        }),
      });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

      const job = await executor.startJob("02", false);
      await flushMicrotasks();
      expect(executor.getJob(job.id)?.status).toBe("awaiting_confirmation");

      const confirmed = await executor.confirmAccess(job.id);
      expect(confirmed.status).toBe("success");
      expect(confirmed.rollbackScheduled).toBe(false);
      expect(confirmed.rollbackDeadline).toBeNull();
      expect(calls.some((c) => c.includes("--confirm"))).toBe(true);

      // depois de confirmado, a janela expirando não deve reverter o status
      await vi.advanceTimersByTimeAsync(5_000 + 15_000);
      expect(executor.getJob(job.id)?.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirmAccess() em job que não está awaiting_confirmation lança erro", async () => {
    const runner = makeRunner({ execStream: vi.fn().mockResolvedValue(0) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", true);
    await flushMicrotasks();
    expect(executor.getJob(job.id)?.status).toBe("success");
    await expect(executor.confirmAccess(job.id)).rejects.toThrow(/não está aguardando confirmação/i);
  });

  it("confirmAccess() em job inexistente lança erro", async () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    await expect(executor.confirmAccess("nope")).rejects.toThrow(/não encontrado/i);
  });
});

describe("SecurityExecutor — restoreJobs (persistência após restart do painel)", () => {
  function baseJob(overrides: Partial<SecurityJob>): SecurityJob {
    return {
      id: "job-1",
      phase: "02",
      phaseKey: "ssh",
      title: "Hardening de SSH",
      dryRun: false,
      status: "awaiting_confirmation",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: [],
      log: "",
      rollbackScheduled: true,
      rollbackDeadline: null,
      error: null,
      ...overrides,
    };
  }

  it("job 'queued'/'running' restaurado vira 'failed' (processo morreu com o restart)", () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    executor.restoreJobs([baseJob({ id: "j1", status: "running", rollbackScheduled: false })]);
    const job = executor.getJob("j1") as SecurityJob;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/reiniciado/i);
  });

  it("'awaiting_confirmation' com deadline JÁ expirado → vira 'rolled_back' imediatamente", () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    const past = new Date(Date.now() - 60_000).toISOString();
    executor.restoreJobs([baseJob({ id: "j2", rollbackDeadline: past })]);
    const job = executor.getJob("j2") as SecurityJob;
    expect(job.status).toBe("rolled_back");
    expect(job.rollbackScheduled).toBe(false);
  });

  it("'awaiting_confirmation' com deadline FUTURO → continua visível e confirmAccess() ainda funciona", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const runner = makeRunner({
        execStream: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          return 0;
        }),
      });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
      const future = new Date(Date.now() + 60_000).toISOString();
      executor.restoreJobs([baseJob({ id: "j3", rollbackDeadline: future })]);

      // visível de imediato — o bug era responder 404 aqui
      expect(executor.getJob("j3")?.status).toBe("awaiting_confirmation");

      const confirmed = await executor.confirmAccess("j3");
      expect(confirmed.status).toBe("success");
      expect(calls.some((c) => c.includes("--confirm"))).toBe(true);

      // o flip reagendado com o tempo restante não deve mais disparar (já confirmado)
      await vi.advanceTimersByTimeAsync(60_000 + 20_000);
      expect(executor.getJob("j3")?.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("'awaiting_confirmation' com deadline futuro e NUNCA confirmado → ainda flipa para rolled_back sozinho", async () => {
    vi.useFakeTimers();
    try {
      const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
      const future = new Date(Date.now() + 10_000).toISOString();
      executor.restoreJobs([baseJob({ id: "j4", rollbackDeadline: future })]);

      await vi.advanceTimersByTimeAsync(10_000 + 20_000);
      expect(executor.getJob("j4")?.status).toBe("rolled_back");
    } finally {
      vi.useRealTimers();
    }
  });

  it("jobs terminais (success/failed/rolled_back) são restaurados como estão, sem efeitos colaterais", () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    const terminal = baseJob({
      id: "j5",
      status: "success",
      rollbackScheduled: false,
      finishedAt: new Date().toISOString(),
    });
    executor.restoreJobs([terminal]);
    expect(executor.getJob("j5")).toEqual(terminal);
  });
});

describe("SecurityExecutor — fase 01 e o marcador de rollback agendado", () => {
  /** Saída típica do 01-user.sh quando ele TRAVOU o root e agendou a reversão. */
  const LOCKED_OUTPUT =
    ":::PAAS_STEP Travando senha do root (passwd -l root)\n" +
    ":::PAAS_OK Senha do root travada (acesso root direto desabilitado)\n" +
    ":::PAAS_ROLLBACK_SCHEDULED user\n";

  /** Saída típica quando NÃO havia chave instalada — root intacto, nada agendado. */
  const NOT_LOCKED_OUTPUT =
    ":::PAAS_STEP Travando senha do root (passwd -l root)\n" +
    ":::PAAS_SKIP Travamento do root adiado até existir chave SSH para deploy\n";

  it("fase 01 SEM chave colada, mas com o marcador na saída → awaiting_confirmation com prazo", async () => {
    // O BUG: o script encontra a chave que o operador já instalou pelo README,
    // trava o root e agenda a reversão de 5 min NO ALVO. Como nenhuma chave foi
    // COLADA no painel, o executor antigo declarava "success" na hora e o
    // operador nunca via o passo de confirmar acesso — o servidor revertia sozinho.
    const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [LOCKED_OUTPUT] }]) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

    const job = await executor.startJob("01", false, { sshUser: "deploy" });
    await flushMicrotasks();

    const current = executor.getJob(job.id) as SecurityJob;
    expect(current.status).toBe("awaiting_confirmation");
    expect(current.rollbackScheduled).toBe(true);
    expect(current.rollbackDeadline).not.toBeNull();
  });

  it("o marcador de rollback não vira passo nem contamina a lista exibida ao operador", async () => {
    const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [LOCKED_OUTPUT] }]) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

    const job = await executor.startJob("01", false, { sshUser: "deploy" });
    await flushMicrotasks();

    const current = executor.getJob(job.id) as SecurityJob;
    expect(current.steps.map((s) => s.name)).toEqual(["Travando senha do root (passwd -l root)"]);
    expect(current.steps.some((s) => s.name.includes("ROLLBACK"))).toBe(false);
  });

  it("fase 01 SEM chave colada e SEM o marcador → success honesto, e nunca vira rolled_back", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [NOT_LOCKED_OUTPUT] }]) });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

      const job = await executor.startJob("01", false, { sshUser: "deploy" });
      await flushMicrotasks();

      let current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("success");
      expect(current.rollbackScheduled).toBe(false);
      expect(current.rollbackDeadline).toBeNull();
      expect(current.finishedAt).not.toBeNull();

      // nada foi agendado no alvo — a janela passando não pode "reverter" nada
      await vi.advanceTimersByTimeAsync(5_000 + 15_000);
      current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fase 01 COM chave colada e com o marcador → continua entrando em awaiting_confirmation", async () => {
    const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [LOCKED_OUTPUT] }]) });
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });

    const job = await executor.startJob("01", false, {
      sshUser: "deploy",
      sshPublicKey: `ssh-ed25519 ${"A".repeat(68)} operador@laptop`,
    });
    await flushMicrotasks();

    const current = executor.getJob(job.id) as SecurityJob;
    expect(current.status).toBe("awaiting_confirmation");
    expect(current.rollbackScheduled).toBe(true);
  });

  it("fases de risco (02 e 03) continuam exigindo confirmação, independentemente do marcador", async () => {
    for (const phase of ["02", "03"] as const) {
      const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [":::PAAS_STEP algo\n"] }]) });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });
      const job = await executor.startJob(phase, false);
      await flushMicrotasks();
      const current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("awaiting_confirmation");
      expect(current.rollbackScheduled).toBe(true);
    }
  });

  it("em dry-run nenhuma fase entra em awaiting_confirmation, nem com o marcador na saída", async () => {
    for (const phase of ["00", "01", "02", "03"] as const) {
      const runner = makeRunner({ execStream: scriptedExecStream([{ code: 0, chunks: [LOCKED_OUTPUT] }]) });
      const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts", rollbackWindowMs: 5_000 });
      const job = await executor.startJob(phase, true);
      await flushMicrotasks();
      const current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("success");
      expect(current.rollbackScheduled).toBe(false);
    }
  });
});
