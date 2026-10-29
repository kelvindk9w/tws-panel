/** Backup (que reserva o projeto contra deploy, mas não para containers) não pode silenciar o alerta de serviço parado; restauração (manutenção) sim. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { ResourceWatcher } from "../src/services/metrics-watch.js";

const saved: Record<string, string | undefined> = {};
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-rev-merge-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste-rev");
  for (const [k, v] of Object.entries({ PAAS_DATA_DIR: dir, SETUP_TOKEN_FILE: path.join(dir, "setup-token"), PAAS_PUBLIC_IP: "203.0.113.10", LOG_LEVEL: "silent" })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

const cont = (slug: string, over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64), name: `paas-${slug}-web-1`, slug, service: "web", managed: true, state: "running", health: null, restartCount: 0, startedAt: null,
  exitCode: 0, oomKilled: false, restartsAt: [], oomAt: [], unhealthySince: null, restartPolicy: "always", oneoff: false, memPct: 10, ...over,
});

describe("backup e restauração x alerta de serviço parado (app real)", () => {
  it("queda durante backup alerta em ~2 min; durante restauração fica em silêncio, sem falso alarme ao soltar", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const p = await app.deployService.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "loja.example.com" });
      const create = vi.fn(async () => ({ alert: { id: "x" }, created: true }));
      const w = new ResourceWatcher({ create, resolve: vi.fn(async () => undefined), log: () => {}, intent: (s) => app.deployService.intentOf(s) });
      let t = 1_800_000_000;
      const tick = async (c: ContainerStatus) => {
        t += 60;
        const r: TickResult = { t, host: {}, containers: [c], sample: { t, h: {}, c: {} }, dockerOk: true, services: [] };
        await w.evaluate(r, []);
      };
      const hold = (app.backupService as unknown as { opts: { projects: { hold: (id: string, reason?: string) => Promise<() => void> } } }).opts.projects.hold;
      const down = cont(p.slug, { state: "exited", exitCode: 1 });

      // 1) backup longo; o app cai no 1º minuto (o backup NÃO para o app): o alerta abre em ~2 min, durante o backup
      const release = await hold(p.id, "Backup em andamento");
      await tick(down);
      await tick(down);
      expect(create).not.toHaveBeenCalled();
      await tick(down);
      expect(create).toHaveBeenCalledTimes(1);
      release();

      // 2) restauração: dentro da manutenção a queda não alerta, e ao soltar não há falso alarme
      const create2 = vi.fn(async () => ({ alert: { id: "y" }, created: true }));
      const w2 = new ResourceWatcher({ create: create2, resolve: vi.fn(async () => undefined), log: () => {}, intent: (s) => app.deployService.intentOf(s) });
      const end = app.deployService.holdMaintenance(p.slug);
      for (let i = 0; i < 5; i++) {
        t += 60;
        await w2.evaluate({ t, host: {}, containers: [down], sample: { t, h: {}, c: {} }, dockerOk: true, services: [] }, []);
      }
      end();
      for (let i = 0; i < 6; i++) {
        t += 60;
        await w2.evaluate({ t, host: {}, containers: [cont(p.slug)], sample: { t, h: {}, c: {} }, dockerOk: true, services: [] }, []);
      }
      expect(create2).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 30_000);
});
