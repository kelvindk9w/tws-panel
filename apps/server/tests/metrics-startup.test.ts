import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STARTUP_PER_PROJECT, STARTUP_TOTAL, STARTUP_TRACK_SECONDS, StartupTracker, type StartupObservation } from "../src/services/metrics-startup.js";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const iso = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-startup-"));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const obs = (over: Partial<StartupObservation> = {}): StartupObservation => ({
  id: "a".repeat(64),
  slug: "loja",
  service: "web",
  state: "running",
  health: null,
  startedAt: iso(-30),
  healthyAt: null,
  listening: async () => true,
  ...over,
});

describe("tempo de subida: sem duplicar, rede e projeto apagado", () => {
  it("o painel reinicia dentro da janela e vê o MESMO início: não grava outro tempo (inflado)", async () => {
    const first = new StartupTracker(dir);
    await first.observe(obs({ health: "healthy", healthyAt: iso(-18) }), NOW);
    const second = new StartupTracker(dir);
    await second.load();
    await second.observe(obs({ health: "healthy", healthyAt: null }), NOW + 5 * 60_000);
    expect(second.list("loja")).toHaveLength(1);
    expect(second.list("loja")[0]).toMatchObject({ seconds: 12, approx: false });
  });

  it("rede do host ou de outro container: a porta aberta não é do serviço, não mede", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ ownNetwork: false }), NOW);
    expect(t.list("loja")).toEqual([]);
    await t.observe(obs({ ownNetwork: false }), NOW + 60_000);
    expect(t.list("loja")).toEqual([]);
  });

  it("forget apaga os tempos do projeto (e não mexe nos dos outros)", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ health: "healthy", healthyAt: iso(-18) }), NOW);
    await t.observe(obs({ id: "b".repeat(64), slug: "outro", health: "healthy", healthyAt: iso(-18) }), NOW);
    await t.forget("inexistente");
    await t.forget("loja");
    expect(t.list("loja")).toEqual([]);
    expect(t.list("outro")).toHaveLength(1);
    const again = new StartupTracker(dir);
    await again.load();
    expect(again.list("loja")).toEqual([]);
  });

  it("forget com a gravação falhando só registra no log", async () => {
    const logs: string[] = [];
    const t = new StartupTracker(dir, (m) => logs.push(m));
    await t.observe(obs({ health: "healthy", healthyAt: iso(-18) }), NOW);
    await chmod(dir, 0o500);
    await t.forget("loja");
    expect(t.list("loja")).toEqual([]);
  });
});

describe("tempo de subida", () => {
  it("com saúde: usa o horário exato da primeira verificação que passou", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ health: "healthy", healthyAt: iso(-18) }), NOW);
    expect(t.list("loja")).toEqual([
      { slug: "loja", service: "web", startedAt: iso(-30), readyAt: iso(-18), seconds: 12, via: "health", approx: false },
    ]);
  });

  it("com saúde, mas a verificação já saiu do registro (ou o horário é incoerente): vale a volta que notou, marcada como aproximada", async () => {
    for (const healthyAt of [null, iso(-60), iso(10), "lixo"]) {
      const t = new StartupTracker(dir);
      await t.observe(obs({ health: "healthy", healthyAt }), NOW);
      expect(t.list("loja")[0]).toMatchObject({ seconds: 30, via: "health", approx: true });
    }
  });

  it("'starting' continua sendo acompanhado até ficar saudável; 'unhealthy' é abandonado sem registro", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ health: "starting" }), NOW);
    expect(t.list("loja")).toEqual([]);
    await t.observe(obs({ health: "healthy" }), NOW + 20_000);
    expect(t.list("loja")[0]).toMatchObject({ seconds: 50 });
    const u = new StartupTracker(dir);
    await u.observe(obs({ id: "b".repeat(64), health: "unhealthy" }), NOW);
    await u.observe(obs({ id: "b".repeat(64), health: "healthy" }), NOW + 10_000);
    expect(u.list("loja")).toEqual([]);
  });

  it("sem saúde: porta aberta marca pronto (aproximado); porta fechada espera; sem como ler, abandona", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ listening: async () => false }), NOW);
    expect(t.list("loja")).toEqual([]);
    await t.observe(obs({ listening: async () => true }), NOW + 60_000);
    expect(t.list("loja")[0]).toMatchObject({ seconds: 90, via: "port", approx: true });
    const n = new StartupTracker(dir);
    let calls = 0;
    const unreadable = obs({
      id: "c".repeat(64),
      listening: async () => {
        calls++;
        return null;
      },
    });
    await n.observe(unreadable, NOW);
    await n.observe(unreadable, NOW + 60_000);
    expect(calls).toBe(1); // não insiste num container que não dá para medir
    expect(n.list("loja")).toEqual([]);
  });

  it("mede cada início uma vez só; novo início do mesmo container (reinício) mede de novo", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs(), NOW);
    await t.observe(obs(), NOW + 60_000);
    expect(t.list("loja")).toHaveLength(1);
    await t.observe(obs({ startedAt: iso(100) }), NOW + 130_000);
    expect(t.list("loja")).toHaveLength(2);
  });

  it("container que já rodava há muito (painel acabou de subir), parado ou sem início: ignorado", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ startedAt: iso(-STARTUP_TRACK_SECONDS - 5) }), NOW);
    await t.observe(obs({ id: "b".repeat(64), state: "exited" }), NOW);
    await t.observe(obs({ id: "c".repeat(64), startedAt: null }), NOW);
    await t.observe(obs({ id: "d".repeat(64), startedAt: "lixo" }), NOW);
    expect(t.list("loja")).toEqual([]);
  });

  it("esquece containers que sumiram (retain) e deixa medir um id reaproveitado", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs(), NOW);
    t.retain(new Set());
    await t.observe(obs({ startedAt: iso(-5) }), NOW + 1000); // id reaproveitado, mas um início novo
    expect(t.list("loja")).toHaveLength(2);
  });

  it("guarda no disco, recarrega e respeita os tetos por projeto e geral", async () => {
    const t = new StartupTracker(dir);
    await t.observe(obs({ health: "healthy", healthyAt: iso(-18) }), NOW);
    const again = new StartupTracker(dir);
    await again.load();
    expect(again.list("loja")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dir, "metrics-startups.json"), "utf8")).records).toHaveLength(1);

    const many = new StartupTracker(dir);
    for (let i = 0; i < STARTUP_PER_PROJECT + 5; i++) await many.observe(obs({ id: i.toString(16).padStart(64, "0"), startedAt: iso(-30 + i) }), NOW + i * 1000);
    expect(many.list("loja", 1000)).toHaveLength(STARTUP_PER_PROJECT);
    // o mais novo vem primeiro
    expect(many.list("loja", 2)[0]!.readyAt > many.list("loja", 2)[1]!.readyAt).toBe(true);
    const total = new StartupTracker(dir);
    for (let p = 0; p < 12; p++) {
      for (let i = 0; i < STARTUP_PER_PROJECT; i++) {
        await total.observe(obs({ id: `${p}-${i}`, slug: `p${p}`, startedAt: iso((p * 100 + i) - 30) }), NOW + (p * 100 + i) * 1000);
      }
    }
    const kept = Array.from({ length: 12 }, (_, p) => total.list(`p${p}`, 1000).length).reduce((a, b) => a + b, 0);
    expect(kept).toBe(STARTUP_TOTAL);
  }, 60_000);

  it("arquivo ilegível ou de formato desconhecido recomeça vazio; registros estragados são descartados", async () => {
    await writeFile(path.join(dir, "metrics-startups.json"), "{não é json");
    const bad = new StartupTracker(dir);
    await bad.load();
    expect(bad.list("loja")).toEqual([]);
    await writeFile(path.join(dir, "metrics-startups.json"), JSON.stringify({ records: [{ slug: "loja" }, null, { slug: "loja", service: "web", startedAt: iso(0), readyAt: iso(5), seconds: 5, via: "port", approx: true }] }));
    const mixed = new StartupTracker(dir);
    await mixed.load();
    expect(mixed.list("loja")).toHaveLength(1);
    await writeFile(path.join(dir, "metrics-startups.json"), JSON.stringify({ records: "x" }));
    const wrong = new StartupTracker(dir);
    await wrong.load();
    expect(wrong.list("loja")).toEqual([]);
  });

  it("falha ao gravar vai ao log e a medida segue em memória", async () => {
    const logs: string[] = [];
    await writeFile(path.join(dir, "arquivo"), "x");
    const t = new StartupTracker(path.join(dir, "arquivo"), (m) => logs.push(m));
    await t.observe(obs(), NOW);
    expect(t.list("loja")).toHaveLength(1);
    expect(logs[0]).toContain("não gravados");
    const unreadable = new StartupTracker(path.join(dir, "nao-existe"));
    await unreadable.load();
    expect(unreadable.list("loja")).toEqual([]);
  });
});
