/**
 * routes-metrics-vazio.test.ts — o painel ainda sem nenhuma coleta (recém-instalado,
 * ou PAAS_METRICS=off): tudo aparece como "sem dados" e o coletor como indisponível.
 * Nunca um zero inventado, nunca um selo verde por falta de dado.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const get = (url: string) => panel.app.inject({ method: "GET", url, headers: { cookie: panel.cookie } });

beforeAll(async () => {
  panel = await startRealPanel(); // PAAS_METRICS=off nos testes: o coletor nunca roda
  A = await panel.createProject("Fazenda", "fazenda.example.com");
}, 120_000);
afterAll(async () => panel.close());

describe("antes da primeira coleta", () => {
  it("resumo: tudo 'sem dados' e coletor indisponível", async () => {
    const s = (await get("/api/metrics/summary")).json();
    expect(s.cpu).toMatchObject({ level: "unknown", busyPct: null });
    for (const k of ["memory", "disk", "network", "projects"]) expect(s[k].level, k).toBe("unknown");
    expect(s.collector).toMatchObject({ mode: "unavailable", lastTickAt: null });
  });

  it("host e projeto: séries vazias, parciais, sem 'agora'", async () => {
    const h = (await get("/api/metrics/host?range=1h")).json();
    expect(h).toMatchObject({ series: {}, latest: null, partial: true });
    const p = (await get(`/api/projects/${A}/metrics?range=1h`)).json();
    expect(p).toMatchObject({ total: null, services: [], events: [], partial: true });
  });

  it("configurações: retenção padrão e nenhum byte ocupado", async () => {
    const r = (await get("/api/metrics/settings")).json();
    expect(r.retention).toEqual(r.defaults);
    expect(r.usage).toEqual({ minuteBytes: 0, hourBytes: 0, dayBytes: 0 });
    expect(r.collector.mode).toBe("unavailable");
  });
});
