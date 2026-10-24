/**
 * project-logs-limits.test.ts — limites do pedido de logs: concorrência por
 * pedido, pedidos simultâneos (429), total de bytes, prazo total, orçamento da
 * máscara, corte da linha crua e fronteiras exatas (40 serviços, 1.000.000
 * caracteres, slug por prefixo). Docker em dublê; relógio injetado.
 */
import { describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import type { ContainerRuntime, DockerLogsResult } from "../src/services/docker-logs.js";
import { LOG_MASK } from "../src/services/log-mask.js";
import {
  CALL_TIMEOUT_MS,
  LOG_CONCURRENCY,
  LOG_OMITTED,
  MASK_BUDGET_MS,
  MAX_ACTIVE_READS,
  MAX_READS_PER_ACTOR,
  MAX_TOKEN_READS,
  MAX_LOG_SERVICES,
  MAX_MASK_CHARS,
  MAX_RESPONSE_CHARS,
  MAX_TOTAL_BYTES,
  RAW_LINE_MAX,
  TOTAL_DEADLINE_MS,
  ProjectLogsService,
  type ProjectLogsDeps,
} from "../src/services/project-logs.js";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const project = { slug: "fazenda" };

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const idOf = (i: number) => i.toString(16).padStart(12, "0");

function container(i: number, over: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  const service = `s${String(i).padStart(2, "0")}`;
  return {
    id: idOf(i),
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
    ...over,
  };
}

const RUNTIME: ContainerRuntime = { state: "running", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: 0, tty: false };

function make(containers: DockerContainerInfo[], over: Partial<ProjectLogsDeps> = {}) {
  const deps: ProjectLogsDeps = {
    listContainers: async () => containers,
    inspect: async () => RUNTIME,
    logs: async (): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(0) }),
    now: () => NOW,
    ...over,
  };
  return new ProjectLogsService(deps);
}

function lineAt(i: number, text: string): string {
  const s = String(i % 60).padStart(2, "0");
  const m = String(Math.floor(i / 60) % 60).padStart(2, "0");
  const h = String(Math.floor(i / 3600)).padStart(2, "0");
  return `2026-10-24T${h}:${m}:${s}Z ${text}\n`;
}

describe("concorrência dentro de um pedido", () => {
  it("lê no máximo LOG_CONCURRENCY containers ao mesmo tempo", async () => {
    let inFlight = 0;
    let max = 0;
    const gate = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    const svc = make(Array.from({ length: 12 }, (_v, i) => container(i)), {
      inspect: async () => {
        await gate();
        return RUNTIME;
      },
      logs: async () => {
        await gate();
        return { ok: true, body: frame(lineAt(1, "x")) };
      },
    });
    const r = await svc.read(project, {}, []);
    expect(LOG_CONCURRENCY).toBe(4);
    expect(max).toBe(LOG_CONCURRENCY);
    expect(r.services).toHaveLength(12);
    expect(r.lines).toHaveLength(12);
  });
});

/** Leituras que ficam penduradas no listContainers até serem soltas; cada uma com o seu ator. */
function hanging() {
  const releases: Array<() => void> = [];
  const svc = make([container(1)], {
    listContainers: () => new Promise<DockerContainerInfo[]>((resolve) => releases.push(() => resolve([container(1)]))),
  });
  return { svc, release: () => releases.splice(0).forEach((r) => r()), count: () => releases.length };
}

describe("pedidos simultâneos (429)", () => {
  it("acima de MAX_ACTIVE_READS leituras em andamento, o seguinte recebe 429 logs_busy; liberou, volta a funcionar", async () => {
    const h = hanging();
    expect(MAX_ACTIVE_READS).toBe(6);
    const pending = Array.from({ length: MAX_ACTIVE_READS }, (_v, i) => h.svc.read(project, {}, [], { actor: `humano-${i}` }));
    await expect(h.svc.read(project, {}, [], { actor: "humano-novo" })).rejects.toMatchObject({ statusCode: 429, code: "logs_busy" });
    h.release();
    await Promise.all(pending);
    const again = h.svc.read(project, {}, [], { actor: "humano-novo" });
    h.release();
    await expect(again).resolves.toMatchObject({ services: [expect.anything()] });
  });

  it("no máximo 2 leituras por sessão ou token; outro ator continua passando", async () => {
    const h = hanging();
    expect(MAX_READS_PER_ACTOR).toBe(2);
    const a = [h.svc.read(project, {}, [], { actor: "s1" }), h.svc.read(project, {}, [], { actor: "s1" })];
    await expect(h.svc.read(project, {}, [], { actor: "s1" })).rejects.toMatchObject({ statusCode: 429 });
    const b = h.svc.read(project, {}, [], { actor: "s2" });
    h.release();
    await Promise.all([...a, b]);
    // liberou: o mesmo ator volta a poder ler
    const c = h.svc.read(project, {}, [], { actor: "s1" });
    h.release();
    await expect(c).resolves.toBeTruthy();
  });

  it("tokens usam no máximo 4 das 6 vagas: as 2 últimas ficam para a sessão humana", async () => {
    const h = hanging();
    expect(MAX_TOKEN_READS).toBe(4);
    const tokens = Array.from({ length: MAX_TOKEN_READS }, (_v, i) => h.svc.read(project, {}, [], { actor: `token:${i}`, human: false }));
    await expect(h.svc.read(project, {}, [], { actor: "token:novo", human: false })).rejects.toMatchObject({ statusCode: 429, code: "logs_busy" });
    const humans = [h.svc.read(project, {}, [], { actor: "h1" }), h.svc.read(project, {}, [], { actor: "h2" })];
    await expect(h.svc.read(project, {}, [], { actor: "h3" })).rejects.toMatchObject({ statusCode: 429 });
    h.release();
    await Promise.all([...tokens, ...humans]);
    // as vagas de token voltaram
    const t = h.svc.read(project, {}, [], { actor: "token:novo", human: false });
    h.release();
    await expect(t).resolves.toBeTruthy();
  });

  it("cliente que fecha a conexão: responde 499 na hora, mas a vaga só volta quando a leitura termina de fato", async () => {
    const h = hanging();
    const ac = new AbortController();
    const first = h.svc.read(project, {}, [], { actor: "s1", signal: ac.signal });
    const second = h.svc.read(project, {}, [], { actor: "s1" });
    await expect(h.svc.read(project, {}, [], { actor: "s1" })).rejects.toMatchObject({ statusCode: 429 });
    ac.abort();
    await expect(first).rejects.toMatchObject({ statusCode: 499, code: "client_closed" });
    // a leitura abortada ainda não parou: a vaga continua ocupada
    await expect(h.svc.read(project, {}, [], { actor: "s1" })).rejects.toMatchObject({ statusCode: 429 });
    h.release();
    await second.catch(() => undefined);
    // terminou de verdade: o ator tem vaga de novo
    const third = h.svc.read(project, {}, [], { actor: "s1" });
    h.release();
    await expect(third).resolves.toBeTruthy();
  });

  it("sinal já abortado antes de começar: cancela sem consultar e sem prender vaga", async () => {
    const listContainers = vi.fn(async () => [container(1)]);
    const svc = make([container(1)], { listContainers });
    const ac = new AbortController();
    ac.abort();
    for (let i = 0; i < MAX_READS_PER_ACTOR + 2; i++) {
      await expect(svc.read(project, {}, [], { actor: "s1", signal: ac.signal })).rejects.toMatchObject({ statusCode: 499 });
    }
    await expect(svc.read(project, {}, [], { actor: "s1" })).resolves.toBeTruthy();
  });

  it("leitura com sinal que termina normalmente devolve o resultado e solta o ouvinte", async () => {
    const svc = make([container(1)]);
    const ac = new AbortController();
    const r = await svc.read(project, {}, [], { actor: "s1", signal: ac.signal });
    expect(r.services).toHaveLength(1);
    ac.abort(); // depois de pronto, abortar não faz nada
  });

  it("leitura que falha devolve a vaga (o contador não vaza)", async () => {
    let fail = true;
    const svc = make([container(1)], {
      listContainers: async () => {
        if (fail) throw new Error("docker caiu");
        return [container(1)];
      },
    });
    for (let i = 0; i < MAX_ACTIVE_READS + 3; i++) await expect(svc.read(project, {}, [])).rejects.toThrow("docker caiu");
    fail = false;
    await expect(svc.read(project, {}, [])).resolves.toBeTruthy();
  });

  it("consulta inválida não ocupa vaga", async () => {
    const svc = make([container(1)]);
    for (let i = 0; i < MAX_ACTIVE_READS + 3; i++) await expect(svc.read(project, { tail: 0 }, [])).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.read(project, {}, [])).resolves.toBeTruthy();
  });
});

describe("total de bytes por pedido (reserva)", () => {
  it("8 containers de 8 MiB: o orçamento de 40 MiB vale também para leituras em paralelo (5 lidos, 3 too_large)", async () => {
    const MiB = 1024 * 1024;
    expect(MAX_TOTAL_BYTES).toBe(40 * MiB);
    let inFlightBytes = 0;
    let peak = 0;
    const logs = vi.fn(async (): Promise<DockerLogsResult> => {
      inFlightBytes += 8 * MiB;
      peak = Math.max(peak, inFlightBytes);
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, body: Buffer.alloc(8 * MiB) };
    });
    const svc = make(Array.from({ length: 8 }, (_v, i) => container(i)), { logs });
    const r = await svc.read(project, {}, []);
    expect(logs).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(40 * MiB);
    expect(r.services.filter((s) => s.logsError === "too_large")).toHaveLength(3);
  });

  it("a sobra da reserva volta: corpos pequenos não gastam o orçamento", async () => {
    const logs = vi.fn(async (): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(1024) }));
    const svc = make(Array.from({ length: 12 }, (_v, i) => container(i)), { logs });
    const r = await svc.read(project, {}, []);
    expect(logs).toHaveBeenCalledTimes(12);
    expect(r.services.some((s) => s.logsError === "too_large")).toBe(false);
  });

  it("corpo grande já lido continua contando: depois de 5 × 8 MiB lidos, o seguinte não é lido", async () => {
    const logs = vi.fn(async (): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(8 * 1024 * 1024) }));
    const svc = make(Array.from({ length: 6 }, (_v, i) => container(i)), { logs });
    const r = await svc.read(project, {}, []);
    expect(logs).toHaveBeenCalledTimes(5);
    expect(r.services.filter((s) => s.logsError === "too_large")).toHaveLength(1);
  });

  it("leitura recusada pelo Docker devolve a reserva inteira", async () => {
    const logs = vi.fn(async (): Promise<DockerLogsResult> => ({ ok: false, reason: "unavailable" }));
    const svc = make(Array.from({ length: 10 }, (_v, i) => container(i)), { logs });
    await svc.read(project, {}, []);
    expect(logs).toHaveBeenCalledTimes(10);
  });
});

describe("orçamento de tempo da máscara", () => {
  it("é de 250 ms (um processo só: máscara longa para o laço de eventos)", () => {
    expect(MASK_BUDGET_MS).toBe(250);
  });
});

describe("docker ps dentro do prazo", () => {
  it("a listagem recebe o menor entre 10 s e o prazo total", async () => {
    const listContainers = vi.fn(async (_ms?: number) => [container(1)]);
    await make([container(1)], { listContainers, clock: () => 0 }).read(project, {}, []);
    expect(listContainers.mock.calls[0]![0]).toBe(CALL_TIMEOUT_MS);
  });
});

describe("prazo total do pedido", () => {
  it("cada chamada recebe o menor entre 10 s e o que resta do prazo de 15 s", async () => {
    let t = 0;
    const seen: Array<{ kind: string; ms: number | undefined }> = [];
    const svc = make([container(1)], {
      clock: () => t,
      inspect: async (_id, ms) => {
        seen.push({ kind: "inspect", ms });
        t = 8_000;
        return RUNTIME;
      },
      logs: async (_id, o) => {
        seen.push({ kind: "logs", ms: o.timeoutMs });
        return { ok: true, body: Buffer.alloc(0) };
      },
    });
    await svc.read(project, {}, []);
    expect(CALL_TIMEOUT_MS).toBe(10_000);
    expect(TOTAL_DEADLINE_MS).toBe(15_000);
    expect(seen).toEqual([
      { kind: "inspect", ms: 10_000 },
      { kind: "logs", ms: 7_000 },
    ]);
  });

  it("estourou o prazo: os serviços que faltam nem são consultados e aparecem como indisponíveis", async () => {
    let t = 0;
    const inspect = vi.fn(async () => {
      t = 16_000;
      return RUNTIME;
    });
    const logs = vi.fn(async (): Promise<DockerLogsResult> => ({ ok: true, body: Buffer.alloc(0) }));
    const svc = make(Array.from({ length: 10 }, (_v, i) => container(i)), { clock: () => t, inspect, logs });
    const r = await svc.read(project, {}, []);
    // o primeiro gasta o prazo; os outros não chegam a consultar o Docker
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(logs).not.toHaveBeenCalled();
    expect(r.services.every((s) => s.logsError === "unavailable")).toBe(true);
  });

  it("prazo restante de exatamente zero também conta como estourado", async () => {
    let t = 0;
    const inspect = vi.fn(async () => RUNTIME);
    const svc = make([container(1)], { clock: () => t, inspect });
    t = TOTAL_DEADLINE_MS;
    // o relógio só anda depois de o prazo ter sido fixado: simula passando 15 s antes da primeira chamada
    const svc2 = make([container(1)], {
      clock: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? 0 : TOTAL_DEADLINE_MS);
      })(),
      inspect,
    });
    const r = await svc2.read(project, {}, []);
    expect(r.services[0]!.logsError).toBe("unavailable");
    expect(inspect).not.toHaveBeenCalled();
    void svc;
  });
});

describe("orçamento da máscara", () => {
  const SECRET = "Segredo-de-teste-9";

  it("por tempo: esgotado, as linhas mais velhas saem omitidas (nunca sem máscara); as novas continuam", async () => {
    let masking = false;
    let t = 0;
    const body = frame(Array.from({ length: 5 }, (_v, i) => lineAt(i, `valor ${SECRET}`)).join(""));
    const svc = make([container(1)], {
      clock: () => (masking ? (t += MASK_BUDGET_MS * 0.4) : t),
      logs: async () => {
        masking = true;
        return { ok: true, body };
      },
    });
    const r = await svc.read(project, {}, [SECRET]);
    expect(r.lines.map((l) => l.text)).toEqual([LOG_OMITTED, LOG_OMITTED, LOG_OMITTED, `valor ${LOG_MASK}`, `valor ${LOG_MASK}`]);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("por caracteres: passou de MAX_MASK_CHARS crus, as mais velhas saem omitidas", async () => {
    const len = RAW_LINE_MAX - 1;
    const text = "password=" + "x".repeat(len - 9);
    const body = frame(Array.from({ length: 2000 }, (_v, i) => lineAt(i, text)).join(""));
    const svc = make([container(1)], { logs: async () => ({ ok: true, body }) });
    const r = await svc.read(project, { tail: 2000 }, []);
    // cada linha mascarada gasta len caracteres do orçamento; a que cruza o zero ainda é mascarada
    const masked = Math.floor(MAX_MASK_CHARS / len) + 1;
    expect(r.lines).toHaveLength(2000);
    expect(r.lines.filter((l) => l.text === LOG_OMITTED)).toHaveLength(2000 - masked);
    expect(r.lines.slice(-masked).every((l) => l.text === `password=${LOG_MASK}`)).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("linha crua acima de RAW_LINE_MAX é cortada antes da máscara e sai com reticências", async () => {
    const body = frame(lineAt(1, "y".repeat(RAW_LINE_MAX * 3)));
    const svc = make([container(1)], { logs: async () => ({ ok: true, body }) });
    const r = await svc.read(project, {}, []);
    expect(r.lines[0]!.text).toBe("y".repeat(2000) + "…");
  });

  it("linha patológica de 16 KiB nunca é entregue sem passar pela máscara (sem travar)", async () => {
    const body = frame(lineAt(1, "a.".repeat(8192)));
    const svc = make([container(1)], { logs: async () => ({ ok: true, body }) });
    const t0 = performance.now();
    const r = await svc.read(project, {}, []);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.lines[0]!.text.length).toBeLessThanOrEqual(2001);
  });
});

describe("fronteiras exatas", () => {
  it("o limite de serviços é 40 (valor fixo, não só a constante)", async () => {
    expect(MAX_LOG_SERVICES).toBe(40);
    const r = await make(Array.from({ length: 41 }, (_v, i) => container(i))).read(project, {}, []);
    expect(r.services).toHaveLength(40);
    expect(r.truncated).toBe(true);
  });

  it("a linha crua é cortada em 8000 antes de gastar o orçamento da máscara", async () => {
    expect(RAW_LINE_MAX).toBe(8000);
    expect(MAX_MASK_CHARS).toBe(4_000_000);
    const text = "password=" + "x".repeat(19_990);
    const body = frame(Array.from({ length: 2000 }, (_v, i) => lineAt(i, text)).join(""));
    const r = await make([container(1)], { logs: async () => ({ ok: true, body }) }).read(project, { tail: 2000 }, []);
    // 8000 por linha: 500 linhas cabem no orçamento; sem o corte seriam 200
    expect(r.lines.filter((l) => l.text !== LOG_OMITTED)).toHaveLength(500);
  });

  it("exatamente MAX_LOG_SERVICES serviços: sem aviso; um a mais: truncated", async () => {
    const exact = await make(Array.from({ length: MAX_LOG_SERVICES }, (_v, i) => container(i))).read(project, {}, []);
    expect(exact.services).toHaveLength(MAX_LOG_SERVICES);
    expect(exact.truncated).toBe(false);
    const over = await make(Array.from({ length: MAX_LOG_SERVICES + 1 }, (_v, i) => container(i))).read(project, {}, []);
    expect(over.services).toHaveLength(MAX_LOG_SERVICES);
    expect(over.truncated).toBe(true);
  });

  it("exatamente MAX_RESPONSE_CHARS caracteres cabe; um a mais derruba a linha mais velha", async () => {
    const full = Array.from({ length: MAX_RESPONSE_CHARS / 2000 }, (_v, i) => lineAt(i, "z".repeat(2000)));
    const svc = (extra: string[]) => make([container(1)], { logs: async () => ({ ok: true, body: frame([...full, ...extra].join("")) }) });
    const exact = await svc([]).read(project, { tail: 2000 }, []);
    expect(exact.lines).toHaveLength(full.length);
    expect(exact.truncated).toBe(false);
    const over = await svc([lineAt(3599, "w")]).read(project, { tail: 2000 }, []);
    expect(over.truncated).toBe(true);
    expect(over.lines).toHaveLength(full.length);
    expect(over.lines.at(-1)!.text).toBe("w");
  });

  it("slug por prefixo não vaza: projeto 'a' não vê containers de 'a-b' e vice-versa", async () => {
    const mine = container(1, { projectSlug: "a", composeProject: "paas-a", name: "paas-a-web-1" });
    const other = container(2, { projectSlug: "a-b", composeProject: "paas-a-b", name: "paas-a-b-web-1" });
    const svc = make([mine, other]);
    expect((await svc.read({ slug: "a" }, {}, [])).services.map((s) => s.container)).toEqual(["paas-a-web-1"]);
    expect((await svc.read({ slug: "a-b" }, {}, [])).services.map((s) => s.container)).toEqual(["paas-a-b-web-1"]);
    await expect(svc.read({ slug: "a" }, { service: "s02" }, [])).rejects.toMatchObject({ code: "service_not_found" });
  });
});
