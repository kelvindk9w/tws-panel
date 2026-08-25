/**
 * monitor.test.ts — MonitorScheduler (packages/security/src/monitor.ts).
 *
 * Bug real: MonitorService.runNow() (POST /api/security/monitor/run) chamava
 * executeScan() diretamente, ignorando o lock `inFlight` do agendador —
 * um POST manual podia rodar em paralelo com um tick automático, dois scans
 * disputando os mesmos recursos do alvo. Estes testes fixam o contrato do
 * lock compartilhado: runNow() recusa com erro claro se já houver um scan em
 * andamento (em vez de enfileirar/esperar, o que bloquearia a requisição
 * HTTP pelo tempo inteiro do scan — pode passar de 1 min em VPS real); o
 * tick automático, em vez de simplesmente pular em silêncio, agora avisa via
 * onSkip.
 */
import { describe, expect, it, vi } from "vitest";
import { MonitorScheduler } from "../src/monitor.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MonitorScheduler — lock inFlight compartilhado", () => {
  it("runNow() recusa com erro claro se já houver um scan em andamento", async () => {
    const gate = deferred();
    const task = vi.fn().mockReturnValue(gate.promise);
    const scheduler = new MonitorScheduler({ intervalMs: 60_000, task });

    const first = scheduler.runNow(); // começa a "rodar" e não resolve ainda
    await Promise.resolve(); // deixa o tick() síncrono inicial rodar até o await do task
    expect(scheduler.inFlight).toBe(true);

    await expect(scheduler.runNow()).rejects.toThrow(/já existe um scan/i);

    gate.resolve();
    await first;
    expect(scheduler.inFlight).toBe(false);
  });

  it("runNow() propaga o erro do próprio scan ao chamador (não é engolido)", async () => {
    const task = vi.fn().mockRejectedValue(new Error("falha ao coletar baseline"));
    const scheduler = new MonitorScheduler({ intervalMs: 60_000, task });
    await expect(scheduler.runNow()).rejects.toThrow("falha ao coletar baseline");
    expect(scheduler.inFlight).toBe(false); // lock liberado mesmo após erro
  });

  it("tick automático NUNCA lança (erros só viram onTick.error) e respeita o mesmo lock", async () => {
    const gate = deferred();
    const task = vi.fn().mockReturnValue(gate.promise);
    const onTick = vi.fn();
    const onSkip = vi.fn();
    const scheduler = new MonitorScheduler({ intervalMs: 60_000, task, onTick, onSkip });

    const runningNow = scheduler.runNow();
    await Promise.resolve();
    expect(scheduler.inFlight).toBe(true);

    // Um tick automático (setInterval) durante o scan manual deve ser pulado, não empilhado.
    // @ts-expect-error acesso ao método privado de tick para simular o disparo do setInterval
    await scheduler["tick"]();
    expect(task).toHaveBeenCalledTimes(1); // não rodou de novo
    expect(onSkip).toHaveBeenCalledTimes(1);

    gate.resolve();
    await runningNow;
  });

  it("onSkip avisa quando um ciclo AUTOMÁTICO é pulado por scan já em andamento (hoje era silencioso)", async () => {
    const gate = deferred();
    const task = vi.fn().mockReturnValue(gate.promise);
    const onSkip = vi.fn();
    const scheduler = new MonitorScheduler({ intervalMs: 60_000, task, onSkip });

    // @ts-expect-error acesso ao método privado — simula dois ticks do setInterval
    const t1 = scheduler["tick"]();
    await Promise.resolve();
    // @ts-expect-error idem
    await scheduler["tick"]();
    expect(onSkip).toHaveBeenCalledTimes(1);

    gate.resolve();
    await t1;
  });

  it("depois que o scan em andamento termina, um novo runNow() roda normalmente", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MonitorScheduler({ intervalMs: 60_000, task });
    await scheduler.runNow();
    await scheduler.runNow();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
