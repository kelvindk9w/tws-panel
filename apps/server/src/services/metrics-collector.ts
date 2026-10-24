/**
 * metrics-collector.ts — a coleta de a cada 60 s.
 *
 * Cada volta (tick): lê o host, lista e examina os containers, calcula as
 * métricas (diferença entre esta leitura e a anterior), grava UMA amostra no
 * disco, fecha as horas e os dias que terminaram e, de hora em hora, apaga o
 * que passou da retenção. Garantias:
 *  - NUNCA lança: qualquer falha vira "sem dados" naquela volta e um motivo
 *    curto em `lastError`; o painel e as próximas voltas seguem;
 *  - uma volta por vez: se a anterior ainda não parou, a nova é pulada. A trava
 *    só é solta quando o trabalho de fato acaba (a volta tem prazo de 25 s, que
 *    cancela as chamadas ao Docker em andamento);
 *  - limites: no máximo MAX_CONTAINERS containers, 6 lidos ao mesmo tempo;
 *  - o estado em memória (contadores anteriores) só guarda os containers que
 *    existem agora.
 */
import {
  METRICS_INTERVAL_SECONDS,
  type MetricsCollectorStatus,
  type MetricsRetention,
  type ProjectProblemReason,
} from "@paas/core";
import type { ContainerRuntime } from "./docker-logs.js";
import { MAX_CONTAINERS, type DockerEntry } from "./metrics-docker.js";
import {
  containerSample,
  hostSample,
  restartEvents,
  roundMetric,
  sumContainerSamples,
  type ContainerRaw,
  type ContainerSampleValues,
  type HostRaw,
  type HostSampleValues,
} from "./metrics-compute.js";
import type { ContainerVia, HostSource } from "./metrics-sources.js";
import type { Sample } from "./metrics-series.js";

/** Prazo de uma volta inteira. */
export const TICK_DEADLINE_MS = 25_000;
/** Containers examinados ao mesmo tempo. */
export const CONTAINER_CONCURRENCY = 6;
/** Janela dos "reinícios recentes" (laço de reinício). */
export const RESTART_WINDOW_SECONDS = 15 * 60;
/** Quanto tempo de amostras do host fica em memória (os vigias olham as últimas horas). */
export const RECENT_HOST_SAMPLES = 120;
/** Primeira volta, depois de subir. */
export const FIRST_TICK_DELAY_MS = 10_000;
const PRUNE_EVERY_SECONDS = 3600;

export interface ContainerStatus {
  id: string;
  name: string;
  slug: string | null;
  service: string | null;
  managed: boolean;
  state: string;
  health: ContainerRuntime["health"] | null;
  restartCount: number | null;
  startedAt: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  /** Instantes (epoch s) de reinício vistos nos últimos 15 minutos. */
  restartsAt: number[];
  /** Instantes (epoch s) de morte por falta de memória nos últimos 15 minutos. */
  oomAt: number[];
  /** Desde quando está "unhealthy" sem parar (epoch s); null = não está. */
  unhealthySince: number | null;
}

export interface TickResult {
  t: number;
  host: HostSampleValues;
  containers: ContainerStatus[];
  /** A amostra gravada nesta volta (host e séries de containers/projetos). */
  sample: Sample;
}

export interface ContainerPort {
  refresh(): Promise<boolean>;
  read(id: string, pid: number | null, hostMemTotal: number | null): Promise<{ raw: ContainerRaw | null; via: ContainerVia }>;
  retain(ids: ReadonlySet<string>): void;
}

export interface CollectorDeps {
  store: {
    appendSample(s: Sample): Promise<void>;
    rollup(nowSec: number): Promise<void>;
    prune(nowSec: number): Promise<number>;
  };
  retention: () => MetricsRetention;
  host: { read(): Promise<{ raw: HostRaw | null; source: HostSource }> };
  docker: {
    list(signal: AbortSignal): Promise<DockerEntry[] | null>;
    inspect(id: string, signal: AbortSignal): Promise<ContainerRuntime | null>;
    reader: ContainerPort;
  };
  /** Relógio de parede em ms. */
  now: () => number;
  /** Relógio monotônico em ms (o intervalo entre voltas). */
  clock: () => number;
  log: (message: string) => void;
  /** Quem quer ver cada volta pronta (os vigias de alerta). Falha aqui não afeta a coleta. */
  onTick?: (result: TickResult) => void | Promise<void>;
}

const SAFE = /[^A-Za-z0-9_.-]/g;
const part = (s: string) => s.replace(SAFE, "_").slice(0, 63) || "_";

/** Chaves das séries: `slug` (projeto), `slug/serviço` (serviço) e `~/nome` (fora de projeto). */
export function seriesKeys(e: Pick<DockerEntry, "projectSlug" | "service" | "name">): { service: string; project: string | null } {
  if (e.projectSlug !== null) return { service: `${part(e.projectSlug)}/${part(e.service ?? e.name)}`, project: part(e.projectSlug) };
  return { service: `~/${part(e.name)}`, project: null };
}

function compact(values: Record<string, number | undefined>, dropZero: readonly string[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v === 0 && dropZero.includes(k)) continue;
    out[k] = roundMetric(v);
  }
  return out;
}

/** Motivos pelos quais um container conta como "com problema" (para o semáforo de projetos). */
export function problemReasons(c: ContainerStatus, nowSec: number): ProjectProblemReason[] {
  const out: ProjectProblemReason[] = [];
  if (c.state === "restarting") out.push("restarting");
  if (c.state === "dead") out.push("dead");
  if (c.state === "running" && c.health === "unhealthy") out.push("unhealthy");
  if (c.restartsAt.filter((t) => t > nowSec - RESTART_WINDOW_SECONDS).length > 3) out.push("restart_loop");
  if (c.oomAt.some((t) => t > nowSec - RESTART_WINDOW_SECONDS)) out.push("oom");
  if (c.state === "exited" && c.exitCode !== null && c.exitCode !== 0) out.push("exited_with_error");
  return out;
}

export class MetricsCollector {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private prevHost: HostRaw | null = null;
  private prevMono: number | null = null;
  private readonly prevRaw = new Map<string, ContainerRaw>();
  private readonly prevRuntime = new Map<string, { state: string; restartCount: number | null; startedAt: string | null }>();
  private statuses = new Map<string, ContainerStatus>();
  private lastPrune: number | null = null;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;
  private hostSource: HostSource = "none";
  private containerSource: MetricsCollectorStatus["containerSource"] = "none";
  private sawAnything = false;
  private latestTick: TickResult | null = null;
  private readonly recent: Array<{ t: number; v: HostSampleValues }> = [];

  constructor(private readonly deps: CollectorDeps) {}

  /** Primeira volta logo depois de subir e, daí, a cada 60 s. Os temporizadores não seguram o processo. */
  start(): void {
    if (this.timer || this.first) return;
    this.first = setTimeout(() => {
      this.first = null;
      void this.tick();
    }, FIRST_TICK_DELAY_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), METRICS_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** A volta em andamento (para esperar o fim ao desligar). */
  private current: Promise<void> | null = null;

  /** Espera a volta em andamento terminar (desligamento e testes). */
  async idle(): Promise<void> {
    await this.current;
  }

  status(): MetricsCollectorStatus {
    let mode: MetricsCollectorStatus["mode"] = "unavailable";
    if (this.sawAnything) mode = this.hostSource === "mounted" && this.containerSource === "cgroup" ? "full" : "reduced";
    return {
      mode,
      hostSource: this.hostSource,
      containerSource: this.containerSource,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      retention: this.deps.retention(),
    };
  }

  /** Última volta pronta (valores de agora e estado dos containers). */
  latest(): TickResult | null {
    return this.latestTick;
  }

  /** Amostras do host das últimas voltas, da mais velha para a mais nova. */
  recentHost(): ReadonlyArray<{ t: number; v: HostSampleValues }> {
    return this.recent;
  }

  /** Uma volta. Nunca lança e nunca roda duas ao mesmo tempo. */
  tick(): Promise<void> {
    if (this.running) return this.current ?? Promise.resolve();
    this.running = true;
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), TICK_DEADLINE_MS);
    this.current = this.doTick(ac.signal)
      .catch((err: unknown) => {
        this.lastError = "unexpected";
        this.deps.log(`métricas: volta falhou (${err instanceof Error ? err.message : String(err)})`);
      })
      .finally(() => {
        clearTimeout(deadline);
        this.running = false;
        this.current = null;
      });
    return this.current;
  }

  private async doTick(signal: AbortSignal): Promise<void> {
    const nowMs = this.deps.now();
    const t = Math.floor(nowMs / 1000);
    const mono = this.deps.clock();
    const dt = this.prevMono === null ? 0 : (mono - this.prevMono) / 1000;
    this.prevMono = mono;
    let error: string | null = null;

    // -- host
    let hostRes: Awaited<ReturnType<CollectorDeps["host"]["read"]>> = { raw: null, source: "none" };
    try {
      hostRes = await this.deps.host.read();
    } catch {
      hostRes = { raw: null, source: "none" };
    }
    const host: HostSampleValues = hostRes.raw ? hostSample(this.prevHost, hostRes.raw, dt) : {};
    if (!hostRes.raw) error = "host_unreadable";
    this.prevHost = hostRes.raw;
    this.hostSource = hostRes.source;

    // -- containers
    let entries: DockerEntry[] | null = null;
    try {
      entries = await this.deps.docker.list(signal);
    } catch {
      entries = null;
    }
    if (entries === null) error ??= "docker_unavailable";
    let cgroupOk = false;
    try {
      cgroupOk = await this.deps.docker.reader.refresh();
    } catch {
      cgroupOk = false;
    }
    const c: Record<string, Record<string, number>> = {};
    const vias = { cgroup: 0, api: 0 };
    const statuses = new Map<string, ContainerStatus>();
    const perProject = new Map<string, ContainerSampleValues[]>();
    const list = (entries ?? []).slice(0, MAX_CONTAINERS);
    const nextRaw = new Map<string, ContainerRaw>();
    const nextRuntime = new Map<string, { state: string; restartCount: number | null; startedAt: string | null }>();

    const one = async (e: DockerEntry): Promise<void> => {
      let runtime: ContainerRuntime | null = null;
      try {
        runtime = await this.deps.docker.inspect(e.id, signal);
      } catch {
        runtime = null;
      }
      const state = runtime?.state ?? e.state;
      const running = state === "running";
      let raw: ContainerRaw | null = null;
      if (running) {
        try {
          const r = await this.deps.docker.reader.read(e.id, runtime?.pid ?? null, host.memTotal ?? null);
          raw = r.raw;
          if (r.via === "cgroup") vias.cgroup++;
          else if (r.via === "api") vias.api++;
        } catch {
          raw = null;
        }
      }
      if (raw) nextRaw.set(e.id, raw);
      const values: ContainerSampleValues = containerSample(this.prevRaw.get(e.id) ?? null, raw, dt, running);
      let restarts = 0;
      if (runtime) {
        const lite = { state: runtime.state, restartCount: runtime.restartCount, startedAt: runtime.startedAt };
        restarts = restartEvents(this.prevRuntime.get(e.id) ?? null, lite);
        nextRuntime.set(e.id, lite);
      }
      if (restarts > 0) values.restarts = restarts;
      const keys = seriesKeys(e);
      c[keys.service] = compact(values, ["oom", "restarts"]);
      if (keys.project !== null) perProject.set(keys.project, [...(perProject.get(keys.project) ?? []), values]);

      const before = this.statuses.get(e.id);
      const recentOnly = (list: number[] | undefined) => (list ?? []).filter((x) => x > t - RESTART_WINDOW_SECONDS);
      const unhealthy = runtime?.health === "unhealthy";
      statuses.set(e.id, {
        id: e.id,
        name: e.name,
        slug: e.projectSlug,
        service: e.service,
        managed: e.managed,
        state,
        health: runtime?.health ?? null,
        restartCount: runtime?.restartCount ?? null,
        startedAt: runtime?.startedAt ?? null,
        exitCode: runtime?.exitCode ?? null,
        oomKilled: runtime?.oomKilled === true,
        restartsAt: [...recentOnly(before?.restartsAt), ...(restarts > 0 ? [t] : [])],
        oomAt: [...recentOnly(before?.oomAt), ...((values.oom ?? 0) > 0 ? [t] : [])],
        unhealthySince: unhealthy ? (before?.unhealthySince ?? t) : null,
      });
    };

    let next = 0;
    const worker = async () => {
      while (next < list.length && !signal.aborted) {
        const e = list[next++]!;
        await one(e);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONTAINER_CONCURRENCY, list.length) }, worker));
    for (const [slug, samples] of perProject) c[slug] = compact(sumContainerSamples(samples), ["oom", "restarts"]);

    this.prevRaw.clear();
    for (const [k, v] of nextRaw) this.prevRaw.set(k, v);
    this.prevRuntime.clear();
    for (const [k, v] of nextRuntime) this.prevRuntime.set(k, v);
    this.statuses = statuses;
    this.deps.docker.reader.retain(new Set(list.map((e) => e.id)));
    this.containerSource = vias.cgroup > 0 ? "cgroup" : vias.api > 0 ? "api" : entries !== null && cgroupOk ? "cgroup" : "none";

    // -- gravar
    const hostOut = compact(host);
    const hasData = Object.keys(hostOut).length > 0 || Object.keys(c).length > 0;
    if (hasData) {
      this.sawAnything = true;
      try {
        await this.deps.store.appendSample({ t, h: hostOut, c });
      } catch (err) {
        error ??= "disk_write";
        this.deps.log(`métricas: amostra não gravada (${(err as NodeJS.ErrnoException).code ?? "erro"})`);
      }
      try {
        await this.deps.store.rollup(t);
        if (this.lastPrune === null || t - this.lastPrune >= PRUNE_EVERY_SECONDS) {
          this.lastPrune = t;
          await this.deps.store.prune(t);
        }
      } catch (err) {
        this.deps.log(`métricas: fechamento/poda falhou (${(err as NodeJS.ErrnoException).code ?? "erro"})`);
      }
    }

    this.lastError = error;
    this.lastTickAt = new Date(nowMs).toISOString();
    this.latestTick = { t, host: hostOut, containers: [...statuses.values()], sample: { t, h: hostOut, c } };
    this.recent.push({ t, v: hostOut });
    while (this.recent.length > RECENT_HOST_SAMPLES) this.recent.shift();
    if (this.deps.onTick) {
      try {
        await this.deps.onTick(this.latestTick);
      } catch (err) {
        this.deps.log(`métricas: ouvinte da volta falhou (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
}
