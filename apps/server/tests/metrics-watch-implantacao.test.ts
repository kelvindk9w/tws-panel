/**
 * Alertas x deploy: durante o deploy (e na acomodação depois dele) "parou de rodar", "reinicia sem parar" e
 * "não passa na verificação de saúde" ficam em silêncio. Falha de verdade continua alertando: container que segue
 * parado ou doente DEPOIS do prazo abre o alerta normalmente.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { ResourceWatcher } from "../src/services/metrics-watch.js";

const cont = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64), name: "paas-loja-web-1", slug: "loja", service: "web", managed: true, state: "running", health: null, restartCount: 0, startedAt: null,
  exitCode: 0, oomKilled: false, restartsAt: [], oomAt: [], unhealthySince: null, restartPolicy: "always", oneoff: false, memPct: 10, ...over,
});

function setup() {
  let intent: "deploying" | null = null;
  const create = vi.fn(async (_input: { title: string }) => ({ alert: { id: "x" }, created: true }));
  const w = new ResourceWatcher({ create, resolve: vi.fn(async () => undefined), log: () => {}, intent: () => intent });
  let t = 1_800_000_000;
  const tick = async (c: ContainerStatus) => {
    t += 60;
    const r: TickResult = { t, host: {}, containers: [c], sample: { t, h: {}, c: {} }, dockerOk: true, services: [] };
    await w.evaluate(r, []);
  };
  return { create, tick, now: () => t, setIntent: (v: "deploying" | null) => (intent = v) };
}

describe("alertas durante o deploy", () => {
  it("container parado durante o deploy e na acomodação não alerta; depois do prazo, só abre após os 2 min de sempre", async () => {
    const s = setup();
    const down = cont({ state: "exited", exitCode: 1 });
    s.setIntent("deploying");
    for (let i = 0; i < 6; i++) await s.tick(down);
    expect(s.create).not.toHaveBeenCalled();
    // o prazo acabou e o container segue parado: a contagem começa agora (não vale o tempo do deploy)
    s.setIntent(null);
    await s.tick(down);
    await s.tick(down);
    expect(s.create).not.toHaveBeenCalled();
    await s.tick(down);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ title: "loja/web parou de rodar" }));
  });

  it("parada ANTES do deploy não dispara no instante em que o deploy acaba (a contagem recomeça)", async () => {
    const s = setup();
    const down = cont({ state: "exited", exitCode: 1 });
    await s.tick(down); // começa a contar antes do deploy
    s.setIntent("deploying");
    await s.tick(down);
    await s.tick(down);
    await s.tick(down);
    s.setIntent(null);
    await s.tick(down);
    expect(s.create).not.toHaveBeenCalled();
  });

  it("verificação de saúde ruim e reinício em laço ficam em silêncio no deploy; continuam valendo depois", async () => {
    const s = setup();
    const sick = () => cont({ health: "unhealthy", unhealthySince: s.now() - 600, restartsAt: [s.now() - 10, s.now() - 20, s.now() - 30, s.now() - 40] });
    s.setIntent("deploying");
    await s.tick(sick());
    await s.tick(sick());
    expect(s.create).not.toHaveBeenCalled();
    s.setIntent(null);
    await s.tick(sick());
    const titles = s.create.mock.calls.map((c) => c[0]!.title);
    expect(titles.some((x) => /não passa na verificação de saúde/.test(x))).toBe(true);
    expect(titles.some((x) => /reinicia sem parar/.test(x))).toBe(true);
  });

  it("no boot do painel, container saudável não gera alerta nenhum", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await s.tick(cont({ health: "healthy" }));
    expect(s.create).not.toHaveBeenCalled();
  });

  it("sem leitura do Docker na volta (painel acabou de subir), nada é decidido", async () => {
    const s = setup();
    const w = new ResourceWatcher({ create: s.create, resolve: vi.fn(async () => undefined), log: () => {} });
    const t = 1_800_000_000;
    for (let i = 0; i < 5; i++) {
      await w.evaluate({ t: t + i * 60, host: {}, containers: [], sample: { t, h: {}, c: {} }, dockerOk: false, services: [] }, []);
    }
    expect(s.create).not.toHaveBeenCalled();
  });
});
