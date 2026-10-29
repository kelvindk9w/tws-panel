import { describe, expect, it } from "vitest";
import type { DeployJob, DeployJobStep, StartupRecord } from "@paas/core";
import {
  DEPLOY_HISTORY_PER_PROJECT_DEFAULT,
  DEPLOY_HISTORY_PER_PROJECT_LIMITS,
  DEPLOY_HISTORY_TOTAL_DEFAULT,
  STARTUP_ATTACH_GRACE_MS,
  advanceSteps,
  attachStartups,
  finishSteps,
  trimJobs,
  validJob,
} from "../src/services/deploy-jobs.js";

let seq = 0;
const job = (projectId: string, over: Partial<DeployJob> = {}): DeployJob => ({
  id: `j${++seq}`,
  projectId,
  status: "success",
  createdAt: "2026-10-27T10:00:00.000Z",
  startedAt: "2026-10-27T10:00:00.000Z",
  finishedAt: "2026-10-27T10:01:00.000Z",
  steps: [],
  log: "",
  error: null,
  ...over,
});
const many = (projectId: string, n: number) => Array.from({ length: n }, () => job(projectId));

describe("histórico de deploys: teto por projeto", () => {
  it("projeto movimentado perde só o PRÓPRIO histórico antigo; o dos outros fica intacto (antes o teto geral de 100 apagava de todos)", () => {
    const quiet = many("quieto", 3);
    const busy = many("ocupado", 12);
    const all = [...quiet.slice(0, 1), ...busy.slice(0, 6), ...quiet.slice(1), ...busy.slice(6)];
    const out = trimJobs(all, { perProject: 5, total: 1000 });
    expect(out.filter((j) => j.projectId === "quieto")).toEqual(quiet);
    expect(out.filter((j) => j.projectId === "ocupado")).toEqual(busy.slice(-5));
    // ordem original preservada
    expect(out).toEqual(all.filter((j) => out.includes(j)));
  });

  it("nada a cortar devolve a MESMA lista (sem regravar à toa)", () => {
    const all = [...many("a", 3), ...many("b", 3)];
    expect(trimJobs(all, { perProject: 10, total: 100 })).toBe(all);
  });

  it("migração: o arquivo antigo (até 100 deploys no total) cabe inteiro no padrão novo, sem perda", () => {
    const old = [...many("a", 60), ...many("b", 40)];
    expect(trimJobs(old, { perProject: DEPLOY_HISTORY_PER_PROJECT_DEFAULT, total: DEPLOY_HISTORY_TOTAL_DEFAULT })).toBe(old);
  });

  it("deploy em andamento nunca é cortado, mesmo acima do teto", () => {
    const running = job("a", { status: "running", finishedAt: null });
    const all = [running, ...many("a", 6)];
    const out = trimJobs(all, { perProject: 3, total: 1000 });
    expect(out).toContain(running);
    expect(out.filter((j) => j.projectId === "a").length).toBe(3); // o em andamento fica e conta no teto
  });

  it("teto geral de segurança: tira o mais antigo do projeto que mais tem, até caber", () => {
    const all = [...many("a", 10), ...many("b", 4), ...many("c", 2)];
    const out = trimJobs(all, { perProject: 100, total: 12 });
    expect(out).toHaveLength(12);
    const count = (id: string) => out.filter((j) => j.projectId === id).length;
    expect(count("c")).toBe(2);
    expect(count("b")).toBe(4);
    expect(count("a")).toBe(6);
  });

  it("teto geral com só deploy em andamento: para sem laço infinito", () => {
    const all = Array.from({ length: 5 }, () => job("a", { status: "queued", finishedAt: null }));
    expect(trimJobs(all, { perProject: 100, total: 2 })).toHaveLength(5);
  });
});

describe("tamanho do log guardado", () => {
  const big = (projectId: string, n: number) => Array.from({ length: n }, (_, i) => job(projectId, { log: `${i}`.padEnd(400_000, "x") }));
  it("1100 deploys de 400 KB: só os 20 mais recentes de cada projeto ficam com log inteiro e o total respeita o teto", () => {
    const all = big("a", 1100);
    const out = trimJobs(all, { perProject: 1100, total: 1100, logChars: 20_000_000 });
    expect(out.reduce((n, j) => n + j.log.length, 0)).toBeLessThanOrEqual(20_000_000);
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]).toBe(all[all.length - 1]); // o mais recente intacto
  });
  it("além dos 20 mais recentes o log vira o final com aviso; metadados e quantidade seguem", () => {
    const all = big("a", 30);
    const out = trimJobs(all, { perProject: 100, total: 1000 });
    expect(out).toHaveLength(30);
    expect(out.slice(-20).every((j, i) => j === all[10 + i])).toBe(true);
    for (const j of out.slice(0, 10)) {
      expect(j.log.length).toBeLessThan(13_000);
      expect(j.log.startsWith("[…")).toBe(true);
      expect(j.log.endsWith("x")).toBe(true);
    }
    expect(out[0]!.id).toBe(all[0]!.id);
  });
  it("deploy em andamento nunca é reduzido; sem mudança devolve a mesma lista; log curto não ganha aviso", () => {
    const running = job("a", { status: "running", finishedAt: null, log: "y".repeat(50_000) });
    const old = Array.from({ length: 25 }, () => job("a", { log: "curto" }));
    const all = [running, ...old];
    expect(trimJobs(all, { perProject: 100, total: 1000 })).toBe(all);
    const mixed = [job("a", { status: "running", finishedAt: null, log: "y".repeat(50_000) }), ...many("a", 25)];
    expect(trimJobs(mixed, { perProject: 100, total: 1000 })[0]!.log).toHaveLength(50_000);
  });
  it("teto de caracteres muito apertado: tira deploys inteiros, do mais antigo, e pula o que está em andamento", () => {
    const running = job("a", { status: "running", finishedAt: null, log: "r".repeat(2000) });
    const all = [running, ...Array.from({ length: 6 }, () => job("a", { log: "z".repeat(5000) }))];
    const out = trimJobs(all, { perProject: 100, total: 1000, logChars: 3500, tailChars: 1000 });
    expect(out[0]).toBe(running);
    expect(out.reduce((n, j) => n + j.log.length, 0)).toBeLessThanOrEqual(3500);
    expect(out.length).toBeLessThan(all.length);
    expect(out[out.length - 1]!.id).toBe(all[6]!.id);
  });
  it("validJob descarta null, texto, objeto sem log ou sem id", () => {
    expect(validJob(job("a"))).toBe(true);
    for (const bad of [null, "x", 3, {}, { ...job("a"), log: undefined }, { ...job("a"), id: 1 }, { ...job("a"), projectId: null }]) expect(validJob(bad)).toBe(false);
  });
  it("teto de caracteres apertado: reduz os antigos e, por fim, tira os deploys mais antigos", () => {
    const all = Array.from({ length: 6 }, () => job("a", { log: "z".repeat(5000) }));
    const out = trimJobs(all, { perProject: 100, total: 1000, logChars: 12_000, tailChars: 1000, fullLogs: 20 });
    expect(out.reduce((n, j) => n + j.log.length, 0)).toBeLessThanOrEqual(12_000);
    expect(out[out.length - 1]).toBe(all[5]);
  });
});

describe("horários das etapas", () => {
  const steps = (): DeployJobStep[] => [
    { name: "A", status: "running", startedAt: "t0" },
    { name: "B", status: "skipped" },
    { name: "C", status: "skipped" },
  ];
  it("avançar a etapa registra início da nova e fim da anterior, sem sobrescrever horários que já existem", () => {
    const s1 = advanceSteps(steps(), 1, "t1");
    expect(s1).toEqual([
      { name: "A", status: "done", startedAt: "t0", finishedAt: "t1" },
      { name: "B", status: "running", startedAt: "t1" },
      { name: "C", status: "skipped" },
    ]);
    const s2 = advanceSteps(s1, 2, "t2");
    expect(s2[0]).toEqual({ name: "A", status: "done", startedAt: "t0", finishedAt: "t1" });
    expect(s2[1]).toEqual({ name: "B", status: "done", startedAt: "t1", finishedAt: "t2" });
    expect(s2[2]).toEqual({ name: "C", status: "running", startedAt: "t2" });
    // repetir o mesmo marco não muda nada
    expect(advanceSteps(s2, 2, "t9")).toEqual(s2);
  });
  it("etapa pulada direto (marco 3 sem passar pelo 2) ganha início e fim no mesmo instante", () => {
    const s = advanceSteps(steps(), 2, "t5");
    expect(s[1]).toEqual({ name: "B", status: "done", startedAt: "t5", finishedAt: "t5" });
  });
  it("fim do deploy fecha só a que está rodando: concluída em sucesso, falha em erro", () => {
    const base = advanceSteps(steps(), 1, "t1");
    expect(finishSteps(base, true, "t9")[1]).toEqual({ name: "B", status: "done", startedAt: "t1", finishedAt: "t9" });
    expect(finishSteps(base, false, "t9")[1]).toMatchObject({ status: "failed", finishedAt: "t9" });
    expect(finishSteps(base, false, "t9")[0]).toBe(base[0]);
    expect(finishSteps(base, false, "t9")[2]).toBe(base[2]);
  });
});

describe("tempo de subida ligado ao deploy", () => {
  const rec = (service: string, startedAt: string, seconds: number, approx = false): StartupRecord => ({ slug: "loja", service, startedAt, readyAt: startedAt, seconds, via: "health", approx });
  const j = job("p", { startedAt: "2026-10-27T10:00:00.000Z", finishedAt: "2026-10-27T10:02:00.000Z" });

  it("liga containers que começaram durante o deploy ou logo depois; o mais lento de cada serviço representa as réplicas", () => {
    const [out] = attachStartups(
      [j],
      [rec("web", "2026-10-27T10:01:00.000Z", 5), rec("web", "2026-10-27T10:01:10.000Z", 9, true), rec("api", "2026-10-27T10:05:00.000Z", 3), rec("velho", "2026-10-27T09:59:59.000Z", 1), rec("tarde", "2026-10-27T10:13:00.000Z", 1)],
      Date.parse("2026-10-27T11:00:00.000Z"),
    );
    expect(out!.startups).toEqual([
      { service: "api", seconds: 3, via: "health", approx: false },
      { service: "web", seconds: 9, via: "health", approx: true },
    ]);
  });

  it("deploy em andamento vale até agora; sem medida ou sem horário de início, o deploy fica como está", () => {
    const running = job("p", { status: "running", finishedAt: null });
    const now = Date.parse("2026-10-27T10:03:00.000Z");
    expect(attachStartups([running], [rec("web", "2026-10-27T10:02:00.000Z", 4)], now)[0]!.startups).toHaveLength(1);
    expect(attachStartups([running], [rec("web", "2026-10-27T10:05:00.000Z", 4)], now)[0]).toBe(running);
    const noStart = job("p", { startedAt: null });
    expect(attachStartups([noStart], [rec("web", "2026-10-27T10:00:00.000Z", 4)], now)[0]).toBe(noStart);
    expect(attachStartups([j], [rec("web", "lixo", 4)], now)[0]).toBe(j);
    expect(STARTUP_ATTACH_GRACE_MS).toBe(600_000);
  });
});
