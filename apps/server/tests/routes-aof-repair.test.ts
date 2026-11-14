/**
 * routes-aof-repair.test.ts — POST /api/projects/:id/aof-repair(/measure) no painel REAL (Docker em dublê no
 * serviço): sessão obrigatória, token só de escrita e só do projeto no alcance (fora dele, o mesmo 404 de
 * inexistente), corpo estrito (nenhum caminho, container ou campo a mais vindo do cliente), nomes maliciosos,
 * projeto/serviço inexistente e de outro projeto, um reparo por projeto de cada vez, a reserva do projeto
 * (deploy não começa durante o reparo; parar, iniciar e remover o projeto esperam), auditoria e limite de pedidos.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { AofRepairService, BACKUP_SCRIPT, MEASURE_SCRIPT } from "../src/services/aof-repair.js";
import type { AofHelperSpec } from "../src/services/aof-repair-docker.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

const AOF_LINE =
  "# Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725. make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>. Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 and restart the server.";
const analyzed = (d: number) => `AOF analyzed: filename=appendonly.aof.27.incr.aof, size=10, ok_up_to=1, ok_up_to_line=1, diff=${d}`;

let panel: RealPanel;
let A = "";
let B = "";
let slugA = "";
let slugB = "";
const MISSING = "0000000000000000";
const steps: string[] = [];
let gate: Promise<void> | null = null;

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Loja", "loja.example.com");
  B = await panel.createProject("Blog", "blog.example.com");
  slugA = (await panel.app.deployService.getProject(A))!.slug;
  slugB = (await panel.app.deployService.getProject(B))!.slug;
  const containers: DockerContainerInfo[] = [
    { id: "a".repeat(12), name: `paas-${slugA}-redis-1`, image: "redis:8", state: "restarting", status: "Restarting", managed: true, projectSlug: slugA, composeProject: `paas-${slugA}`, service: "redis", ports: [] },
    { id: "b".repeat(12), name: `paas-${slugB}-cache-1`, image: "redis:8", state: "restarting", status: "Restarting", managed: true, projectSlug: slugB, composeProject: `paas-${slugB}`, service: "cache", ports: [] },
  ];
  (panel.app as unknown as { aofRepair: AofRepairService }).aofRepair = new AofRepairService({
    listContainers: async () => {
      if (gate) await gate;
      return containers;
    },
    logs: async () => [AOF_LINE],
    docker: {
      inspect: async (id) => {
        const c = containers.find((x) => x.id === id)!;
        return {
          id: id.padEnd(64, id[0]),
          name: c.name,
          image: "sha256:" + "c".repeat(64),
          state: "restarting",
          labels: { "com.docker.compose.project": c.composeProject! },
          workingDir: "/data",
          argv: ["redis-server"],
          mounts: [{ type: "volume", name: `${c.composeProject}_redis`, source: "/v", destination: "/data", rw: true }],
        };
      },
      helper: async (spec: AofHelperSpec) => {
        const step = spec.script === MEASURE_SCRIPT ? "measure" : spec.script === BACKUP_SCRIPT ? "backup" : "fix";
        steps.push(step);
        if (step === "measure") return { code: 1, output: analyzed(1397), timedOut: false };
        if (step === "backup") return { code: 0, output: "copia feita\n", timedOut: false };
        return { code: 0, output: `${analyzed(1397)}\nContinue? [y/N]: Successfully truncated AOF appendonly.aof.27.incr.aof\n`, timedOut: false };
      },
      stop: async () => void steps.push("stop"),
      start: async () => void steps.push("start"),
    },
    hold: (id, reason) => panel.app.deployService.holdProject(id, reason),
    maintenance: (slug) => panel.app.deployService.holdMaintenance(slug),
    noteManualAction: () => undefined,
    stoppedByUser: async (id) => Boolean((await panel.app.deployService.getProject(id))?.stoppedAt),
    audit: (e) => panel.app.auditService.record(e),
    now: () => Date.UTC(2026, 10, 14, 3, 15, 9),
  });
}, 120_000);

afterAll(async () => {
  await panel.close();
});

// o limite de pedidos é por IP: cada pedido vem de um endereço próprio, menos no teste do limite
let nextIp = 0;
const post = (url: string, payload: unknown, headers: Record<string, string> = { cookie: panel.cookie }, ip = `203.0.113.${(nextIp++ % 200) + 20}`) =>
  panel.app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown>, remoteAddress: ip });

describe("POST /api/projects/:id/aof-repair", () => {
  it("sem sessão nem token: 401", async () => {
    expect((await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 1397 }, {})).statusCode).toBe(401);
    expect((await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" }, {})).statusCode).toBe(401);
    expect(steps).toEqual([]);
  });

  it("medir: devolve os bytes, nada parado", async () => {
    steps.length = 0;
    const res = await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: "redis", file: "appendonly.aof.27.incr.aof", bytes: 1397 });
    expect(steps).toEqual(["measure"]);
  });

  it("reparar: para, copia, corta, liga; resultado e auditoria", async () => {
    steps.length = 0;
    const res = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 1397 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: "repaired", backup: "appendonlydir.bak-20261114-031509", discardedBytes: 1397, restarted: true, keptStopped: false });
    expect(steps).toEqual(["measure", "stop", "backup", "fix", "start"]);
    await panel.app.auditService.flush?.();
    const audit = await panel.app.inject({ method: "GET", url: "/api/audit", headers: { cookie: panel.cookie } });
    expect(JSON.stringify(audit.json())).toContain("project.aof_repaired");
  });

  it("corte maior que o confirmado: 409 com os bytes medidos, nada parado", async () => {
    steps.length = 0;
    const res = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 100 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "aof_discard_exceeds", bytes: 1397 });
    expect(steps).toEqual(["measure"]);
  });

  it.each([
    ["caminho vindo do cliente", { service: "redis", maxBytes: 10, path: "/etc" }],
    ["container vindo do cliente", { service: "redis", maxBytes: 10, container: "a".repeat(12) }],
    ["serviço com barra", { service: "../redis", maxBytes: 10 }],
    ["serviço com shell", { service: "redis;rm", maxBytes: 10 }],
    ["serviço começando com hífen", { service: "-rf", maxBytes: 10 }],
    ["serviço longo demais", { service: "r".repeat(64), maxBytes: 10 }],
    ["sem maxBytes", { service: "redis" }],
    ["maxBytes zero", { service: "redis", maxBytes: 0 }],
    ["maxBytes fracionário", { service: "redis", maxBytes: 1.5 }],
    ["maxBytes em texto", { service: "redis", maxBytes: "1397" }],
    ["maxBytes acima do inteiro seguro", { service: "redis", maxBytes: 2 ** 60 }],
  ])("corpo inválido (%s): 400 e nada feito", async (_n, body) => {
    steps.length = 0;
    const res = await post(`/api/projects/${A}/aof-repair`, body);
    expect(res.statusCode).toBe(400);
    expect(steps).toEqual([]);
  });

  it("medir com campo a mais (caminho): 400", async () => {
    expect((await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis", dir: "/data" })).statusCode).toBe(400);
  });

  it("projeto inexistente: 404; serviço de outro projeto: 404 (o do projeto B não é alcançado pelo A)", async () => {
    steps.length = 0;
    expect((await post(`/api/projects/${MISSING}/aof-repair`, { service: "redis", maxBytes: 10 })).json()).toMatchObject({ error: "project_not_found" });
    const res = await post(`/api/projects/${A}/aof-repair`, { service: "cache", maxBytes: 5000 });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "service_not_found" });
    expect(steps).toEqual([]);
  });

  it("dois cliques: o segundo recebe 409 enquanto o primeiro roda; e o projeto fica reservado (deploy recusado)", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 5000 });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const second = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 5000 });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "aof_repair_in_progress" });
      expect(panel.app.deployService.intentOf(slugA)).toBe("maintenance");
      const deploy = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/deploy`, headers: { cookie: panel.cookie }, payload: {} });
      expect(deploy.statusCode).toBe(409);
      // parar, iniciar e remover o projeto (pelo id ou pelo slug) esperam o reparo: 409, nada feito
      const h = { cookie: panel.cookie };
      const ops = [
        await panel.app.inject({ method: "POST", url: `/api/projects/${A}/stop`, headers: h, remoteAddress: "203.0.113.201" }),
        await panel.app.inject({ method: "POST", url: `/api/projects/${slugA}/start`, headers: h, remoteAddress: "203.0.113.202" }),
        await panel.app.inject({ method: "DELETE", url: `/api/projects/${A}`, headers: h, remoteAddress: "203.0.113.203" }),
      ];
      for (const op of ops) {
        expect(op.statusCode).toBe(409);
        expect(op.json()).toMatchObject({ error: "aof_repair_in_progress" });
      }
      expect(await panel.app.deployService.getProject(A)).not.toBeNull();
      // a trava é deste projeto só (sem chamar o Docker do outro)
      expect((panel.app as unknown as { aofRepair: AofRepairService }).aofRepair.isBusy(B)).toBe(false);
    } finally {
      gate = null;
      release();
    }
    expect((await first).statusCode).toBe(200);
    expect(panel.app.deployService.intentOf(slugA)).toBeNull();
  });
});

describe("parar, iniciar e remover que começaram antes do reparo", () => {
  const h = () => ({ cookie: panel.cookie });

  it.each([
    ["parar", "stop", "POST", (id: string) => `/api/projects/${id}/stop`],
    ["iniciar", "start", "POST", (id: string) => `/api/projects/${id}/start`],
    ["remover", "deleteProject", "DELETE", (id: string) => `/api/projects/${id}`],
  ] as const)("%s em curso: medir e reparar recusam com 409 aof_project_busy; terminado, o reparo volta a ser possível", async (_n, method, verb, url) => {
    let release!: () => void;
    const gateOp = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(panel.app.deployService, method).mockImplementation(async () => {
      await gateOp;
    });
    steps.length = 0;
    try {
      const op = panel.app.inject({ method: verb, url: url(A), headers: h(), remoteAddress: "203.0.113.211" });
      await new Promise((r) => setTimeout(r, 30));
      const m = await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" });
      expect(m.statusCode).toBe(409);
      expect(m.json()).toMatchObject({ error: "aof_project_busy" });
      const rp = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 5000 });
      expect(rp.json()).toMatchObject({ error: "aof_project_busy" });
      expect(steps).toEqual([]);
      release();
      expect((await op).statusCode).toBe(200);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" })).statusCode).toBe(200);
  });

  it("parar que falhou também desmarca o projeto", async () => {
    const spy = vi.spyOn(panel.app.deployService, "stop").mockRejectedValueOnce(Object.assign(new Error("Nenhum container"), { statusCode: 409, code: "no_containers" }));
    try {
      const op = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/stop`, headers: h(), remoteAddress: "203.0.113.212" });
      expect(op.statusCode).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect((await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" })).statusCode).toBe(200);
  });
});

describe("token de API", () => {
  it("token de leitura: 403 (reparar é escrita)", async () => {
    const t = await panel.createToken({ name: "leitura", scope: "read", reach: "panel" });
    const res = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 5000 }, { authorization: `Bearer ${t.token}` });
    expect(res.statusCode).toBe(403);
  });

  it("token de escrita limitado ao projeto A: repara A; B e inexistente dão o MESMO 404", async () => {
    const t = await panel.createToken({ name: "so-a", scope: "write", reach: "projects", projects: [A] });
    const h = { authorization: `Bearer ${t.token}` };
    expect((await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" }, h)).statusCode).toBe(200);
    const outro = await post(`/api/projects/${B}/aof-repair`, { service: "cache", maxBytes: 5000 }, h);
    const nenhum = await post(`/api/projects/${MISSING}/aof-repair`, { service: "cache", maxBytes: 5000 }, h);
    expect(outro.statusCode).toBe(404);
    expect(outro.body).toBe(nenhum.body);
  });
});

describe("limite de pedidos", () => {
  it("a 11ª medição no mesmo minuto leva 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(`/api/projects/${B}/aof-repair/measure`, { service: "cache" }, { cookie: panel.cookie }, "198.51.100.7")).statusCode);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("aba Recursos e erros do Docker", () => {
  it("as medidas do projeto trazem a lista de serviços em ciclo pelo AOF (vazia sem diagnóstico)", async () => {
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/metrics?range=1h`, headers: { cookie: panel.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().aof).toEqual([]);
  });

  it("Docker fora do ar: 503 docker_unavailable; erro inesperado: 500 (tratador padrão)", async () => {
    const real = panel.app.aofRepair;
    const { DockerUnavailableError } = await import("../src/services/docker-service.js");
    try {
      (panel.app as unknown as { aofRepair: unknown }).aofRepair = {
        measure: async () => {
          throw new DockerUnavailableError("sem socket");
        },
        repair: async () => {
          throw new Error("quebrou");
        },
      };
      const a = await post(`/api/projects/${A}/aof-repair/measure`, { service: "redis" });
      expect(a.statusCode).toBe(503);
      expect(a.json()).toMatchObject({ error: "docker_unavailable" });
      const b = await post(`/api/projects/${A}/aof-repair`, { service: "redis", maxBytes: 10 });
      expect(b.statusCode).toBe(500);
      expect((await post(`/api/projects/${MISSING}/aof-repair/measure`, { service: "redis" })).statusCode).toBe(404);
    } finally {
      (panel.app as unknown as { aofRepair: unknown }).aofRepair = real;
    }
  });
});
