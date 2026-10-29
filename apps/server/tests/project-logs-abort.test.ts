/**
 * project-logs-abort.test.ts — cancelamento: pedidos abertos e fechados em
 * sequência não empilham leituras no Docker; o sinal chega às chamadas (ps,
 * inspect, logs); o trabalho confere o sinal entre etapas e na máscara; falha
 * depois do abort não vira rejeição sem tratamento; o cliente HTTP do Docker e
 * o `docker ps` param de verdade.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { dockerInspect, dockerLogs, type DockerLogsResult } from "../src/services/docker-logs.js";
import { MAX_ACTIVE_READS, ProjectLogsService, type ProjectLogsDeps } from "../src/services/project-logs.js";

const project = { slug: "fazenda" };
const NOW = Date.parse("2026-10-24T12:00:00Z");

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function container(i: number): DockerContainerInfo {
  const service = `s${String(i).padStart(2, "0")}`;
  return {
    id: i.toString(16).padStart(12, "0"),
    name: `paas-fazenda-${service}-1`,
    image: "img",
    state: "running",
    status: "Up",
    managed: true,
    projectSlug: "fazenda",
    composeProject: "paas-fazenda",
    service,
    health: null,
    ports: [],
  };
}

const RUNTIME = { state: "running", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: 0, tty: false } as const;
const tick = () => new Promise((r) => setTimeout(r, 5));

function make(n: number, over: Partial<ProjectLogsDeps> = {}) {
  return new ProjectLogsService({
    listContainers: async () => Array.from({ length: n }, (_v, i) => container(i)),
    inspect: async () => ({ ...RUNTIME }),
    logs: async (): Promise<DockerLogsResult> => ({ ok: true, body: frame("2026-10-24T11:00:00Z oi\n") }),
    now: () => NOW,
    ...over,
  });
}

describe("pedidos abortados não furam o limite de leituras", () => {
  it("20 pedidos abertos e fechados em sequência nunca passam de 6 leituras simultâneas no Docker", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const svc = make(1, {
      logs: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise<DockerLogsResult>((resolve) =>
          releases.push(() => {
            inFlight--;
            resolve({ ok: true, body: Buffer.alloc(0) });
          }),
        );
      },
    });
    const outcomes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      const ac = new AbortController();
      const p = svc.read(project, {}, [], { actor: `t${i}`, human: true, signal: ac.signal }).catch((e: { statusCode?: number }) => e.statusCode);
      outcomes.push(p);
      await tick();
      ac.abort();
    }
    await tick();
    expect(peak).toBeLessThanOrEqual(MAX_ACTIVE_READS);
    releases.splice(0).forEach((r) => r());
    const results = await Promise.all(outcomes);
    // os 6 primeiros foram aceitos e cancelados (499); o resto levou 429 sem começar a ler
    expect(results.filter((c) => c === 499)).toHaveLength(MAX_ACTIVE_READS);
    expect(results.filter((c) => c === 429)).toHaveLength(20 - MAX_ACTIVE_READS);
    // terminado o trabalho, as vagas voltaram
    await tick();
    await expect(make(1).read(project, {}, [], { actor: "t0" })).resolves.toBeTruthy();
  });
});

describe("o sinal chega às chamadas e o trabalho confere o sinal", () => {
  it("listContainers, inspect e logs recebem o sinal do pedido", async () => {
    const ac = new AbortController();
    const listContainers = vi.fn(async (_ms?: number, _s?: AbortSignal) => [container(0)]);
    const inspect = vi.fn(async (_id: string, _ms?: number, _s?: AbortSignal) => ({ ...RUNTIME }));
    const logs = vi.fn(async (_id: string, _o: { tail: number; sinceSeconds: number | null; signal?: AbortSignal }): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(0) }));
    await make(1, { listContainers, inspect, logs }).read(project, {}, [], { signal: ac.signal });
    expect(listContainers.mock.calls[0]![1]).toBe(ac.signal);
    expect(inspect.mock.calls[0]![2]).toBe(ac.signal);
    expect(logs.mock.calls[0]![1].signal).toBe(ac.signal);
  });

  it("abortou durante o inspect: a leitura dos logs desse container nem começa", async () => {
    const ac = new AbortController();
    const logs = vi.fn(async (): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(0) }));
    const svc = make(1, {
      inspect: async () => {
        ac.abort();
        return { ...RUNTIME };
      },
      logs,
    });
    await expect(svc.read(project, {}, [], { signal: ac.signal })).rejects.toMatchObject({ statusCode: 499 });
    await tick();
    expect(logs).not.toHaveBeenCalled();
  });

  it("abortou com containers na fila: os que ainda não começaram nem são consultados", async () => {
    const ac = new AbortController();
    const inspect = vi.fn(async () => {
      ac.abort();
      return { ...RUNTIME };
    });
    const svc = make(12, { inspect });
    await expect(svc.read(project, {}, [], { signal: ac.signal })).rejects.toMatchObject({ statusCode: 499 });
    await tick();
    // só os 4 primeiros (já em andamento) chegaram ao inspect
    expect(inspect.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("abortou durante a leitura dos logs: a máscara nem começa", async () => {
    const ac = new AbortController();
    let clockCalls = 0;
    let atAbort = -1;
    const svc = make(1, {
      clock: () => {
        clockCalls++;
        return 0;
      },
      logs: async () => {
        atAbort = clockCalls;
        ac.abort();
        return { ok: true, body: frame("2026-10-24T11:00:00Z uma linha\n") };
      },
    });
    await expect(svc.read(project, {}, ["segredo-qualquer-1"], { signal: ac.signal })).rejects.toMatchObject({ statusCode: 499 });
    await tick();
    expect(clockCalls).toBe(atAbort);
  });

  it("abortou no meio da máscara: ela para na linha seguinte", async () => {
    const ac = new AbortController();
    let masking = 0;
    const lines = Array.from({ length: 50 }, (_v, i) => `2026-10-24T11:00:${String(i).padStart(2, "0")}Z linha ${i}\n`).join("");
    const svc = make(1, {
      clock: () => {
        masking++;
        // 1ª chamada: prazo; 2ª: início da máscara; 3ª em diante: uma por linha
        if (masking === 5) ac.abort();
        return 0;
      },
      logs: async () => ({ ok: true, body: frame(lines) }),
    });
    await expect(svc.read(project, {}, [], { signal: ac.signal })).rejects.toMatchObject({ statusCode: 499 });
    await tick();
    expect(masking).toBeLessThan(10);
  });
});

describe("falha depois do abort não vira rejeição sem tratamento", () => {
  const seen: unknown[] = [];
  const onRej = (e: unknown) => seen.push(e);
  afterEach(() => process.off("unhandledRejection", onRej));

  it("o Docker falha depois de o cliente ir embora: nenhuma unhandledRejection", async () => {
    process.on("unhandledRejection", onRej);
    seen.length = 0;
    const ac = new AbortController();
    let fail: (e: Error) => void = () => undefined;
    const svc = make(1, {
      logs: () =>
        new Promise<DockerLogsResult>((_resolve, reject) => {
          fail = reject;
        }),
    });
    const p = svc.read(project, {}, [], { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ statusCode: 499 });
    fail(new Error("docker caiu depois do abort"));
    await tick();
    await tick();
    expect(seen).toEqual([]);
    // a vaga voltou mesmo com a falha
    await expect(make(1).read(project, {}, [], { actor: "anon" })).resolves.toBeTruthy();
  });
});

describe("cliente HTTP do Docker e docker ps", () => {
  let tmp = "";
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tmp = "";
  });

  async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
    tmp = await mkdtemp(path.join(tmpdir(), "paas-abort-"));
    const socket = path.join(tmp, "d.sock");
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(socket, r));
    return socket;
  }

  it("dockerLogs: abortar derruba a requisição ao Docker na hora", async () => {
    let closed = false;
    let arrived = false;
    const socket = await listen((req) => {
      arrived = true;
      req.socket.on("close", () => (closed = true));
    });
    const ac = new AbortController();
    const p = dockerLogs(socket, "0123456789ab", { tail: 5, sinceSeconds: null, signal: ac.signal });
    // só aborta depois de o pedido chegar ao servidor falso (senão o ouvinte de close nem existe)
    for (let i = 0; i < 300 && !arrived; i++) await new Promise((r) => setTimeout(r, 10));
    expect(arrived).toBe(true);
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: "unavailable" });
    // o servidor percebe o fechamento da conexão (espera folgada, sem depender de um número de ciclos)
    for (let i = 0; i < 200 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
  });

  it("dockerLogs e dockerInspect com sinal já abortado não chegam a pedir nada", async () => {
    let hits = 0;
    const socket = await listen((_req, res) => {
      hits++;
      res.end("{}");
    });
    const ac = new AbortController();
    ac.abort();
    expect(await dockerLogs(socket, "0123456789ab", { tail: 5, sinceSeconds: null, signal: ac.signal })).toEqual({ ok: false, reason: "unavailable" });
    expect(await dockerInspect(socket, "0123456789ab", 5000, ac.signal)).toBeNull();
    await tick();
    expect(hits).toBe(0);
  });

  it("dockerInspect: abortar durante a espera devolve null na hora", async () => {
    const socket = await listen(() => undefined);
    const ac = new AbortController();
    const p = dockerInspect(socket, "0123456789ab", 5000, ac.signal);
    await tick();
    const t0 = Date.now();
    ac.abort();
    expect(await p).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("listContainers: abortar mata o `docker ps` pendurado (rejeita rápido)", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "paas-fakedocker-"));
    await writeFile(path.join(tmp, "docker"), "#!/bin/sh\nexec sleep 5\n");
    await chmod(path.join(tmp, "docker"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${tmp}:${old}`;
    try {
      const real = await vi.importActual<typeof import("../src/services/docker-service.js")>("../src/services/docker-service.js");
      const ac = new AbortController();
      const t0 = Date.now();
      const p = real.listContainers("/nonexistent.sock", 60_000, ac.signal);
      setTimeout(() => ac.abort(), 100);
      await expect(p).rejects.toBeInstanceOf(real.DockerUnavailableError);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      process.env.PATH = old;
    }
  });
});
