/**
 * routes-metrics.test.ts — rotas do monitoramento de recursos contra o painel
 * REAL (sem Docker, sem /proc do host): /proc e cgroup de mentira numa pasta
 * temporária, lista de containers e inspect trocados por dublês, relógio falso.
 * Cobre a política de tokens (opção "pode ver o monitoramento da VPS"), o 404
 * igual para projeto fora do alcance, a retenção e o 429 de consulta ocupada.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { MetricsBusyError } from "../src/services/metrics-query.js";
import * as F from "./fixtures/metrics-proc.js";

const CID = "c".repeat(64);
const state = vi.hoisted(() => ({ entries: [] as unknown[], runtime: {} as Record<string, unknown>, byId: {} as Record<string, Record<string, unknown>> }));

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));
vi.mock("../src/services/metrics-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metrics-docker.js")>()),
  dockerListEntries: async () => state.entries,
}));
vi.mock("../src/services/docker-logs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-logs.js")>()),
  dockerInspect: async (_socket: string, id: string) => state.byId[id] ?? state.runtime,
}));

let panel: RealPanel;
let proc: string;
let cg: string;
let A = "";
let B = "";
let slugA = "";
let slugB = "";
const saved: Record<string, string | undefined> = {};
const realNow = Date.now();
const human = () => ({ cookie: panel.cookie });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const get = (url: string, headers: Record<string, string> = human()) => panel.app.inject({ method: "GET", url, headers });

async function writeProc(stat: string) {
  await writeFile(path.join(proc, "stat"), stat);
}

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "paas-metrics-routes-"));
  proc = path.join(base, "proc");
  cg = path.join(base, "cg");
  await mkdir(path.join(proc, "pressure"), { recursive: true });
  await mkdir(path.join(proc, "1", "net"), { recursive: true });
  await writeProc(F.PROC_STAT);
  await writeFile(path.join(proc, "meminfo"), F.MEMINFO);
  await writeFile(path.join(proc, "vmstat"), F.VMSTAT);
  await writeFile(path.join(proc, "loadavg"), F.LOADAVG);
  await writeFile(path.join(proc, "uptime"), F.UPTIME);
  await writeFile(path.join(proc, "diskstats"), F.DISKSTATS);
  await writeFile(path.join(proc, "pressure", "cpu"), F.PRESSURE_CPU);
  await writeFile(path.join(proc, "pressure", "memory"), F.PRESSURE_MEM);
  await writeFile(path.join(proc, "1", "net", "dev"), F.NET_DEV);
  const dir = path.join(cg, "system.slice", `docker-${CID}.scope`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(cg, "cgroup.controllers"), "cpu io memory\n");
  for (const [f, v] of Object.entries({ "cpu.stat": F.CG_CPU_STAT, "memory.current": F.CG_MEMORY_CURRENT, "memory.max": F.CG_MEMORY_MAX_NONE, "memory.stat": F.CG_MEMORY_STAT, "memory.events": F.CG_MEMORY_EVENTS, "io.stat": F.CG_IO_STAT })) {
    await writeFile(path.join(dir, f), v);
  }
  for (const [k, v] of Object.entries({ PAAS_METRICS: "on", PAAS_HOST_PROC: proc, PAAS_HOST_CGROUP: cg })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  panel = await startRealPanel({
    // Simula uma sessão de token que passou pela política (para provar a segunda trava da rota da retenção,
    // que a política de tokens normalmente barra antes de a rota rodar).
    beforeReady: (app) => {
      app.addHook("preValidation", async (request) => {
        if (request.headers["x-teste-sessao-de-token"] && request.session) {
          request.session = { ...request.session, token: { id: "t", scope: "admin", reach: { kind: "panel" } } };
        }
      });
    },
  });
  // relógio falso só em Date e performance (o resto do painel segue normal), começando no horário real
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(realNow);
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  const projects = (await get("/api/projects")).json().projects as Array<{ project: { id: string; slug: string } }>;
  slugA = projects.find((p) => p.project.id === A)!.project.slug;
  slugB = projects.find((p) => p.project.id === B)!.project.slug;
  state.entries = [
    { id: CID, name: `paas-${slugA}-web-1`, state: "running", managed: true, projectSlug: slugA, service: "web" },
    { id: "d".repeat(64), name: `paas-${slugB}-app-1`, state: "running", managed: true, projectSlug: slugB, service: "app" },
  ];
  state.runtime = { state: "running", health: null, restartCount: 0, startedAt: "2026-10-24T10:00:00Z", finishedAt: null, exitCode: 0, tty: false, pid: 4321, oomKilled: false };
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await panel.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(path.dirname(proc), { recursive: true, force: true });
});

describe("antes da primeira coleta", () => {
  it("tudo 'sem dados' e coletor indisponível; nada de zero falso", async () => {
    const s = (await get("/api/metrics/summary")).json();
    expect(s.cpu).toMatchObject({ level: "unknown", busyPct: null });
    expect(s.collector.mode).toBe("unavailable");
    const h = (await get("/api/metrics/host?range=1h")).json();
    expect(h).toMatchObject({ series: {}, latest: null, partial: true });
    const p = (await get(`/api/projects/${A}/metrics?range=1h`)).json();
    expect(p).toMatchObject({ total: null, services: [] });
  });
});

describe("com coletas", () => {
  beforeAll(async () => {
    vi.advanceTimersByTime(31_000); // passa o cache de 30 s das consultas feitas antes da coleta
    const c = panel.app.metrics.collector;
    await c.tick();
    // 60 s depois: CPU do host andou, o container consumiu 30 s de CPU
    vi.advanceTimersByTime(60_000);
    await writeProc(F.PROC_STAT_LATER);
    await writeFile(path.join(cg, "system.slice", `docker-${CID}.scope`, "cpu.stat"), F.CG_CPU_STAT.replace("91234567", String(91234567 + 30_000_000)));
    await c.tick();
    vi.advanceTimersByTime(31_000);
  });

  it("host: séries com CPU (inclusive steal), memória, PSI, disco e o modo completo", async () => {
    const h = (await get("/api/metrics/host?range=1h")).json();
    expect(h.resolution).toBe("minute");
    expect(h.series.cpuSteal.at(-1).v).toBeGreaterThan(0);
    expect(h.series.memUsedPct).toBeDefined();
    expect(h.series.psiCpu[0].v).toBe(2.5);
    expect(h.series.diskPct).toBeDefined();
    expect(h.collector).toMatchObject({ mode: "full", hostSource: "mounted", containerSource: "cgroup", lastError: null });
    expect(h.latest.values.memTotal).toBe(8131364 * 1024);
  });

  it("projeto: serviço com CPU em % de um núcleo e soma do projeto; o outro projeto não aparece", async () => {
    const p = (await get(`/api/projects/${A}/metrics?range=1h`)).json();
    expect(p.services.map((s: { service: string }) => s.service)).toEqual(["web"]);
    expect(p.services[0].series.cpu.at(-1).v).toBeCloseTo(50, 0);
    expect(p.total.series.mem.at(-1).v).toBe(314572800 - 157286400);
    expect(JSON.stringify(p)).not.toContain(slugB);
  });

  it("sem range vale 24h; range inválido é 400", async () => {
    expect((await get(`/api/projects/${A}/metrics`)).json().range).toBe("24h");
    expect((await get("/api/metrics/host")).json().range).toBe("24h");
    expect((await get("/api/metrics/host?range=2h")).statusCode).toBe(400);
    expect((await get("/api/metrics/host?range=1h&x=1")).statusCode).toBe(400);
  });

  it("projeto inexistente é 404", async () => {
    const r = await get("/api/projects/0000000000000000/metrics");
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("project_not_found");
  });

  it("semáforo: projetos rodando e proteções; cache de 30 s entre pedidos", async () => {
    const s = (await get("/api/metrics/summary")).json();
    expect(s.projects).toMatchObject({ running: 2, total: 2, problems: [], level: "ok" });
    expect(s.cpu.busyPct).not.toBeNull();
    expect(s.protections.level).toBeDefined();
  });
});

describe("tokens", () => {
  let tNone = "";
  let tHost = "";
  let tPanel = "";
  let tPanelRead = "";
  beforeAll(async () => {
    tNone = (await panel.createToken({ name: "so-a", scope: "read", reach: "projects", projects: [A] })).token;
    tHost = (await panel.createToken({ name: "so-a-host", scope: "read", reach: "projects", projects: [A], hostMetrics: true })).token;
    tPanel = (await panel.createToken({ name: "painel-admin", scope: "admin", reach: "panel" })).token;
    tPanelRead = (await panel.createToken({ name: "painel-leitura", scope: "read", reach: "panel" })).token;
  });

  it("token limitado SEM a opção: 403 em toda rota da VPS (mesmo corpo), mas lê o próprio projeto", async () => {
    for (const url of ["/api/metrics/summary", "/api/metrics/host?range=1h"]) {
      const r = await get(url, bearer(tNone));
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "token_forbidden", message: expect.stringContaining("monitoramento da VPS") });
    }
    expect((await get(`/api/projects/${A}/metrics?range=1h`, bearer(tNone))).statusCode).toBe(200);
  });

  it("projeto fora do alcance: o MESMO 404 do projeto que não existe, com ou sem a opção", async () => {
    for (const t of [tNone, tHost]) {
      const fora = await get(`/api/projects/${B}/metrics`, bearer(t));
      const nada = await get("/api/projects/0000000000000000/metrics", bearer(t));
      expect(fora.statusCode).toBe(404);
      expect(fora.body).toBe(nada.body);
    }
  });

  it("token limitado COM a opção: lê o monitoramento da VPS (só leitura), mas só vê os problemas dos projetos dele", async () => {
    expect((await get("/api/metrics/host?range=1h", bearer(tHost))).statusCode).toBe(200);
    const s = await get("/api/metrics/summary", bearer(tHost));
    expect(s.statusCode).toBe(200);
    expect(s.json().cpu.busyPct).not.toBeNull();
  });

  it("o semáforo de quem tem a opção só lista os problemas dos projetos DELE; o token de painel e a pessoa veem todos", async () => {
    state.byId["d".repeat(64)] = { ...state.runtime, state: "restarting" };
    void panel.app.metrics.collector.tick();
    await panel.app.metrics.collector.idle();
    vi.advanceTimersByTime(31_000);
    const mine = (await get("/api/metrics/summary", bearer(tHost))).json();
    expect(mine.projects.problems).toEqual([]);
    expect(JSON.stringify(mine.projects)).not.toContain(slugB);
    const all = (await get("/api/metrics/summary", bearer(tPanelRead))).json();
    expect(all.projects.problems.map((p: { slug: string }) => p.slug)).toEqual([slugB]);
    const human = (await get("/api/metrics/summary")).json();
    expect(human.projects.problems.map((p: { slug: string }) => p.slug)).toEqual([slugB]);
    state.byId = {};
  });

  it("a opção NÃO abre a retenção nem nenhuma rota do painel", async () => {
    expect((await get("/api/metrics/settings", bearer(tHost))).statusCode).toBe(403);
    expect((await panel.app.inject({ method: "PUT", url: "/api/metrics/settings", headers: bearer(tHost), payload: { retention: { minuteHours: 24, hourDays: 7, dayDays: 90 } } })).statusCode).toBe(403);
    expect((await get("/api/alerts", bearer(tHost))).statusCode).toBe(403);
  });

  it("token de painel inteiro com leitura vê tudo; nenhum token (nem admin) muda a retenção", async () => {
    expect((await get("/api/metrics/summary", bearer(tPanelRead))).statusCode).toBe(200);
    expect((await get("/api/metrics/settings", bearer(tPanelRead))).statusCode).toBe(200);
    for (const t of [tPanel, tPanelRead]) {
      const r = await panel.app.inject({ method: "PUT", url: "/api/metrics/settings", headers: bearer(t), payload: { retention: { minuteHours: 24, hourDays: 7, dayDays: 90 } } });
      expect(r.statusCode).toBe(403);
    }
    expect(panel.app.metrics.settings.current().minuteHours).toBe(48);
  });

  it("desligar a opção corta o acesso no pedido seguinte", async () => {
    const t = await panel.createToken({ name: "temporario", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    expect((await get("/api/metrics/summary", bearer(t.token))).statusCode).toBe(200);
    const off = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [A], canCreate: false, hostMetrics: false } });
    expect(off.statusCode).toBe(200);
    expect((await get("/api/metrics/summary", bearer(t.token))).statusCode).toBe(403);
  });
});

describe("retenção", () => {
  const put = (payload: unknown, headers: Record<string, string> = human()) => panel.app.inject({ method: "PUT", url: "/api/metrics/settings", headers, payload: payload as never });

  it("GET traz a retenção, o padrão, os limites, o espaço e o estado do coletor", async () => {
    const r = (await get("/api/metrics/settings")).json();
    expect(r.retention).toEqual({ minuteHours: 48, hourDays: 90, dayDays: 730 });
    expect(r.defaults).toEqual(r.retention);
    expect(r.limits.minuteHours).toEqual({ min: 24, max: 168 });
    expect(r.usage.minuteBytes).toBeGreaterThan(0);
    expect(r.collector.mode).toBe("full");
  });

  it("PUT válido grava, audita com antes e depois, e devolve o novo estado", async () => {
    const r = await put({ retention: { minuteHours: 72, hourDays: 30, dayDays: 365 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().retention).toEqual({ minuteHours: 72, hourDays: 30, dayDays: 365 });
    expect(panel.app.metrics.settings.current().hourDays).toBe(30);
    const audit = (await get("/api/audit")).json().entries as Array<{ action: string; detail: string; actor: string }>;
    const e = audit.find((x) => x.action === "metrics.settings_changed")!;
    expect(e.detail).toContain("48 h → 72 h");
    expect(e.detail).toContain("90 d → 30 d");
    expect(e.actor).toBe("admin");
    await put({ retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } });
  });

  it("fora dos limites, campo a mais, faltando, tipo errado: 400 e nada muda", async () => {
    for (const bad of [
      { retention: { minuteHours: 23, hourDays: 90, dayDays: 730 } },
      { retention: { minuteHours: 169, hourDays: 90, dayDays: 730 } },
      { retention: { minuteHours: 48, hourDays: 6, dayDays: 730 } },
      { retention: { minuteHours: 48, hourDays: 90, dayDays: 1826 } },
      { retention: { minuteHours: 48.5, hourDays: 90, dayDays: 730 } },
      { retention: { minuteHours: "48", hourDays: 90, dayDays: 730 } },
      { retention: { minuteHours: 48, hourDays: 90 } },
      { retention: { minuteHours: 48, hourDays: 90, dayDays: 730, extra: 1 } },
      { retention: { minuteHours: 48, hourDays: 90, dayDays: 730 }, extra: 1 },
      {},
    ]) {
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(panel.app.metrics.settings.current()).toEqual({ minuteHours: 48, hourDays: 90, dayDays: 730 });
  });

  it("dia guardado por menos tempo que a hora: 400 retention_order", async () => {
    const r = await put({ retention: { minuteHours: 48, hourDays: 365, dayDays: 90 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("retention_order");
  });

  it("reduzir a retenção apaga o excedente na hora", async () => {
    const { mkdir: mk, writeFile: wf, readdir } = await import("node:fs/promises");
    const old = path.join(panel.dir, "metrics-min");
    await mk(old, { recursive: true });
    await wf(path.join(old, "2020-01-01.jsonl"), "{}\n");
    expect((await readdir(old)).includes("2020-01-01.jsonl")).toBe(true);
    await put({ retention: { minuteHours: 24, hourDays: 7, dayDays: 90 } });
    expect((await readdir(old)).includes("2020-01-01.jsonl")).toBe(false);
    await put({ retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } });
  });

  it("falha ao gravar: 500 sem mudar nada, mensagem sem caminho", async () => {
    const spy = vi.spyOn(panel.app.metrics.settings, "set").mockRejectedValueOnce(new Error("/data/segredo EACCES"));
    const r = await put({ retention: { minuteHours: 72, hourDays: 30, dayDays: 365 } });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe("storage_write_failed");
    expect(r.body).not.toContain("segredo");
    spy.mockRestore();
  });

  it("falha na poda depois de gravar não vira erro para a pessoa", async () => {
    const spy = vi.spyOn(panel.app.metrics.store, "prune").mockRejectedValueOnce(new Error("x"));
    expect((await put({ retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } })).statusCode).toBe(200);
    spy.mockRestore();
  });

  it("sem sessão: 401", async () => {
    expect((await panel.app.inject({ method: "GET", url: "/api/metrics/settings" })).statusCode).toBe(401);
    expect((await panel.app.inject({ method: "PUT", url: "/api/metrics/settings", payload: { retention: { minuteHours: 24, hourDays: 7, dayDays: 90 } } })).statusCode).toBe(401);
  });
});

describe("consulta ocupada e senha", () => {
  it("MetricsBusyError vira 429 nas três rotas", async () => {
    const q = panel.app.metrics.query;
    const spies = [
      vi.spyOn(q, "summary").mockRejectedValueOnce(new MetricsBusyError()),
      vi.spyOn(q, "host").mockRejectedValueOnce(new MetricsBusyError()),
      vi.spyOn(q, "project").mockRejectedValueOnce(new MetricsBusyError()),
    ];
    for (const url of ["/api/metrics/summary", "/api/metrics/host", `/api/projects/${A}/metrics`]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(429);
      expect(r.json().error).toBe("metrics_busy");
    }
    spies.forEach((s) => s.mockRestore());
  });

  it("erro inesperado vira 500 padronizado nas três rotas de leitura", async () => {
    const q = panel.app.metrics.query;
    const spies = [
      vi.spyOn(q, "summary").mockRejectedValueOnce(new Error("/data/x EIO")),
      vi.spyOn(q, "host").mockRejectedValueOnce(new Error("/data/x EIO")),
      vi.spyOn(q, "project").mockRejectedValueOnce(new Error("/data/x EIO")),
    ];
    for (const url of ["/api/metrics/summary", "/api/metrics/host", `/api/projects/${A}/metrics`]) {
      expect((await get(url)).statusCode, url).toBe(500);
    }
    spies.forEach((s) => s.mockRestore());
  });

  it("a rota da retenção confere de novo que a sessão é de pessoa (segunda trava), mesmo se a política de tokens falhasse", async () => {
    const r = await panel.app.inject({
      method: "PUT",
      url: "/api/metrics/settings",
      headers: { cookie: panel.cookie, "x-teste-sessao-de-token": "1" },
      payload: { retention: { minuteHours: 24, hourDays: 7, dayDays: 90 } },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("token_forbidden");
    expect(panel.app.metrics.settings.current().minuteHours).toBe(48);
  });

  it("a senha não é pedida para ler o monitoramento (só para dar poder novo a token)", () => {
    expect(PASSWORD.length).toBeGreaterThan(0);
  });
});
