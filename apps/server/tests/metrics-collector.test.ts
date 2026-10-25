import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT } from "@paas/core";
import {
  CONTAINER_CONCURRENCY,
  FIRST_TICK_DELAY_MS,
  MetricsCollector,
  RECENT_HOST_SAMPLES,
  RESTART_WINDOW_SECONDS,
  TICK_DEADLINE_MS,
  problemReasons,
  seriesKeys,
  type CollectorDeps,
  type ContainerPort,
  type ContainerStatus,
} from "../src/services/metrics-collector.js";
import type { ContainerRaw, HostRaw } from "../src/services/metrics-compute.js";
import type { ContainerRuntime } from "../src/services/docker-logs.js";
import { MAX_CONTAINERS, type DockerEntry } from "../src/services/metrics-docker.js";
import { parseLoadavg, parseMeminfo, parseProcStat, parseVmstat } from "../src/services/metrics-parse.js";
import type { Sample } from "../src/services/metrics-series.js";
import * as F from "./fixtures/metrics-proc.js";

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

const hostRaw = (stat = F.PROC_STAT, vm = F.VMSTAT): HostRaw => ({
  cpu: parseProcStat(stat).cpu,
  cores: 2,
  load: parseLoadavg(F.LOADAVG),
  mem: parseMeminfo(F.MEMINFO),
  vm: parseVmstat(vm),
  psi: { cpu: 1, mem: 0, io: null },
  disks: null,
  net: null,
  uptime: 100,
  fs: { totalBytes: 100, freeBytes: 50, inodePct: 5 },
});

const entry = (n: number, over: Partial<DockerEntry> = {}): DockerEntry => ({
  id: n.toString(16).padStart(64, "0"),
  name: `paas-loja-web-${n}`,
  state: "running",
  managed: true,
  projectSlug: "loja",
  service: `svc${n}`,
  ...over,
});
const runtime = (over: Partial<ContainerRuntime> = {}): ContainerRuntime => ({
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: "2026-10-24T10:00:00Z",
  finishedAt: null,
  exitCode: 0,
  tty: false,
  pid: 1234,
  oomKilled: false,
  ...over,
});
const raw = (cpuUsec: number, over: Partial<ContainerRaw> = {}): ContainerRaw => ({
  cpuUsec,
  memWorkingBytes: 1000,
  memLimitBytes: null,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  netRxBytes: 0,
  netTxBytes: 0,
  oomKills: 0,
  ...over,
});

interface Harness {
  c: MetricsCollector;
  appended: Sample[];
  logs: string[];
  now: { ms: number };
  deps: CollectorDeps;
  state: {
    host: HostRaw | null;
    entries: DockerEntry[] | null;
    runtime: (e: DockerEntry) => ContainerRuntime | null;
    raw: (e: DockerEntry) => ContainerRaw | null;
    via: "cgroup" | "api" | "none";
    source: "mounted" | "container" | "none";
    cgroup: boolean;
  };
  reader: ContainerPort & { retained: ReadonlySet<string>[] };
  store: { appendSample: ReturnType<typeof vi.fn>; rollup: ReturnType<typeof vi.fn>; prune: ReturnType<typeof vi.fn> };
}

function harness(over: Partial<CollectorDeps> = {}): Harness {
  const appended: Sample[] = [];
  const logs: string[] = [];
  const now = { ms: T0 };
  const state: Harness["state"] = {
    host: hostRaw(),
    entries: [entry(1), entry(2)],
    runtime: () => runtime(),
    raw: () => raw(1_000_000),
    via: "cgroup",
    source: "mounted",
    cgroup: true,
  };
  const idOf = (id: string) => state.entries?.find((e) => e.id === id) ?? entry(0);
  const reader: Harness["reader"] = {
    retained: [],
    refresh: async () => state.cgroup,
    read: async (id) => ({ raw: state.raw(idOf(id)), via: state.via }),
    retain(ids) {
      reader.retained.push(ids);
    },
  };
  const store = {
    appendSample: vi.fn(async (s: Sample) => void appended.push(s)),
    rollup: vi.fn(async () => undefined),
    prune: vi.fn(async () => 0),
  };
  const deps: CollectorDeps = {
    store,
    retention: () => METRICS_RETENTION_DEFAULT,
    host: { read: async () => ({ raw: state.host, source: state.source }) },
    docker: { list: async () => state.entries, inspect: async (id) => state.runtime(idOf(id)), reader },
    now: () => now.ms,
    clock: () => now.ms,
    log: (m) => logs.push(m),
    ...over,
  };
  return { c: new MetricsCollector(deps), appended, logs, now, deps, state, reader, store };
}

async function twoTicks(h: Harness, mutate?: () => void) {
  await h.c.tick();
  h.now.ms += 60_000;
  mutate?.();
  await h.c.tick();
}

describe("uma volta", () => {
  it("primeira volta: valores de agora, sem taxas; serviço e projeto gravados; nada de zero inventado", async () => {
    const h = harness();
    await h.c.tick();
    expect(h.appended).toHaveLength(1);
    const s = h.appended[0]!;
    expect(s.t).toBe(T0 / 1000);
    expect(s.h.memTotal).toBe(8131364 * 1024);
    expect("cpuBusy" in s.h).toBe(false);
    expect(Object.keys(s.c).sort()).toEqual(["loja", "loja/svc1", "loja/svc2"]);
    expect(s.c["loja/svc1"]).toEqual({ up: 1, mem: 1000 });
    expect(s.c.loja).toEqual({ up: 2, mem: 2000 });
    expect("cpu" in s.c["loja/svc1"]!).toBe(false);
  });

  it("segunda volta, 60 s depois: CPU, taxas do host e soma do projeto", async () => {
    const h = harness();
    await twoTicks(h, () => {
      h.state.host = hostRaw(F.PROC_STAT_LATER);
      h.state.raw = () => raw(31_000_000); // +30 s de CPU em 60 s por container
    });
    const s = h.appended[1]!;
    expect(s.c["loja/svc1"]!.cpu).toBe(50);
    expect(s.c.loja!.cpu).toBe(100);
    expect(s.h.cpuSteal).toBeCloseTo(1.8, 1);
    expect(h.c.latest()!.t).toBe(s.t);
    expect(h.c.recentHost()).toHaveLength(2);
  });

  it("container parado: só 'up 0'; fora de projeto: chave ~/nome e sem total", async () => {
    const h = harness();
    h.state.entries = [entry(1, { state: "exited" }), entry(2, { projectSlug: null, managed: false, service: null, name: "Caddy Proxy!" })];
    h.state.runtime = (e) => (e.state === "exited" ? runtime({ state: "exited", pid: null }) : runtime());
    await h.c.tick();
    const s = h.appended[0]!;
    expect(s.c["loja/svc1"]).toEqual({ up: 0 });
    expect(s.c["~/Caddy_Proxy_"]).toEqual({ up: 1, mem: 1000 });
    expect(s.c.loja).toEqual({ up: 0 });
    expect(Object.keys(s.c).sort()).toEqual(["loja", "loja/svc1", "~/Caddy_Proxy_"]);
  });

  it("sem inspect, usa o estado da lista; sem leitura do container, só o estado", async () => {
    const h = harness();
    h.state.runtime = () => null;
    h.state.raw = () => null;
    await h.c.tick();
    expect(h.appended[0]!.c["loja/svc1"]).toEqual({ up: 1 });
    expect(h.c.latest()!.containers[0]).toMatchObject({ state: "running", health: null, restartCount: null, startedAt: null });
  });

  it("reinício (contador do Docker subiu) e morte por memória viram eventos gravados e ficam no estado", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    await twoTicks(h, () => {
      h.state.runtime = () => runtime({ restartCount: 2 });
      h.state.raw = () => raw(2_000_000, { oomKills: 3 });
    });
    const s = h.appended[1]!;
    expect(s.c["loja/svc1"]).toMatchObject({ restarts: 2, oom: 3 });
    expect(s.c.loja).toMatchObject({ restarts: 2, oom: 3 });
    const st = h.c.latest()!.containers[0]!;
    expect(st.restartsAt).toEqual([T0 / 1000 + 60, T0 / 1000 + 60]); // um instante por reinício visto
    expect(st.oomAt).toEqual([T0 / 1000 + 60]);
    // sem novos eventos na volta seguinte: os antigos continuam na janela de 15 min e depois saem
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.c.latest()!.containers[0]!.restartsAt).toHaveLength(2);
    expect("restarts" in h.appended[2]!.c["loja/svc1"]!).toBe(false);
    h.now.ms += (RESTART_WINDOW_SECONDS + 1) * 1000;
    await h.c.tick();
    expect(h.c.latest()!.containers[0]!.restartsAt).toEqual([]);
  });

  it("'unhealthy' guarda desde quando e zera quando volta", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.runtime = () => runtime({ health: "unhealthy" });
    await h.c.tick();
    const since = h.c.latest()!.containers[0]!.unhealthySince;
    expect(since).toBe(T0 / 1000);
    h.now.ms += 120_000;
    await h.c.tick();
    expect(h.c.latest()!.containers[0]!.unhealthySince).toBe(since);
    h.state.runtime = () => runtime({ health: "healthy" });
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.c.latest()!.containers[0]!.unhealthySince).toBeNull();
  });

  it("container que some deixa de ocupar memória (contadores e estado só dos que existem)", async () => {
    const h = harness();
    await h.c.tick();
    h.state.entries = [entry(1)];
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.reader.retained.at(-1)!.size).toBe(1);
    expect(h.c.latest()!.containers).toHaveLength(1);
  });

  it("intervalo entre voltas estranho (VPS parada) invalida as taxas daquela volta", async () => {
    const h = harness();
    await twoTicks(h, () => {
      h.now.ms += 3_600_000;
      h.state.raw = () => raw(99_000_000);
    });
    expect("cpu" in h.appended[1]!.c["loja/svc1"]!).toBe(false);
  });
});

describe("modo e origem dos dados", () => {
  it("antes de coletar: indisponível", () => {
    expect(harness().c.status()).toMatchObject({ mode: "unavailable", hostSource: "none", containerSource: "none", lastTickAt: null, lastError: null, retention: METRICS_RETENTION_DEFAULT });
  });

  it("host montado + cgroup: completo", async () => {
    const h = harness();
    await h.c.tick();
    expect(h.c.status()).toMatchObject({ mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: new Date(T0).toISOString(), lastError: null });
  });

  it("sem a montagem do /proc: reduzido, host 'container'", async () => {
    const h = harness();
    h.state.source = "container";
    await h.c.tick();
    expect(h.c.status()).toMatchObject({ mode: "reduced", hostSource: "container" });
  });

  it("containers pela API do Docker: reduzido", async () => {
    const h = harness();
    h.state.via = "api";
    h.state.cgroup = false;
    await h.c.tick();
    expect(h.c.status()).toMatchObject({ mode: "reduced", containerSource: "api" });
  });

  it("sem containers rodando: a origem vem de o cgroup estar montado", async () => {
    const h = harness();
    h.state.entries = [];
    await h.c.tick();
    expect(h.c.status()).toMatchObject({ mode: "full", containerSource: "cgroup" });
    h.state.cgroup = false;
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.c.status()).toMatchObject({ mode: "reduced", containerSource: "none" });
  });

  it("nada legível: indisponível, com o motivo, e nada é gravado", async () => {
    const h = harness();
    h.state.host = null;
    h.state.source = "none";
    h.state.entries = null;
    h.state.cgroup = false;
    await h.c.tick();
    expect(h.appended).toEqual([]);
    expect(h.store.rollup).not.toHaveBeenCalled();
    expect(h.c.status()).toMatchObject({ mode: "unavailable", lastError: "host_unreadable" });
  });
});

describe("falha de coleta nunca derruba (e nunca vira zero)", () => {
  it("host lança: os containers são gravados, o motivo é 'host_unreadable'", async () => {
    const h = harness({ host: { read: async () => Promise.reject(new Error("x")) } });
    await expect(h.c.tick()).resolves.toBeUndefined();
    expect(Object.keys(h.appended[0]!.h)).toEqual([]);
    expect(Object.keys(h.appended[0]!.c)).toContain("loja");
    expect(h.c.status().lastError).toBe("host_unreadable");
  });

  it("Docker não responde (lista null ou lança): o host é gravado, o motivo é 'docker_unavailable'", async () => {
    for (const list of [async () => null, async (): Promise<DockerEntry[]> => Promise.reject(new Error("x"))]) {
      const h = harness();
      h.deps.docker.list = list;
      await h.c.tick();
      expect(h.appended[0]!.c).toEqual({});
      expect(h.appended[0]!.h.memTotal).toBeDefined();
      expect(h.c.status().lastError).toBe("docker_unavailable");
    }
  });

  it("inspect e leitura do container lançando: o container continua na amostra, com o que se sabe", async () => {
    const h = harness();
    h.deps.docker.inspect = async () => Promise.reject(new Error("x"));
    h.reader.read = async () => Promise.reject(new Error("y"));
    h.reader.refresh = async () => Promise.reject(new Error("z"));
    await h.c.tick();
    expect(h.appended[0]!.c["loja/svc1"]).toEqual({ up: 1 });
  });

  it("disco que não grava: motivo 'disk_write', segue sem lançar, log sem caminho", async () => {
    const h = harness();
    h.store.appendSample.mockRejectedValue(Object.assign(new Error("/data/secreto/x"), { code: "ENOSPC" }));
    await expect(h.c.tick()).resolves.toBeUndefined();
    expect(h.c.status().lastError).toBe("disk_write");
    expect(h.logs.join("\n")).toContain("ENOSPC");
    expect(h.logs.join("\n")).not.toContain("secreto");
  });

  it("fechamento/poda falhando só vai ao log", async () => {
    const h = harness();
    h.store.rollup.mockRejectedValue(Object.assign(new Error("x"), { code: "EIO" }));
    await h.c.tick();
    expect(h.logs.join("\n")).toContain("EIO");
    expect(h.appended).toHaveLength(1);
    h.store.rollup.mockRejectedValue("texto");
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.logs.join("\n")).toContain("erro");
  });

  it("ouvinte da volta lançando (Error ou texto) não afeta a coleta", async () => {
    const onTick = vi.fn().mockRejectedValueOnce(new Error("ouvinte")).mockRejectedValueOnce("texto");
    const h = harness({ onTick });
    await h.c.tick();
    h.now.ms += 60_000;
    await h.c.tick();
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(h.logs.filter((l) => l.includes("ouvinte da volta"))).toHaveLength(2);
    expect(h.appended).toHaveLength(2);
  });

  it("erro inesperado dentro da volta: 'unexpected' e o painel segue", async () => {
    const h = harness({ now: () => { throw new Error("relógio"); } });
    await expect(h.c.tick()).resolves.toBeUndefined();
    expect(h.c.status().lastError).toBe("unexpected");
    const h2 = harness({ now: () => { throw "texto"; } });
    await h2.c.tick();
    expect(h2.logs.join("\n")).toContain("texto");
  });
});

describe("limites", () => {
  it("uma volta por vez: chamar de novo durante a volta devolve a mesma e não duplica trabalho", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness();
    h.deps.host.read = async () => {
      await gate;
      return { raw: hostRaw(), source: "mounted" };
    };
    const a = h.c.tick();
    const b = h.c.tick();
    expect(b).toBe(a);
    release();
    await a;
    expect(h.appended).toHaveLength(1);
    await h.c.tick(); // agora liberada
    expect(h.appended).toHaveLength(2);
  });

  it("no máximo 6 containers examinados ao mesmo tempo", async () => {
    const h = harness();
    h.state.entries = Array.from({ length: 30 }, (_, i) => entry(i + 1));
    let active = 0;
    let peak = 0;
    h.deps.docker.inspect = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return runtime();
    };
    await h.c.tick();
    expect(peak).toBe(CONTAINER_CONCURRENCY);
    expect(Object.keys(h.appended[0]!.c).filter((k) => k.includes("/"))).toHaveLength(30);
  });

  it("no máximo MAX_CONTAINERS containers por volta", async () => {
    const h = harness();
    h.state.entries = Array.from({ length: MAX_CONTAINERS + 40 }, (_, i) => entry(i + 1));
    const inspect = vi.fn(async () => runtime());
    h.deps.docker.inspect = inspect;
    await h.c.tick();
    expect(inspect).toHaveBeenCalledTimes(MAX_CONTAINERS);
  });

  it("a volta tem prazo: passando dele, o sinal cancela as chamadas ao Docker e a volta termina", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let aborted = false;
      h.deps.docker.list = (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          });
        });
      const p = h.c.tick();
      await vi.advanceTimersByTimeAsync(TICK_DEADLINE_MS + 10);
      await p;
      expect(aborted).toBe(true);
      expect(h.c.status().lastError).toBe("docker_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a trava só solta quando o trabalho para (prazo estourado com leitura ainda presa mantém a trava)", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let release!: () => void;
      h.deps.host.read = () => new Promise((r) => (release = () => r({ raw: hostRaw(), source: "mounted" })));
      const first = h.c.tick();
      await vi.advanceTimersByTimeAsync(TICK_DEADLINE_MS + 10);
      const second = h.c.tick(); // ainda presa: não começa outra
      expect(second).toBe(first);
      release();
      await first;
      expect(h.appended).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a memória de amostras recentes é limitada", async () => {
    const h = harness();
    for (let i = 0; i < RECENT_HOST_SAMPLES + 10; i++) {
      h.now.ms += 60_000;
      await h.c.tick();
    }
    expect(h.c.recentHost()).toHaveLength(RECENT_HOST_SAMPLES);
  });

  it("poda de hora em hora (não a cada volta); o fechamento roda a cada volta", async () => {
    const h = harness();
    await h.c.tick();
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.store.rollup).toHaveBeenCalledTimes(2);
    expect(h.store.prune).toHaveBeenCalledTimes(1);
    h.now.ms += 3_540_000; // 1 h depois da primeira poda
    await h.c.tick();
    expect(h.store.prune).toHaveBeenCalledTimes(2);
  });
});

describe("agendamento", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("começa depois de 10 s e repete a cada 60 s; start repetido não duplica; stop para", async () => {
    const h = harness();
    h.c.start();
    h.c.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS - 1);
    expect(h.appended).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.appended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.appended).toHaveLength(2);
    h.c.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.appended).toHaveLength(2);
    h.c.stop();
  });

  it("parar antes da primeira volta cancela a espera", async () => {
    const h = harness();
    h.c.start();
    h.c.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.appended).toHaveLength(0);
  });

  it("idle() espera a volta em andamento", async () => {
    const h = harness();
    void h.c.tick();
    await h.c.idle();
    expect(h.appended).toHaveLength(1);
    await h.c.idle();
  });
});

describe("chaves das séries", () => {
  it("projeto: slug/serviço (ou nome do container), com total do projeto; fora de projeto: ~/nome", () => {
    expect(seriesKeys({ projectSlug: "loja", service: "web", name: "x" })).toEqual({ service: "loja/web", project: "loja" });
    expect(seriesKeys({ projectSlug: "loja", service: null, name: "paas-loja-1" })).toEqual({ service: "loja/paas-loja-1", project: "loja" });
    expect(seriesKeys({ projectSlug: null, service: "web", name: "redis" })).toEqual({ service: "~/redis", project: null });
  });
  it("caracteres perigosos e nomes enormes são saneados", () => {
    expect(seriesKeys({ projectSlug: "a/b", service: "../../x y", name: "n" }).service).toBe("a_b/.._.._x_y");
    expect(seriesKeys({ projectSlug: null, service: null, name: "" }).service).toBe("~/_");
    expect(seriesKeys({ projectSlug: null, service: null, name: "n".repeat(200) }).service.length).toBe(2 + 63);
  });
});

describe("motivos de problema", () => {
  const nowSec = 1_000_000;
  const base: ContainerStatus = {
    id: "a",
    name: "n",
    slug: "p",
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
  };
  it("saudável: nenhum", () => expect(problemReasons(base, nowSec)).toEqual([]));
  it("reiniciando e morto", () => {
    expect(problemReasons({ ...base, state: "restarting" }, nowSec)).toEqual(["restarting"]);
    expect(problemReasons({ ...base, state: "dead" }, nowSec)).toEqual(["dead"]);
  });
  it("não saudável só conta rodando", () => {
    expect(problemReasons({ ...base, health: "unhealthy" }, nowSec)).toEqual(["unhealthy"]);
    expect(problemReasons({ ...base, state: "exited", health: "unhealthy" }, nowSec)).toEqual([]);
  });
  it("laço de reinício: mais de 3 nos últimos 15 minutos (3 não conta)", () => {
    const at = (n: number, age = 10) => Array.from({ length: n }, () => nowSec - age);
    expect(problemReasons({ ...base, restartsAt: at(3) }, nowSec)).toEqual([]);
    expect(problemReasons({ ...base, restartsAt: at(4) }, nowSec)).toEqual(["restart_loop"]);
    expect(problemReasons({ ...base, restartsAt: at(4, RESTART_WINDOW_SECONDS + 1) }, nowSec)).toEqual([]);
  });
  it("morte por memória recente", () => {
    expect(problemReasons({ ...base, oomAt: [nowSec - 5] }, nowSec)).toEqual(["oom"]);
    expect(problemReasons({ ...base, oomAt: [nowSec - RESTART_WINDOW_SECONDS - 1] }, nowSec)).toEqual([]);
  });
  it("saída com erro: parado com código diferente de zero (parar à mão = 0 ou null, sem problema)", () => {
    expect(problemReasons({ ...base, state: "exited", exitCode: 1 }, nowSec)).toEqual(["exited_with_error"]);
    expect(problemReasons({ ...base, state: "exited", exitCode: 0 }, nowSec)).toEqual([]);
    expect(problemReasons({ ...base, state: "exited", exitCode: null }, nowSec)).toEqual([]);
  });
});

describe("Docker sem resposta não é 'os containers sumiram'", () => {
  it("lista que falha mantém o último estado (alerta, tempo de unhealthy, reinícios) e não gera reinício falso na volta", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.runtime = () => runtime({ health: "unhealthy", restartCount: 0 });
    await h.c.tick();
    const before = h.c.latest()!.containers[0]!;
    expect(before.unhealthySince).toBe(T0 / 1000);
    h.deps.docker.list = async () => null;
    h.now.ms += 60_000;
    await h.c.tick();
    const during = h.c.latest()!;
    expect(during.dockerOk).toBe(false);
    expect(during.containers).toHaveLength(1);
    expect(during.containers[0]!.unhealthySince).toBe(T0 / 1000);
    h.deps.docker.list = async () => h.state.entries;
    h.now.ms += 60_000;
    await h.c.tick();
    const after = h.c.latest()!.containers[0]!;
    expect(after.unhealthySince).toBe(T0 / 1000);
    expect(after.restartsAt).toEqual([]);
  });

  it("inspect que falha (Docker lento) não zera o estado que já se conhecia", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.runtime = () => runtime({ health: "unhealthy", oomKilled: true });
    await h.c.tick();
    h.deps.docker.inspect = async () => {
      throw new Error("prazo");
    };
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.c.latest()!.containers[0]).toMatchObject({ unhealthySince: T0 / 1000, health: "unhealthy", oomKilled: true });
  });

  it("entrada da lista que nenhum trabalhador examinou (volta abortada) continua com o estado anterior", async () => {
    const h = harness();
    h.state.entries = Array.from({ length: CONTAINER_CONCURRENCY + 2 }, (_, i) => entry(i + 1));
    h.state.runtime = () => runtime({ health: "unhealthy" });
    await h.c.tick();
    expect(h.c.latest()!.containers).toHaveLength(CONTAINER_CONCURRENCY + 2);
    // segunda volta: o sinal da volta é cancelado enquanto o primeiro lote lê; o resto nem começa
    h.deps.docker.inspect = async (_id, signal) => {
      void signal;
      throw new Error("abortado");
    };
    const realList = h.deps.docker.list;
    h.deps.docker.list = async (signal) => {
      const r = await realList(signal);
      Object.defineProperty(signal, "aborted", { value: true });
      return r;
    };
    h.now.ms += 60_000;
    await h.c.tick();
    const now = h.c.latest()!.containers;
    expect(now).toHaveLength(CONTAINER_CONCURRENCY + 2);
    expect(now.every((c) => c.unhealthySince === T0 / 1000)).toBe(true);
  });
});

describe("morte por falta de memória", () => {
  const vm = (n: number) => F.VMSTAT.replace("oom_kill 2", `oom_kill ${n}`);
  const calm = (n: number) => ({ ...hostRaw(undefined, vm(n)), psi: { cpu: 0, mem: 0, io: null } });
  const LIMIT = 256 * 1024 * 1024;
  const limited = (cpu: number, over: Partial<ContainerRaw> = {}) => raw(cpu, { memLimitBytes: LIMIT, ...over });
  const cid = (n: number) => entry(n).id;

  it("morte pelo limite do próprio container (delta do cgroup) não vira morte da VPS (host sem pressão)", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.host = calm(2);
    h.state.raw = () => limited(1_000_000);
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.host = calm(3);
    h.state.raw = () => limited(2_000_000, { oomKills: 1 });
    await h.c.tick();
    expect(h.appended[1]!.h.oom).toBe(0);
    expect(h.appended[1]!.c["loja/svc1"]!.oom).toBe(1);
  });

  it("container SEM limite de memória: a morte é da VPS (não se desconta)", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.host = calm(2);
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.host = calm(3);
    h.state.raw = () => raw(2_000_000, { oomKills: 1 });
    await h.c.tick();
    expect(h.appended[1]!.c["loja/svc1"]!.oom).toBe(1);
    expect(h.appended[1]!.h.oom).toBe(1);
  });

  it("com o host sob pressão de memória a morte é da VPS mesmo atribuída a um container com limite", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.host = calm(2);
    h.state.raw = () => limited(1_000_000);
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.host = { ...calm(3), psi: { cpu: 0, mem: 40, io: null } };
    h.state.raw = () => limited(2_000_000, { oomKills: 1 });
    await h.c.tick();
    expect(h.appended[1]!.h.oom).toBe(1);
  });

  it("sobrando morte além das dos containers, o excedente é da VPS", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.host = calm(2);
    h.state.raw = () => limited(1_000_000);
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.host = calm(5);
    h.state.raw = () => limited(2_000_000, { oomKills: 1 });
    await h.c.tick();
    expect(h.appended[1]!.h.oom).toBe(2);
  });

  it("caso comum (unless-stopped): processo principal morto, container JÁ rodando de novo, sem a marca OOMKilled e com cgroup zerado; o evento oom do Docker atribui a morte ao container e desconta da VPS", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    const asked: Array<[number, number]> = [];
    let events: Array<{ id: string; t: number }> | null = [];
    h.deps.docker.oomEvents = async (since, until) => {
      asked.push([since, until]);
      return events;
    };
    h.state.host = calm(2);
    h.state.runtime = () => runtime({ oomKilled: false, restartCount: 0 });
    h.state.raw = () => limited(9_000_000, { oomKills: 4 });
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.host = calm(3);
    h.state.runtime = () => runtime({ oomKilled: false, restartCount: 1, startedAt: "2026-10-24T12:00:30Z" }); // o Docker zerou a marca
    h.state.raw = () => limited(10, { oomKills: 0 }); // cgroup novo
    events = [{ id: cid(1), t: T0 / 1000 + 30 }];
    await h.c.tick();
    const s = h.appended[1]!;
    expect(s.c["loja/svc1"]!.oom).toBe(1);
    expect(s.c.loja!.oom).toBe(1);
    expect(s.h.oom).toBe(0);
    const st = h.c.latest()!.containers[0]!;
    expect(st.oomAt).toEqual([T0 / 1000 + 60]);
    expect(problemReasons(st, T0 / 1000 + 60)).toContain("oom");
    // intervalos consecutivos, sem lacuna nem repetição
    expect(asked).toEqual([
      [T0 / 1000, T0 / 1000],
      [T0 / 1000 + 1, T0 / 1000 + 60],
    ]);
  });

  it("Docker sem resposta na consulta de eventos: não conclui nada, e o mesmo intervalo é pedido de novo na volta seguinte", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    const asked: Array<[number, number]> = [];
    let mode: "vazio" | "falha" | "lanca" | "ok" = "vazio";
    h.deps.docker.oomEvents = async (since, until) => {
      asked.push([since, until]);
      if (mode === "lanca") throw new Error("socket");
      if (mode === "falha") return null;
      return mode === "vazio" ? [] : [{ id: cid(1), t: since }];
    };
    h.state.raw = () => limited(1_000_000);
    await h.c.tick(); // primeira volta: intervalo [t, t] respondido
    for (const m of ["falha", "lanca"] as const) {
      mode = m;
      h.now.ms += 60_000;
      await h.c.tick();
      expect(h.appended.at(-1)!.c["loja/svc1"]!.oom).toBeUndefined();
    }
    mode = "ok";
    h.now.ms += 60_000;
    await h.c.tick();
    expect(h.appended.at(-1)!.c["loja/svc1"]!.oom).toBe(1);
    // as duas voltas sem resposta repetiram o início do intervalo; a que respondeu cobriu tudo
    expect(asked.slice(1)).toEqual([
      [T0 / 1000 + 1, T0 / 1000 + 60],
      [T0 / 1000 + 1, T0 / 1000 + 120],
      [T0 / 1000 + 1, T0 / 1000 + 180],
    ]);
  });

  it("depois de uma falha longa a consulta não olha mais que 15 minutos para trás", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    const asked: Array<[number, number]> = [];
    let ok = true;
    h.deps.docker.oomEvents = async (since, until) => {
      asked.push([since, until]);
      return ok ? [] : null;
    };
    await h.c.tick();
    ok = false;
    h.now.ms += 60_000;
    await h.c.tick();
    h.now.ms += 3_600_000;
    await h.c.tick();
    expect(asked.at(-1)).toEqual([T0 / 1000 + 3660 - 15 * 60, T0 / 1000 + 3660]);
  });

  it("container parado por OOM e que não reinicia também aparece (marca OOMKilled); a primeira vez que o container é visto não conta", async () => {
    const h = harness();
    h.state.entries = [entry(1, { state: "exited" })];
    h.state.runtime = () => runtime({ state: "exited", oomKilled: true, finishedAt: "2026-10-24T11:00:00Z", exitCode: 137 });
    await h.c.tick();
    expect(h.appended[0]!.c["loja/svc1"]!.oom).toBeUndefined();
    h.now.ms += 60_000;
    h.state.runtime = () => runtime({ state: "exited", oomKilled: true, finishedAt: "2026-10-24T12:00:50Z", exitCode: 137 });
    await h.c.tick();
    expect(h.appended[1]!.c["loja/svc1"]!.oom).toBe(1);
  });
});

describe("soma do projeto: medida que nunca existe x medida que faltou", () => {
  it("serviço que nunca tem rede/disco (sidecar) não apaga a soma; o que perde a medida neste minuto apaga", async () => {
    const h = harness();
    h.state.entries = [entry(1), entry(2)];
    const noNet = (cpu: number): ContainerRaw => raw(cpu, { netRxBytes: null, netTxBytes: null });
    h.state.raw = (e) => (e.id === entry(2).id ? noNet(1_000_000) : raw(1_000_000));
    await h.c.tick();
    h.now.ms += 60_000;
    h.state.raw = (e) => (e.id === entry(2).id ? noNet(2_000_000) : raw(2_000_000, { netRxBytes: 600 }));
    await h.c.tick();
    expect(h.appended[1]!.c.loja!.netRx).toBe(10); // 600 bytes em 60 s; o outro serviço nunca teve rede
    // o serviço 1 tinha rede e neste minuto não tem: a soma fica sem dados
    h.now.ms += 60_000;
    h.state.raw = (e) => (e.id === entry(2).id ? noNet(3_000_000) : raw(3_000_000, { netRxBytes: null, netTxBytes: null }));
    await h.c.tick();
    expect("netRx" in h.appended[2]!.c.loja!).toBe(false);
    expect(h.appended[2]!.c.loja!.cpu).toBeGreaterThan(0);
  });
});

describe("reinício feito pelo painel", () => {
  it("parar/iniciar pelo painel muda o horário de início sem ser 'reinício sem parar'; depois da carência conta de novo", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T10:00:00Z" });
    await h.c.tick();
    h.c.noteManualAction("loja");
    h.now.ms += 60_000;
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T12:00:30Z" });
    await h.c.tick();
    expect(h.c.latest()!.containers[0]!.restartsAt).toEqual([]);
    expect(h.appended[1]!.c["loja/svc1"]!.restarts).toBeUndefined();
    h.now.ms += 6 * 60_000;
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T12:06:30Z" });
    await h.c.tick();
    expect(h.appended[2]!.c["loja/svc1"]!.restarts).toBe(1);
  });

  it("o contador do Docker subindo conta mesmo na carência (reinício automático)", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    await h.c.tick();
    h.c.noteManualAction("loja");
    h.now.ms += 60_000;
    h.state.runtime = () => runtime({ restartCount: 3, startedAt: "2026-10-24T12:00:30Z" });
    await h.c.tick();
    expect(h.appended[1]!.c["loja/svc1"]!.restarts).toBe(3);
    expect(h.c.latest()!.containers[0]!.restartsAt).toHaveLength(3);
  });

  it("a marca vence exatamente depois de 5 minutos", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T10:00:00Z" });
    await h.c.tick();
    h.c.noteManualAction("loja");
    h.now.ms += 5 * 60_000; // até = agora: já venceu
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T12:04:30Z" });
    await h.c.tick();
    expect(h.appended[1]!.c["loja/svc1"]!.restarts).toBe(1);
  });

  it("a marca de outro projeto não vale", async () => {
    const h = harness();
    h.state.entries = [entry(1)];
    await h.c.tick();
    h.c.noteManualAction("outro");
    h.now.ms += 60_000;
    h.state.runtime = () => runtime({ startedAt: "2026-10-24T12:00:30Z" });
    await h.c.tick();
    expect(h.appended[1]!.c["loja/svc1"]!.restarts).toBe(1);
  });
});
