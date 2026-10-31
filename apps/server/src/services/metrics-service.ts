/**
 * metrics-service.ts — liga as peças do monitoramento de recursos: retenção
 * escolhida, armazenamento, leitores (host, cgroup, Docker), coletor de 60 s,
 * consultas das telas e os alertas. Tudo com dependências injetáveis; app.ts só
 * passa a configuração real.
 */
import { statfs as nodeStatfs } from "node:fs/promises";
import type { AlertSeverity } from "@paas/core";
import type { MetricsConfig } from "../config.js";
import { dockerInspect } from "./docker-logs.js";
import { MetricsCollector, type CollectorDeps } from "./metrics-collector.js";
import { dockerListEntries, dockerStatsRaw } from "./metrics-docker.js";
import { MetricsQuery } from "./metrics-query.js";
import { MetricsSettings } from "./metrics-settings.js";
import { ContainerReader, HostSampler, readText, type ReadText, type StatFs } from "./metrics-sources.js";
import { OomEventStream, type OomSource } from "./metrics-oom-stream.js";
import { MetricsStore } from "./metrics-store.js";
import { StartupTracker } from "./metrics-startup.js";
import { ResourceWatcher } from "./metrics-watch.js";

export interface MetricsServiceOptions {
  dataDir: string;
  dockerSocketPath: string;
  config?: MetricsConfig | undefined;
  alerts: {
    create(input: { severity: AlertSeverity; source: "resources"; title: string; detail: string; projectSlug?: string }): Promise<{ alert: { id: string }; created: boolean }>;
    setStatus(id: string, status: "resolved"): Promise<unknown>;
    /** Alertas de recursos abertos (para adotá-los depois de reiniciar o painel). */
    listOpen?(): Promise<Array<{ id: string; title: string }>>;
  };
  log: (message: string) => void;
  /** O que a pessoa pretende para o projeto (parado por ela, ou com deploy em andamento): serviço parado nesses casos não alerta. */
  intent?: (slug: string) => "stopped" | "deploying" | "maintenance" | null;
  /** Réplicas desejadas por serviço (do compose do projeto); null = não se sabe. */
  desired?: (slug: string) => Promise<Record<string, number> | null>;
  // injeções para teste
  now?: () => number;
  clock?: () => number;
  read?: ReadText;
  statfs?: StatFs;
  docker?: CollectorDeps["docker"];
  /** Fonte dos eventos de morte por memória (testes injetam uma; por padrão, a assinatura do Docker). */
  oomSource?: OomSource;
}

export interface MetricsService {
  enabled: boolean;
  settings: MetricsSettings;
  store: MetricsStore;
  collector: MetricsCollector;
  query: MetricsQuery;
  watcher: ResourceWatcher;
  /** Tempo de subida dos containers (data/metrics-startups.json). */
  startups: StartupTracker;
  start(): void;
  stop(): Promise<void>;
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = { enabled: true, hostProc: "/host/proc", hostCgroup: "/host/sys/fs/cgroup" };

export async function createMetricsService(o: MetricsServiceOptions): Promise<MetricsService> {
  const cfg = o.config ?? DEFAULT_METRICS_CONFIG;
  const settings = new MetricsSettings(o.dataDir);
  await settings.load();
  const retention = () => settings.current();
  const store = new MetricsStore({ dataDir: o.dataDir, retention, log: o.log });
  const read = o.read ?? readText;
  const host = new HostSampler({ mountedProc: cfg.hostProc, ownProc: "/proc", dataDir: o.dataDir, read, statfs: o.statfs ?? ((p) => nodeStatfs(p)) });
  const reader = new ContainerReader({
    cgroupRoot: cfg.hostCgroup,
    procRoot: cfg.hostProc,
    read,
    stats: (id) => dockerStatsRaw(o.dockerSocketPath, id),
  });
  const startups = new StartupTracker(o.dataDir, o.log);
  await startups.load();
  const watcher = new ResourceWatcher({
    ...(o.intent ? { intent: o.intent } : {}),
    create: (input) => o.alerts.create(input),
    resolve: (id) => o.alerts.setStatus(id, "resolved"),
    ...(o.alerts.listOpen ? { listOpen: () => o.alerts.listOpen!() } : {}),
    log: o.log,
  });
  const oom = o.oomSource ?? new OomEventStream({ socketPath: o.dockerSocketPath, log: o.log });
  const collector: MetricsCollector = new MetricsCollector({
    store,
    retention,
    host,
    docker: {
      ...(o.docker ?? {
        list: (signal) => dockerListEntries(o.dockerSocketPath, 8000, signal),
        inspect: (id, signal) => dockerInspect(o.dockerSocketPath, id, 8000, signal),
        reader,
      }),
      oomEvents: oom,
    },
    now: o.now ?? (() => Date.now()),
    clock: o.clock ?? (() => performance.now()),
    log: o.log,
    ...(o.desired ? { desired: o.desired } : {}),
    startups,
    onTick: (tick) => watcher.evaluate(tick, collector.recentHost()),
  });
  const query = new MetricsQuery({ store, collector, now: o.now ?? (() => Date.now()) });
  return {
    enabled: cfg.enabled,
    settings,
    store,
    collector,
    query,
    watcher,
    startups,
    start() {
      if (!cfg.enabled) return;
      oom.start();
      collector.start();
    },
    async stop() {
      collector.stop();
      oom.stop();
      await collector.idle();
    },
  };
}
