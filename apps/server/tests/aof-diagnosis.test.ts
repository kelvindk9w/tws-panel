/**
 * aof-diagnosis.test.ts — a causa do ciclo de reinício pelo arquivo AOF do redis corrompido: só serviço de
 * projeto em ciclo é examinado; o motivo aparece no semáforo do Dashboard (aof_corrupt, crítico, com arquivo e
 * bytes) e no detalhe do alerta "reinicia sem parar"; leitura que falhou não apaga o que se sabia; custo por
 * volta limitado (leituras paralelas com teto, prazo total, cancelamento) e sem reler o que já se sabe.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT } from "@paas/core";
import { AOF_CONCURRENCY, AOF_LOG_TAIL, AOF_MAX_PER_TICK, AOF_RECHECK_SECONDS, AofDiagnoser, aofCauseText, inRestartLoop, recentLogReader } from "../src/services/aof-diagnosis.js";
import type { ContainerStatus, TickResult } from "../src/services/metrics-collector.js";
import { MetricsQuery } from "../src/services/metrics-query.js";
import { MetricsStore } from "../src/services/metrics-store.js";
import { ResourceWatcher } from "../src/services/metrics-watch.js";
import { removeDir } from "./helpers/tmp.js";

const T = 1_800_000_000;
const AOF_LINE =
  "1:M 14 Nov 2026 03:12:01.123 # Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725.          make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>.          Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 and restart the server.";

const cont = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64),
  name: "paas-loja-redis-1",
  slug: "loja",
  service: "redis",
  managed: true,
  state: "restarting",
  health: null,
  restartCount: 12,
  startedAt: null,
  exitCode: 1,
  oomKilled: false,
  restartsAt: [],
  oomAt: [],
  unhealthySince: null,
  ...over,
});

const tickOf = (containers: ContainerStatus[], over: Partial<TickResult> = {}): TickResult => ({ t: T, host: {}, containers, sample: { t: T, h: {}, c: {} }, dockerOk: true, ...over });
/** Volta `n` intervalos de releitura depois (o diagnóstico conhecido é relido). */
const later = (containers: ContainerStatus[], n: number, over: Partial<TickResult> = {}) => tickOf(containers, { t: T + n * AOF_RECHECK_SECONDS, ...over });

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("recentLogReader", () => {
  it("sem TTY: lê os quadros do Docker, tira o horário e as cores; pede só o fim do log", async () => {
    const logs = vi.fn(async () => ({ ok: true as const, body: frame(`2026-11-14T03:12:01.123456789Z \u001b[31m${AOF_LINE}\u001b[0m\n`) }));
    const read = recentLogReader({ inspect: async () => ({ tty: false }), logs });
    expect(await read("abc")).toEqual([AOF_LINE]);
    expect(logs).toHaveBeenCalledWith("abc", expect.objectContaining({ tail: AOF_LOG_TAIL, sinceSeconds: null }));
  });

  it("com TTY: texto cru", async () => {
    const read = recentLogReader({ inspect: async () => ({ tty: true }), logs: async () => ({ ok: true, body: Buffer.from("linha 1\nlinha 2\n") }) });
    expect(await read("abc", new AbortController().signal)).toEqual(["linha 1", "linha 2"]);
  });

  it("container que não responde ou log que não veio: null (não é 'sem problema')", async () => {
    expect(await recentLogReader({ inspect: async () => null, logs: async () => ({ ok: true, body: Buffer.alloc(0) }) })("abc")).toBeNull();
    expect(await recentLogReader({ inspect: async () => ({ tty: false }), logs: async () => ({ ok: false, reason: "unavailable" }) })("abc")).toBeNull();
  });
});

describe("inRestartLoop", () => {
  it("reiniciando agora ou mais de 3 reinícios em 15 min: em ciclo", () => {
    expect(inRestartLoop(cont(), T)).toBe(true);
    expect(inRestartLoop(cont({ state: "running", restartsAt: [T - 60, T - 120, T - 180, T - 240] }), T)).toBe(true);
  });
  it("rodando, ou poucos reinícios, ou reinícios antigos: não", () => {
    expect(inRestartLoop(cont({ state: "running" }), T)).toBe(false);
    expect(inRestartLoop(cont({ state: "running", restartsAt: [T - 60, T - 120, T - 180] }), T)).toBe(false);
    expect(inRestartLoop(cont({ state: "exited", restartsAt: [T - 2000, T - 2100, T - 2200, T - 2300] }), T)).toBe(false);
  });
});

describe("AofDiagnoser", () => {
  it("serviço em ciclo com a mensagem no log: a causa fica conhecida (container e projeto)", async () => {
    const logs = vi.fn(async () => ["* Server initialized", AOF_LINE]);
    const d = new AofDiagnoser({ logs });
    await d.observe(tickOf([cont()]));
    expect(d.forContainer("a".repeat(64))).toMatchObject({ engine: "redis", bytes: 1397, file: "appendonly.aof.27.incr.aof" });
    expect(d.forProject("loja")).toEqual([{ service: "redis", container: "paas-loja-redis-1", engine: "redis", kind: "format", file: "appendonly.aof.27.incr.aof", bytes: 1397 }]);
    expect(d.forProject("outro")).toEqual([]);
  });

  it("não examina o que não está em ciclo, nem container fora de projeto", async () => {
    const logs = vi.fn(async () => [AOF_LINE]);
    const d = new AofDiagnoser({ logs });
    await d.observe(tickOf([cont({ state: "running" }), cont({ id: "b".repeat(64), slug: null, managed: false }), cont({ id: "c".repeat(64), managed: false })]));
    expect(logs).not.toHaveBeenCalled();
    expect(d.forProject("loja")).toEqual([]);
  });

  it("log com outro motivo (ou o redis já pronto): sem causa; e a causa antiga sai", async () => {
    let lines = [AOF_LINE];
    const d = new AofDiagnoser({ logs: async () => lines });
    await d.observe(tickOf([cont()]));
    expect(d.forContainer("a".repeat(64))).not.toBeNull();
    lines = ["# Can't handle RDB format version 12", "# Fatal error loading the DB, check server logs. Exiting."];
    await d.observe(later([cont()], 1));
    expect(d.forContainer("a".repeat(64))).toBeNull();
  });

  it("saiu do ciclo ou sumiu: a causa sai", async () => {
    const d = new AofDiagnoser({ logs: async () => [AOF_LINE] });
    await d.observe(tickOf([cont()]));
    await d.observe(tickOf([cont({ state: "running" })]));
    expect(d.forContainer("a".repeat(64))).toBeNull();
    await d.observe(tickOf([cont()]));
    await d.observe(tickOf([]));
    expect(d.forProject("loja")).toEqual([]);
  });

  it("Docker sem resposta na volta, ou log que não pôde ser lido (null ou exceção): mantém o que se sabia", async () => {
    let mode: "ok" | "null" | "throw" = "ok";
    const msgs: string[] = [];
    const d = new AofDiagnoser({
      logs: async () => {
        if (mode === "throw") throw new Error("socket fechado");
        return mode === "null" ? null : [AOF_LINE];
      },
      log: (m) => msgs.push(m),
    });
    await d.observe(tickOf([cont()]));
    await d.observe(tickOf([], { dockerOk: false }));
    expect(d.forContainer("a".repeat(64))).not.toBeNull();
    mode = "null";
    await d.observe(later([cont()], 1));
    expect(d.forContainer("a".repeat(64))).not.toBeNull();
    mode = "throw";
    await d.observe(later([cont()], 2));
    expect(d.forContainer("a".repeat(64))).not.toBeNull();
    expect(msgs[0]).toContain("socket fechado");
    // sem `log`, a exceção também não escapa
    const quiet = new AofDiagnoser({ logs: async () => Promise.reject("texto") });
    await expect(quiet.observe(tickOf([cont()]))).resolves.toBeUndefined();
  });

  it("no máximo AOF_MAX_PER_TICK leituras por volta; volta cancelada para no meio", async () => {
    const logs = vi.fn(async () => [AOF_LINE]);
    const d = new AofDiagnoser({ logs });
    const many = Array.from({ length: AOF_MAX_PER_TICK + 3 }, (_, i) => cont({ id: i.toString(16).padStart(64, "0"), name: `paas-loja-r${i}-1`, service: `r${i}` }));
    await d.observe(tickOf(many));
    expect(logs).toHaveBeenCalledTimes(AOF_MAX_PER_TICK);
    expect(d.forProject("loja").map((f) => f.service).slice(0, 3)).toEqual(["r0", "r1", "r2"]);
    const ac = new AbortController();
    ac.abort();
    logs.mockClear();
    await d.observe(later(many, 1), ac.signal);
    expect(logs).not.toHaveBeenCalled();
  });

  it(`no máximo ${AOF_CONCURRENCY} leituras ao mesmo tempo, e o sinal chega à leitura`, async () => {
    let now = 0;
    let peak = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const d = new AofDiagnoser({
      logs: async (_id, signal) => {
        signals.push(signal);
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 5));
        now--;
        return [AOF_LINE];
      },
    });
    const many = Array.from({ length: AOF_MAX_PER_TICK }, (_, i) => cont({ id: i.toString(16).padStart(64, "0"), service: `r${i}` }));
    const ac = new AbortController();
    await d.observe(tickOf(many), ac.signal);
    expect(peak).toBe(AOF_CONCURRENCY);
    expect(signals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
    // cancelar quem chama cancela a leitura em andamento
    ac.abort();
    expect(signals.every((s) => s!.aborted)).toBe(true);
  });

  it("prazo total da volta: leitura que não volta é cancelada e a volta termina", async () => {
    const d = new AofDiagnoser({
      budgetMs: 20,
      logs: (_id, signal) => new Promise((resolve) => signal!.addEventListener("abort", () => resolve(null))),
    });
    const started = Date.now();
    await d.observe(tickOf([cont()]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d.forContainer("a".repeat(64))).toBeNull();
  });

  it("já diagnosticado: não relê no mesmo ciclo, só depois do intervalo de releitura", async () => {
    const logs = vi.fn(async () => [AOF_LINE]);
    const d = new AofDiagnoser({ logs });
    await d.observe(tickOf([cont({ restartCount: 1 })]));
    await d.observe(tickOf([cont({ restartCount: 2 })], { t: T + 60 }));
    await d.observe(tickOf([cont({ restartCount: 3 })], { t: T + AOF_RECHECK_SECONDS - 1 }));
    expect(logs).toHaveBeenCalledTimes(1);
    await d.observe(later([cont({ restartCount: 4 })], 1));
    expect(logs).toHaveBeenCalledTimes(2);
  });

  it("reparo feito (forget): a causa sai na hora e a próxima volta lê o log de novo", async () => {
    let lines = [AOF_LINE];
    const logs = vi.fn(async () => lines);
    const d = new AofDiagnoser({ logs });
    await d.observe(tickOf([cont()]));
    expect(d.forProject("loja")).toHaveLength(1);
    d.forget("a".repeat(64));
    expect(d.forContainer("a".repeat(64))).toBeNull();
    expect(d.forProject("loja")).toEqual([]);
    lines = ["* Server initialized", "* Ready to accept connections tcp"];
    await d.observe(tickOf([cont()], { t: T + 60 }));
    expect(logs).toHaveBeenCalledTimes(2);
    expect(d.forContainer("a".repeat(64))).toBeNull();
    d.forget("nao-existe");
  });

  it("lido sem achado: só relê depois de outra tentativa de subir", async () => {
    const logs = vi.fn(async () => ["# outro erro"]);
    const d = new AofDiagnoser({ logs });
    await d.observe(tickOf([cont({ restartCount: 5, startedAt: "a" })]));
    await d.observe(tickOf([cont({ restartCount: 5, startedAt: "a" })], { t: T + 60 }));
    expect(logs).toHaveBeenCalledTimes(1);
    await d.observe(tickOf([cont({ restartCount: 6, startedAt: "b" })], { t: T + 120 }));
    expect(logs).toHaveBeenCalledTimes(2);
    await d.observe(tickOf([cont({ restartCount: 6, startedAt: "b", restartsAt: [T + 170] })], { t: T + 180 }));
    expect(logs).toHaveBeenCalledTimes(3);
    // saiu do ciclo e voltou: lê de novo
    await d.observe(tickOf([cont({ state: "running", restartCount: 6, startedAt: "b", restartsAt: [] })], { t: T + 240 }));
    await d.observe(tickOf([cont({ restartCount: 6, startedAt: "b", restartsAt: [T + 170] })], { t: T + 300 }));
    expect(logs).toHaveBeenCalledTimes(4);
  });

  it("ordena por serviço e, no mesmo serviço, por container; sem serviço vale o nome do container", async () => {
    const d = new AofDiagnoser({ logs: async () => [AOF_LINE] });
    await d.observe(
      tickOf([
        cont({ id: "1".repeat(64), name: "paas-loja-cache-2", service: "cache" }),
        cont({ id: "2".repeat(64), name: "paas-loja-cache-1", service: "cache" }),
        cont({ id: "3".repeat(64), name: "avulso", service: null }),
      ]),
    );
    expect(d.forProject("loja").map((f) => f.container)).toEqual(["avulso", "paas-loja-cache-1", "paas-loja-cache-2"]);
  });
});

describe("aofCauseText", () => {
  it("redis com bytes; valkey sem bytes", () => {
    expect(aofCauseText({ engine: "redis", tool: "redis-check-aof", kind: "format", file: "x.aof.1.incr.aof", logDir: "appendonlydir", manifest: "x.aof.manifest", offset: 1, bytes: 1397 })).toContain(
      "arquivo de dados do redis (x.aof.1.incr.aof) ficou com o final corrompido (1397 bytes",
    );
    const v = aofCauseText({ engine: "valkey", tool: "valkey-check-aof", kind: "format", file: "x.aof.1.incr.aof", logDir: null, manifest: "x.aof.manifest", offset: null, bytes: null });
    expect(v).toContain("do valkey");
    expect(v).not.toContain("bytes no fim");
  });
});

describe("alerta 'reinicia sem parar' com a causa", () => {
  it("o detalhe diz que é o arquivo do redis e aponta o reparo; sem causa conhecida, aponta os logs", async () => {
    const create = vi.fn(async () => ({ alert: { id: "x" }, created: true }));
    const known = new Set(["a".repeat(64)]);
    const finding = new AofDiagnoser({ logs: async () => [AOF_LINE] });
    await finding.observe(tickOf([cont()]));
    const w = new ResourceWatcher({ create, resolve: async () => undefined, log: () => undefined, aof: (id) => (known.has(id) ? finding.forContainer(id) : null) });
    const loop = [T - 60, T - 120, T - 180, T - 240, T - 300];
    await w.evaluate(tickOf([cont({ restartsAt: loop }), cont({ id: "d".repeat(64), name: "paas-loja-web-1", service: "web", restartsAt: loop })]), []);
    const details = create.mock.calls.map((c) => (c as unknown as [{ title: string; detail: string }])[0]);
    const redis = details.find((x) => x.title === "loja/redis reinicia sem parar")!;
    expect(redis.detail).toContain("arquivo de dados do redis");
    expect(redis.detail).toContain("aba Recursos");
    expect(redis.detail).not.toContain("Veja a aba Logs");
    expect(details.find((x) => x.title === "loja/web reinicia sem parar")!.detail).toContain("Veja a aba Logs do projeto para saber o motivo.");
  });
});

describe("semáforo do Dashboard com a causa", () => {
  it("projeto com o redis em ciclo pelo AOF: motivo aof_corrupt, crítico, com serviço, arquivo e bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-aof-summary-"));
    try {
      const store = new MetricsStore({ dataDir: dir, retention: () => METRICS_RETENTION_DEFAULT });
      const d = new AofDiagnoser({ logs: async () => [AOF_LINE] });
      const tick = tickOf([cont(), cont({ id: "e".repeat(64), name: "paas-loja-web-1", service: "web", state: "running" }), cont({ id: "f".repeat(64), name: "paas-blog-web-1", slug: "blog", service: "web" })]);
      await d.observe(tick);
      const status = { mode: "full" as const, hostSource: "mounted" as const, containerSource: "cgroup" as const, lastTickAt: null, lastError: null, retention: METRICS_RETENTION_DEFAULT };
      const q = new MetricsQuery({ store, collector: { status: () => status, latest: () => tick }, aof: d, now: () => T * 1000 });
      const s = await q.summary({ protections: async () => ({ certificates: null, backups: null }), visible: null });
      const loja = s.projects.problems.find((p) => p.slug === "loja")!;
      expect(loja.reasons).toEqual(["aof_corrupt", "restarting"]);
      expect(loja.level).toBe("critical");
      expect(loja.aof).toEqual([{ service: "redis", container: "paas-loja-redis-1", engine: "redis", kind: "format", file: "appendonly.aof.27.incr.aof", bytes: 1397 }]);
      // o outro projeto reinicia por outro motivo (o log dele também tem a linha, mas é outro container: vale o diagnóstico por container)
      const blog = s.projects.problems.find((p) => p.slug === "blog")!;
      expect(blog.reasons).toContain("aof_corrupt");
      // sem diagnosticador (métricas antigas): nada muda
      const plain = new MetricsQuery({ store, collector: { status: () => status, latest: () => tick }, now: () => T * 1000 });
      const s2 = await plain.summary({ protections: async () => ({ certificates: null, backups: null }), visible: null });
      expect(s2.projects.problems.find((p) => p.slug === "loja")).not.toHaveProperty("aof");
      expect(s2.projects.problems.find((p) => p.slug === "loja")!.reasons).toEqual(["restarting"]);
    } finally {
      await removeDir(dir);
    }
  });
});
