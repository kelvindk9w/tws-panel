/**
 * Serviço de execução única (job de migração que reaproveita a imagem de outro serviço): terminou com 0 e
 * outros serviços esperam por ele (`service_completed_successfully`). Não é falha: sem alerta, sem "parado".
 * Saiu com erro continua alertando (com o código); serviço comum que saiu continua parado.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { ResourceWatcher, WATCH, isUnexpectedlyDown } from "../src/services/metrics-watch.js";

const T0 = 1_800_000_000;

const cont = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64),
  name: "paas-loja-app-migrate-1",
  slug: "loja",
  service: "app-migrate",
  managed: true,
  state: "exited",
  health: null,
  restartCount: 0,
  startedAt: null,
  exitCode: 0,
  oomKilled: false,
  restartsAt: [],
  oomAt: [],
  unhealthySince: null,
  restartPolicy: "no",
  oneoff: false,
  awaited: true,
  memPct: null,
  ...over,
});

function rig() {
  let n = 0;
  const create = vi.fn(async (_input: { title: string; detail: string; projectSlug?: string }) => ({ alert: { id: `alerta-${++n}` }, created: true }));
  const resolve = vi.fn(async () => undefined);
  const w = new ResourceWatcher({ create, resolve, log: () => undefined });
  const r = {
    w,
    create,
    resolve,
    t: T0,
    async run(minutes: number, containers: (i: number) => ContainerStatus[]) {
      for (let i = 0; i < minutes; i++) {
        r.t += 60;
        const tick: TickResult = { t: r.t, host: {}, containers: containers(i), sample: { t: r.t, h: {}, c: {} }, dockerOk: true, services: [] };
        await w.evaluate(tick, []);
      }
    },
  };
  return r;
}

describe("serviço de execução única", () => {
  it("saiu com 0 e é esperado por outros serviços: não conta como parado, com qualquer política de reinício", () => {
    for (const p of ["no", "on-failure", null, "always", "unless-stopped"]) {
      expect(isUnexpectedlyDown(cont({ restartPolicy: p }))).toBe(false);
    }
  });

  it("saiu com 0 e ninguém espera, sem política de reinício: concluído; com always, serviço comum que caiu", () => {
    expect(isUnexpectedlyDown(cont({ awaited: false, restartPolicy: "no" }))).toBe(false);
    expect(isUnexpectedlyDown(cont({ awaited: false, restartPolicy: "always" }))).toBe(true);
  });

  it("saiu com 0: nenhum alerta, nem de saúde nem de parado", async () => {
    const r = rig();
    await r.run(20, () => [cont()]);
    expect(r.create).not.toHaveBeenCalled();
  });

  it("alerta de saúde que já estava aberto para o job concluído se encerra na volta seguinte", async () => {
    const r = rig();
    const sick = r.t + 60 - WATCH.unhealthySeconds - 60;
    await r.run(2, () => [cont({ state: "running", health: "unhealthy", unhealthySince: sick, exitCode: null })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.w.activeKeys()).toContain(`c:${"a".repeat(64)}:health`);
    await r.run(1, () => [cont({ health: "unhealthy" })]); // saiu com 0; o coletor já não marca como não saudável
    expect(r.resolve).toHaveBeenCalledWith("alerta-1");
    expect(r.w.activeKeys()).toEqual([]);
  });

  it("saiu com erro: alerta de serviço parado com o código de saída, ligado ao projeto", async () => {
    const r = rig();
    await r.run(4, () => [cont({ exitCode: 1 })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    const input = r.create.mock.calls[0]![0];
    expect(input.title).toBe("loja/app-migrate parou de rodar");
    expect(input.detail).toContain("código de saída 1");
    expect(input.detail).toContain("estado: exited");
    expect(input.projectSlug).toBe("loja");
  });

  it("serviço comum que saiu (mesmo com 0) continua parado e alerta", async () => {
    const r = rig();
    await r.run(4, () => [cont({ service: "web", name: "paas-loja-web-1", awaited: false, restartPolicy: "always" })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create.mock.calls[0]![0].title).toBe("loja/web parou de rodar");
  });

  it("job concluído que depois falha na reexecução abre o alerta; ao voltar a 0 ele se encerra já", async () => {
    const r = rig();
    await r.run(3, () => [cont({ exitCode: 2 })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(1, () => [cont({ exitCode: 0 })]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });
});

describe("alerta de saúde com detalhes", () => {
  it("diz o serviço, a verificação, o estado, desde quando e a saída; liga ao projeto", async () => {
    const r = rig();
    const since = T0 + 60 - WATCH.unhealthySeconds - 60;
    await r.run(1, () => [
      cont({
        name: "paas-loja-api-1",
        service: "api",
        state: "running",
        health: "unhealthy",
        unhealthySince: since,
        exitCode: null,
        healthOutput: "curl: (7) Failed to connect",
      }),
    ]);
    expect(r.create).toHaveBeenCalledTimes(1);
    const input = r.create.mock.calls[0]![0];
    expect(input.title).toBe("loja/api não passa na verificação de saúde");
    expect(input.detail).toContain("healthcheck do serviço api (container paas-loja-api-1)");
    expect(input.detail).toContain(`desde ${new Date(since * 1000).toISOString()}`);
    expect(input.detail).toContain("estado: running");
    expect(input.detail).toContain("saúde: unhealthy");
    expect(input.detail).toContain("curl: (7) Failed to connect");
    expect(input.projectSlug).toBe("loja");
  });
});
