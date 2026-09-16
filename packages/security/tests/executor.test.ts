/**
 * executor.test.ts — SecurityExecutor (packages/security/src/executor.ts).
 *
 * Achado do review: a peça mais crítica do módulo de segurança (mutex,
 * parsing de steps, rollback agendado, fluxo de confirmação) tinha cobertura
 * só indireta. Uma regressão aqui custa perder o acesso SSH da VPS — os
 * testes abaixo cobrem os comportamentos diretamente, com um TargetRunner
 * falso (nenhum comando real é executado), mais o restoreJobs() usado pela
 * persistência de jobs em disco (bug do painel reiniciando durante
 * "awaiting_confirmation" e respondendo 404).
 *
 * Desde a execução DESTACADA, o alvo falso fala o protocolo de lib.sh:
 * o disparo lança a fase e acompanha; o canal pode morrer no meio (a fase
 * continua) e o reatache reexibe tudo desde o início, fechando com
 * :::PAAS_RUN_END <código>.
 */
import { describe, expect, it, vi } from "vitest";
import type { SecurityJob } from "@paas/core";
import { SecurityExecutor } from "../src/executor.js";
import type { ExecResult, TargetRunner } from "../src/runner.js";

async function flushMicrotasks(rounds = 60): Promise<void> {
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

/**
 * Alvo falso que fala o protocolo da execução destacada (scripts/hardening/
 * lib.sh): guarda a saída da "fase" num log próprio, entrega-a a quem
 * acompanha e só revela o código de saída no marcador :::PAAS_RUN_END.
 */
class FakeDetachedHost {
  /** Todos os comandos que subiram ao alvo, na ordem. */
  readonly calls: string[] = [];
  /** Saída da fase (o que o log do alvo contém). */
  chunks: string[] = [];
  /** Código de saída da fase. */
  code = 0;
  /** Quantos acompanhamentos ainda vão morrer antes de entregar o desfecho. */
  cuts = 0;
  /** A fase já está rodando no alvo (trava por fase do lib.sh). */
  busy = false;
  /** Código dos comandos diretos (--rollback/--confirm). */
  directCode = 0;
  /** Execuções destacadas lançadas (runIds vistos no disparo). */
  readonly started: string[] = [];

  get runner(): TargetRunner {
    return {
      label: "host",
      profile: "host",
      ensureReady: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" } satisfies ExecResult),
      uploadDir: vi.fn().mockResolvedValue(undefined),
      execStream: (cmd: string, onData: (chunk: string) => void) => this.execStream(cmd, onData),
    };
  }

  private async execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    this.calls.push(cmd);
    if (cmd.includes("--paas-run-detached")) {
      const runId = /--paas-run-detached '[^']*' (\S+)/.exec(cmd)?.[1] ?? "";
      if (this.busy) {
        onData(":::PAAS_RUN_BUSY fase\n");
        return 75;
      }
      this.started.push(runId);
      onData(`:::PAAS_RUN_STARTED ${runId} 4242\n`);
      return this.stream(onData);
    }
    if (cmd.includes("--paas-run-follow")) {
      return this.stream(onData);
    }
    return this.directCode;
  }

  /** Reexibe o log inteiro; corta antes do desfecho quando pedido. */
  private stream(onData: (chunk: string) => void): number {
    for (const chunk of this.chunks) onData(chunk);
    if (this.cuts > 0) {
      this.cuts -= 1;
      throw new Error("canal morreu no meio (rede caiu)");
    }
    onData(`\n:::PAAS_RUN_END ${this.code} ok\n`);
    return 0;
  }
}

function detached(opts?: Partial<Pick<FakeDetachedHost, "chunks" | "code" | "cuts" | "busy">>): FakeDetachedHost {
  const host = new FakeDetachedHost();
  Object.assign(host, opts ?? {});
  return host;
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
    const host = detached();
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });

    await executor.startJob("00", true);
    await flushMicrotasks();
    expect(executor.isBusy).toBe(false);

    const job2 = await executor.startJob("01", true);
    expect(job2.phase).toBe("01");
  });

  it("a MESMA fase já rodando no servidor (trava do alvo) falha o job, sem reaplicar nada", async () => {
    const host = detached({ busy: true });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });

    const job = await executor.startJob("00", false);
    await flushMicrotasks();

    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/já está em execução no servidor/i);
    // nada foi reexecutado: só o disparo recusado subiu ao alvo
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toContain("--paas-run-detached");
  });
});

describe("SecurityExecutor — execução destacada", () => {
  it("dispara a fase pelo lançador destacado (lib.sh), com id de execução próprio", async () => {
    const host = detached();
    const executor = new SecurityExecutor({
      runner: host.runner,
      scriptsDir: "/scripts",
      remoteDir: "/opt/paas-hardening",
    });

    const job = await executor.startJob("00", true);
    await flushMicrotasks();

    expect(host.calls[0]).toContain("bash '/opt/paas-hardening/lib.sh' --paas-run-detached '/etc/paas/runs' ");
    expect(host.calls[0]).toContain("00-update.sh --dry-run");
    expect(host.started[0]).toMatch(/^f00-[0-9a-f]{16}$/);
    expect(executor.runIdsSnapshot()[job.id]).toBe(host.started[0]);
  });

  it("dry-run usa o MESMO caminho de execução (destacado), só com --dry-run", async () => {
    const host = detached();
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("06", true);
    await flushMicrotasks();

    expect(host.calls[0]).toContain("--paas-run-detached");
    expect(host.calls[0]).toContain("--dry-run");
    expect(executor.getJob(job.id)?.status).toBe("success");
  });

  it("matar o canal no meio NÃO mata a fase: o executor reatacha e conclui com o código real", async () => {
    vi.useFakeTimers();
    try {
      const host = detached({
        chunks: [":::PAAS_STEP Atualizando pacotes\n", "Reading package lists...\n"],
        code: 0,
        cuts: 1, // o primeiro acompanhamento morre antes do desfecho
      });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        reattachDelayMs: 1_000,
      });

      const job = await executor.startJob("00", false);
      await vi.advanceTimersByTimeAsync(0);
      // canal morto: o job NÃO pode ter virado failed nem success
      expect(executor.getJob(job.id)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1_500);
      const finished = executor.getJob(job.id) as SecurityJob;
      expect(finished.status).toBe("success");
      // reatache mostra o que já passou (log relido do alvo, do início)
      expect(finished.log).toContain("Reading package lists...");
      expect(finished.steps.map((s) => s.name)).toEqual(["Atualizando pacotes"]);
      expect(host.calls.filter((c) => c.includes("--paas-run-follow"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reatache não duplica passos: o log é relido do início a cada tentativa", async () => {
    vi.useFakeTimers();
    try {
      const host = detached({
        chunks: [":::PAAS_STEP passo único\nsaída\n"],
        cuts: 2,
      });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        reattachDelayMs: 1_000,
      });
      const job = await executor.startJob("00", true);
      await vi.advanceTimersByTimeAsync(5_000);

      const finished = executor.getJob(job.id) as SecurityJob;
      expect(finished.status).toBe("success");
      expect(finished.steps.map((s) => s.name)).toEqual(["passo único"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("desiste depois do teto de reataches, sem inventar sucesso nem falha do script", async () => {
    vi.useFakeTimers();
    try {
      const host = detached({ cuts: 99 });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        reattachDelayMs: 1_000,
        maxReattachAttempts: 2,
      });
      const job = await executor.startJob("00", true);
      await vi.advanceTimersByTimeAsync(10_000);

      const finished = executor.getJob(job.id) as SecurityJob;
      expect(finished.status).toBe("failed");
      expect(finished.error).toMatch(/reatachar/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("processo morto no alvo sem código de saída → falha honesta, sem rollback automático", async () => {
    const host = detached();
    host.chunks = [":::PAAS_STEP algo\n"];
    // desfecho "dead": lib.sh não encontrou o código de saída
    const runner = host.runner;
    const original = runner.execStream.bind(runner);
    runner.execStream = async (cmd, onData) => {
      if (cmd.includes("--paas-run-detached")) {
        host.calls.push(cmd);
        onData(":::PAAS_STEP algo\n");
        onData("\n:::PAAS_RUN_END - dead\n");
        return 0;
      }
      return original(cmd, onData);
    };
    const executor = new SecurityExecutor({ runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", false);
    await flushMicrotasks();

    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/sem registrar o código de saída/i);
    expect(host.calls.some((c) => c.includes("--rollback"))).toBe(false);
  });
});

describe("SecurityExecutor — parsing de steps", () => {
  it("marcadores :::PAAS_STEP/:::PAAS_FAIL viram passos com o status correto, na ordem", async () => {
    const host = detached({
      chunks: [
        ":::PAAS_STEP primeiro passo\nfazendo coisas\n",
        ":::PAAS_STEP segundo passo\n:::PAAS_FAIL segundo passo\n",
        ":::PAAS_STEP terceiro passo\ntudo certo\n",
      ],
    });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });

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
    const host = detached({ chunks: [":::PAAS_STEP único passo\nsaída qualquer\n"] });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", true);
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.steps).toEqual([{ name: "único passo", status: "done" }]);
  });

  it("marcador partido entre dois chunks ainda é reconhecido", async () => {
    const host = detached({ chunks: [":::PAAS_STEP passo part", "ido\nresto\n"] });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", true);
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.steps.map((s) => s.name)).toEqual(["passo partido"]);
  });
});

describe("SecurityExecutor — rollback agendado (fases de risco)", () => {
  it("fase de risco em modo real fica awaiting_confirmation com deadline, e expira sozinha para rolled_back", async () => {
    vi.useFakeTimers();
    try {
      const host = detached();
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        rollbackWindowMs: 5_000,
      });

      const job = await executor.startJob("02", false); // SSH, não dry-run → fase de risco
      await vi.advanceTimersByTimeAsync(0);

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
    const host = detached();
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("03", true); // firewall, dry-run
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("success");
    expect(finished.rollbackScheduled).toBe(false);
  });

  it("falha do script (exit != 0) em modo real dispara rollback imediato via --rollback", async () => {
    const host = detached({ code: 1 });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    const job = await executor.startJob("00", false);
    await flushMicrotasks();
    const finished = executor.getJob(job.id) as SecurityJob;
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/código 1/);
    expect(host.calls.some((c) => c.includes("--rollback"))).toBe(true);
  });
});

describe("SecurityExecutor — fluxo de confirmação", () => {
  it("confirmAccess() cancela o rollback agendado, roda --confirm e marca success", async () => {
    vi.useFakeTimers();
    try {
      const host = detached();
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        rollbackWindowMs: 5_000,
      });

      const job = await executor.startJob("02", false);
      await vi.advanceTimersByTimeAsync(0);
      expect(executor.getJob(job.id)?.status).toBe("awaiting_confirmation");

      const confirmed = await executor.confirmAccess(job.id);
      expect(confirmed.status).toBe("success");
      expect(confirmed.rollbackScheduled).toBe(false);
      expect(confirmed.rollbackDeadline).toBeNull();
      expect(host.calls.some((c) => c.includes("--confirm"))).toBe(true);

      // depois de confirmado, a janela expirando não deve reverter o status
      await vi.advanceTimersByTimeAsync(5_000 + 15_000);
      expect(executor.getJob(job.id)?.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirmAccess() em job que não está awaiting_confirmation lança erro", async () => {
    const host = detached();
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
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

  it("job 'running' SEM execução destacada conhecida vira 'failed' (comportamento antigo)", () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    executor.restoreJobs([baseJob({ id: "j1", status: "running", rollbackScheduled: false })]);
    const job = executor.getJob("j1") as SecurityJob;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/reiniciado/i);
  });

  it("job 'running' COM execução destacada é RECONCILIADO: reatacha e recupera o código de saída", async () => {
    const host = detached({ chunks: [":::PAAS_STEP retomando\nlinha que passou\n"], code: 0 });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });

    executor.restoreRunIds({ j9: "f02-0123456789abcdef" });
    executor.restoreJobs([baseJob({ id: "j9", status: "running", rollbackScheduled: false })]);

    expect(executor.getJob("j9")?.status).toBe("running");
    expect(executor.isBusy).toBe(true);
    await flushMicrotasks();

    const job = executor.getJob("j9") as SecurityJob;
    // fase de risco concluída com sucesso → volta a aguardar confirmação
    expect(job.status).toBe("awaiting_confirmation");
    expect(job.log).toContain("linha que passou");
    expect(host.calls[0]).toContain("--paas-run-follow '/etc/paas/runs' f02-0123456789abcdef");
    expect(executor.isBusy).toBe(false);
  });

  it("reatache de job que terminou EM FALHA enquanto ninguém olhava dispara o rollback imediato", async () => {
    const host = detached({ code: 3 });
    const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
    executor.restoreRunIds({ j10: "f02-abcdefabcdef0123" });
    executor.restoreJobs([baseJob({ id: "j10", status: "running", rollbackScheduled: false })]);
    await flushMicrotasks();

    const job = executor.getJob("j10") as SecurityJob;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/código 3/);
    expect(host.calls.some((c) => c.includes("--rollback"))).toBe(true);
  });

  it("runId persistido em formato inválido é ignorado (fail-closed)", () => {
    const executor = new SecurityExecutor({ runner: makeRunner(), scriptsDir: "/scripts" });
    executor.restoreRunIds({ j11: "../../etc/passwd" });
    expect(executor.runIdsSnapshot()).toEqual({});
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
      const host = detached();
      const executor = new SecurityExecutor({ runner: host.runner, scriptsDir: "/scripts" });
      const future = new Date(Date.now() + 60_000).toISOString();
      executor.restoreJobs([baseJob({ id: "j3", rollbackDeadline: future })]);

      // visível de imediato — o bug era responder 404 aqui
      expect(executor.getJob("j3")?.status).toBe("awaiting_confirmation");

      const confirmed = await executor.confirmAccess("j3");
      expect(confirmed.status).toBe("success");
      expect(host.calls.some((c) => c.includes("--confirm"))).toBe(true);

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
    const host = detached({ chunks: [LOCKED_OUTPUT] });
    const executor = new SecurityExecutor({
      runner: host.runner,
      scriptsDir: "/scripts",
      rollbackWindowMs: 5_000,
    });

    const job = await executor.startJob("01", false, { sshUser: "deploy" });
    await flushMicrotasks();

    const current = executor.getJob(job.id) as SecurityJob;
    expect(current.status).toBe("awaiting_confirmation");
    expect(current.rollbackScheduled).toBe(true);
    expect(current.rollbackDeadline).not.toBeNull();
  });

  it("o marcador de rollback não vira passo nem contamina a lista exibida ao operador", async () => {
    const host = detached({ chunks: [LOCKED_OUTPUT] });
    const executor = new SecurityExecutor({
      runner: host.runner,
      scriptsDir: "/scripts",
      rollbackWindowMs: 5_000,
    });

    const job = await executor.startJob("01", false, { sshUser: "deploy" });
    await flushMicrotasks();

    const current = executor.getJob(job.id) as SecurityJob;
    expect(current.steps.map((s) => s.name)).toEqual(["Travando senha do root (passwd -l root)"]);
    expect(current.steps.some((s) => s.name.includes("ROLLBACK"))).toBe(false);
  });

  it("fase 01 SEM chave colada e SEM o marcador → success honesto, e nunca vira rolled_back", async () => {
    vi.useFakeTimers();
    try {
      const host = detached({ chunks: [NOT_LOCKED_OUTPUT] });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        rollbackWindowMs: 5_000,
      });

      const job = await executor.startJob("01", false, { sshUser: "deploy" });
      await vi.advanceTimersByTimeAsync(0);

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
    const host = detached({ chunks: [LOCKED_OUTPUT] });
    const executor = new SecurityExecutor({
      runner: host.runner,
      scriptsDir: "/scripts",
      rollbackWindowMs: 5_000,
    });

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
      const host = detached({ chunks: [":::PAAS_STEP algo\n"] });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        rollbackWindowMs: 5_000,
      });
      const job = await executor.startJob(phase, false);
      await flushMicrotasks();
      const current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("awaiting_confirmation");
      expect(current.rollbackScheduled).toBe(true);
    }
  });

  it("em dry-run nenhuma fase entra em awaiting_confirmation, nem com o marcador na saída", async () => {
    for (const phase of ["00", "01", "02", "03"] as const) {
      const host = detached({ chunks: [LOCKED_OUTPUT] });
      const executor = new SecurityExecutor({
        runner: host.runner,
        scriptsDir: "/scripts",
        rollbackWindowMs: 5_000,
      });
      const job = await executor.startJob(phase, true);
      await flushMicrotasks();
      const current = executor.getJob(job.id) as SecurityJob;
      expect(current.status).toBe("success");
      expect(current.rollbackScheduled).toBe(false);
    }
  });
});
