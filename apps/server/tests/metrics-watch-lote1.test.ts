import { describe, expect, it, vi } from "vitest";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { ResourceWatcher, WATCH, isUnexpectedlyDown } from "../src/services/metrics-watch.js";

const T0 = 1_800_000_000;

const cont = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64),
  name: "paas-loja-web-1",
  slug: "loja",
  service: "web",
  managed: true,
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: null,
  exitCode: 0,
  oomKilled: false,
  restartsAt: [],
  oomAt: [],
  unhealthySince: null,
  restartPolicy: "always",
  oneoff: false,
  memPct: 10,
  ...over,
});

function rig(opts: { intent?: (slug: string) => "stopped" | "deploying" | null; listOpen?: () => Promise<Array<{ id: string; title: string }>> } = {}) {
  let n = 0;
  const create = vi.fn(async () => ({ alert: { id: `alerta-${++n}` }, created: true }));
  const resolve = vi.fn(async () => undefined);
  const logs: string[] = [];
  const w = new ResourceWatcher({ create, resolve, log: (m) => logs.push(m), ...(opts.intent ? { intent: opts.intent } : {}), ...(opts.listOpen ? { listOpen: opts.listOpen } : {}) });
  const r = {
    w,
    create,
    resolve,
    logs,
    t: T0,
    dockerOk: true,
    wanted: undefined as number | undefined,
    async run(minutes: number, containers: (i: number) => ContainerStatus[]) {
      for (let i = 0; i < minutes; i++) {
        r.t += 60;
        const list = containers(i);
        const tick: TickResult = {
          t: r.t,
          host: {},
          containers: list,
          sample: { t: r.t, h: {}, c: {} },
          dockerOk: r.dockerOk,
          services: r.wanted === undefined ? [] : [{ slug: "loja", service: "web", running: list.filter((c) => c.state === "running").length, wanted: r.wanted }],
        };
        await w.evaluate(tick, []);
      }
    },
  };
  return r;
}

describe("isUnexpectedlyDown", () => {
  it("só exited/dead contam; execução avulsa nunca", () => {
    expect(isUnexpectedlyDown(cont({ state: "running" }))).toBe(false);
    expect(isUnexpectedlyDown(cont({ state: "restarting" }))).toBe(false);
    expect(isUnexpectedlyDown(cont({ state: "created" }))).toBe(false);
    expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 1 }))).toBe(true);
    expect(isUnexpectedlyDown(cont({ state: "dead", exitCode: null }))).toBe(true);
    expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 1, oneoff: true }))).toBe(false);
  });
  it("saiu com 0: serviço de execução única (sem política de reinício ou on-failure) é esperado; com always/unless-stopped alguém o parou", () => {
    for (const p of ["no", "on-failure", null]) expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 0, restartPolicy: p }))).toBe(false);
    expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 0, restartPolicy: "always" }))).toBe(true);
    expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 0, restartPolicy: "unless-stopped" }))).toBe(true);
    expect(isUnexpectedlyDown(cont({ state: "exited", exitCode: 0 }))).toBe(true); // o padrão do teste é "always"
  });
});

describe("serviço parado", () => {
  const down = (over: Partial<ContainerStatus> = {}) => cont({ state: "exited", exitCode: 1, ...over });

  it("só alerta depois de 2 minutos seguidos parado; uma volta parada não alerta", async () => {
    const r = rig();
    await r.run(1, () => [down()]);
    expect(r.create).not.toHaveBeenCalled();
    await r.run(1, () => [cont()]); // voltou: o relógio zera
    await r.run(1, () => [down()]);
    await r.run(1, () => [down()]);
    expect(r.create).not.toHaveBeenCalled();
    await r.run(1, () => [down()]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical", source: "resources", title: "loja/web parou de rodar" }));
    expect(r.w.activeKeys()).toEqual(["s:loja/web:down"]);
  });

  it("não pisca: um alerta só enquanto parado; some depois de 5 voltas boas seguidas, e uma volta parada no meio recomeça a contagem", async () => {
    const r = rig();
    await r.run(6, () => [down()]);
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(4, () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => [down()]); // oscilou: não encerra
    await r.run(4, () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => [cont()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.resolve).toHaveBeenCalledWith("alerta-1");
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.w.activeKeys()).toEqual([]);
  });

  it("projeto parado pelo painel não alerta, e um alerta aberto se encerra", async () => {
    let intent: "stopped" | "deploying" | null = null;
    const r = rig({ intent: () => intent });
    intent = "stopped";
    await r.run(10, () => [down()]);
    expect(r.create).not.toHaveBeenCalled();
    intent = null;
    await r.run(3, () => [down()]);
    expect(r.create).toHaveBeenCalledTimes(1);
    intent = "stopped";
    await r.run(6, () => [down()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("deploy em andamento não alerta", async () => {
    const r = rig({ intent: () => "deploying" });
    await r.run(10, () => [down()]);
    expect(r.create).not.toHaveBeenCalled();
  });

  it("serviço de execução única que terminou com 0 e execução avulsa não alertam", async () => {
    const r = rig();
    await r.run(10, () => [cont({ id: "b".repeat(64), service: "migrate", state: "exited", exitCode: 0, restartPolicy: "no" }), down({ id: "c".repeat(64), service: "tmp", oneoff: true })]);
    expect(r.create).not.toHaveBeenCalled();
  });

  it("container fora de projeto não entra", async () => {
    const r = rig();
    await r.run(10, () => [down({ slug: null, service: null })]);
    expect(r.create).not.toHaveBeenCalled();
  });

  it("réplicas: uma parada de três é aviso (não crítico) e o detalhe diz quantas", async () => {
    const r = rig();
    r.wanted = 3;
    const three = [cont({ id: "1".repeat(64) }), cont({ id: "2".repeat(64) }), down({ id: "3".repeat(64) })];
    await r.run(3, () => three);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning", detail: expect.stringContaining("1 de 3 réplicas estão paradas (2 rodando)") }));
    expect(r.create).toHaveBeenCalledTimes(1);
  });

  it("código de saída aparece no detalhe", async () => {
    const r = rig();
    await r.run(3, () => [down({ exitCode: 137 })]);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("código de saída 137") }));
  });

  it("sem leitura do Docker nada muda; serviço que sumiu encerra o alerta", async () => {
    const r = rig();
    await r.run(3, () => [down()]);
    r.dockerOk = false;
    await r.run(10, () => []);
    expect(r.resolve).not.toHaveBeenCalled();
    r.dockerOk = true;
    await r.run(1, () => []);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("depois de reiniciar o painel adota o alerta aberto e o encerra pela histerese normal", async () => {
    const r = rig({ listOpen: async () => [{ id: "velho", title: "loja/web parou de rodar" }, { id: "sobra", title: "loja/api parou de rodar" }] });
    await r.run(1, () => [down()]);
    expect(r.create).not.toHaveBeenCalled(); // adotado, não duplicado
    expect(r.resolve).toHaveBeenCalledWith("sobra"); // serviço que não existe mais
    expect(r.w.activeKeys()).toEqual(["s:loja/web:down"]);
    await r.run(5, () => [cont()]);
    expect(r.resolve).toHaveBeenCalledWith("velho");
  });
});

describe("memória perto do limite", () => {
  const near = (pct: number | null, over: Partial<ContainerStatus> = {}) => cont({ memPct: pct, ...over });

  it("só alerta com 90% ou mais em todas as amostras de 10 minutos; um pico não conta", async () => {
    const r = rig();
    await r.run(15, (i) => [near(i === 6 ? 50 : 95)]);
    expect(r.create).not.toHaveBeenCalled();
    const s = rig();
    await s.run(7, () => [near(95)]);
    expect(s.create).not.toHaveBeenCalled(); // janela ainda curta
    await s.run(1, () => [near(95)]); // 8 amostras = 80% da janela
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.create).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warning", source: "resources", title: "loja/web está perto do limite de memória", detail: expect.stringContaining("95%") }),
    );
  });

  it("histerese: entre 80% e 90% continua; só volta com 10 minutos abaixo de 80%", async () => {
    const r = rig();
    await r.run(12, () => [near(95)]);
    await r.run(15, () => [near(85)]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(8, () => [near(40)]);
    expect(r.resolve).not.toHaveBeenCalled(); // ainda tem amostra de 85% na janela
    await r.run(6, () => [near(40)]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledTimes(1);
  });

  it("container sem limite (memPct nulo) nunca alerta; container parado encerra o aviso", async () => {
    const r = rig();
    await r.run(20, () => [near(null)]);
    expect(r.create).not.toHaveBeenCalled();
    await r.run(12, () => [near(95)]);
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(1, () => [near(null, { state: "exited", exitCode: 1 })]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("limiares exportados", () => {
    expect(WATCH.downSeconds).toBe(120);
    expect(WATCH.downOkTicks).toBe(5);
  });
});
