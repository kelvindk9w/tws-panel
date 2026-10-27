/**
 * metrics-oom-stream.test.ts — a assinatura contínua dos eventos "oom" do Docker:
 * leitura do stream (linhas quebradas em pedaços, linhas enormes, duplicatas),
 * fila limitada, reconexão com espera e `since` em nanossegundos, desligamento
 * limpo e socket indisponível. Servidor HTTP real num socket temporário.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OomEventStream, OOM_LINE_MAX_BYTES, OOM_QUEUE_MAX, parseOomLine, sinceParam } from "../src/services/metrics-oom-stream.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const line = (id: string, nano: string, extra: Record<string, unknown> = {}) =>
  `{"Type":"container","Action":"oom","Actor":{"ID":"${id}","Attributes":{"name":"x"}},"scope":"local","time":${nano.slice(0, 10)},"timeNano":${nano}${Object.keys(extra).length ? "," + JSON.stringify(extra).slice(1, -1) : ""}}`;

let tmp: string;
let socket: string;
let server: http.Server | null;
let requests: string[];
let responses: http.ServerResponse[];
let status: number;
/** O servidor responde 200 e fecha logo em seguida. */
let flap = false;
let streams: OomEventStream[];
let closedByPeer: number;

const make = (over: Partial<ConstructorParameters<typeof OomEventStream>[0]> = {}, logs: string[] = []) => {
  const s = new OomEventStream({ socketPath: socket, log: (m) => logs.push(m), minBackoffMs: 10, maxBackoffMs: 40, ...over });
  streams.push(s);
  return s;
};
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("tempo esgotado");
    await new Promise((r) => setTimeout(r, 5));
  }
};
async function listen() {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (status !== 200) {
      res.writeHead(status).end("x");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.on("close", () => closedByPeer++);
    responses.push(res);
    if (flap) res.end();
  });
  await new Promise<void>((r) => server!.listen(socket, r));
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-oomstream-"));
  socket = path.join(tmp, "d.sock");
  requests = [];
  responses = [];
  status = 200;
  flap = false;
  streams = [];
  closedByPeer = 0;
  server = null;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of streams) s.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("parseOomLine / sinceParam", () => {
  it("evento de container com id válido: o instante em ns é lido do texto (passa de 2^53)", () => {
    expect(parseOomLine(line(A, "1792843230123456789"))).toEqual({ id: A, timeNano: 1792843230123456789n });
  });
  it("campos antigos (status/id) e instante só em segundos", () => {
    expect(parseOomLine(JSON.stringify({ status: "oom", id: B, time: 1792843230 }))).toEqual({ id: B, timeNano: 1792843230000000000n });
  });
  it("o que não é morte por memória de container com id válido e instante é ignorado", () => {
    for (const l of [
      "lixo",
      "[]",
      "null",
      JSON.stringify({ Type: "network", Action: "oom", Actor: { ID: A }, timeNano: 1 }),
      JSON.stringify({ Type: "container", Action: "die", Actor: { ID: A }, timeNano: 1 }),
      JSON.stringify({ Type: "container", Action: "oom", Actor: { ID: "../x" }, timeNano: 1 }),
      JSON.stringify({ Type: "container", Action: "oom", timeNano: 1 }),
      JSON.stringify({ Type: "container", Action: "oom", Actor: { ID: A } }),
      JSON.stringify({ Type: "container", Action: "oom", Actor: { ID: A }, time: -1 }),
    ]) {
      expect(parseOomLine(l)).toBeNull();
    }
  });
  it("since do Docker: segundos.nanossegundos com 9 dígitos", () => {
    expect(sinceParam(1792843230000000001n)).toBe("1792843230.000000001");
    expect(sinceParam(5n)).toBe("0.000000005");
  });
});

describe("assinatura", () => {
  it("pede o stream filtrado (container + oom), sem since na primeira vez, e enfileira os eventos; drain esvazia", async () => {
    await listen();
    const s = make();
    s.start();
    s.start(); // repetido não abre outra conexão
    await until(() => responses.length === 1);
    expect(requests).toHaveLength(1);
    const url = new URL(`http://x${requests[0]}`);
    expect(url.pathname).toBe("/events");
    expect(url.searchParams.has("since")).toBe(false);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({ type: ["container"], event: ["oom"] });
    responses[0]!.write(`${line(A, "1792843230000000100")}\n\n${line(B, "1792843230000000200")}\n`);
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 2);
    expect(s.drain().map((e) => e.id)).toEqual([A, B]);
    expect(s.drain()).toEqual([]);
  });

  it("mesmo segundo, nanossegundos diferentes: os dois contam, em ordem; repetido ou mais velho é ignorado", async () => {
    await listen();
    const s = make();
    s.start();
    await until(() => responses.length === 1);
    responses[0]!.write(
      [line(A, "1792843230500000000"), line(A, "1792843230500000000"), line(B, "1792843230900000000"), line(A, "1792843230100000000")].join("\n") + "\n",
    );
    await until(() => (s as unknown as { queue: unknown[] }).queue.length >= 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.drain()).toEqual([
      { id: A, timeNano: 1792843230500000000n },
      { id: B, timeNano: 1792843230900000000n },
    ]);
  });

  it("linha chegando em pedaços é remontada", async () => {
    await listen();
    const s = make();
    s.start();
    await until(() => responses.length === 1);
    const l = line(A, "1792843230500000000");
    responses[0]!.write(l.slice(0, 30));
    await new Promise((r) => setTimeout(r, 20));
    responses[0]!.write(l.slice(30) + "\n");
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 1);
  });

  it("linha enorme é descartada inteira (com ou sem quebra no mesmo pedaço) e as seguintes continuam valendo", async () => {
    await listen();
    const s = make({ maxLineBytes: 300 });
    s.start();
    await until(() => responses.length === 1);
    // enorme e completa num pedaço só
    responses[0]!.write(line(A, "1792843230000000001", { lixo: "x".repeat(600) }) + "\n");
    // enorme em vários pedaços, sem quebra até passar do teto
    responses[0]!.write("y".repeat(400));
    await new Promise((r) => setTimeout(r, 20));
    responses[0]!.write("y".repeat(400));
    await new Promise((r) => setTimeout(r, 20));
    responses[0]!.write("fim da linha enorme\n");
    responses[0]!.write(line(B, "1792843230000000002") + "\n");
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 1);
    expect(s.drain()).toEqual([{ id: B, timeNano: 1792843230000000002n }]);
    expect(OOM_LINE_MAX_BYTES).toBeGreaterThan(1000);
  });

  it("fila com limite: os mais velhos saem", async () => {
    await listen();
    const s = make({ maxQueue: 3 });
    s.start();
    await until(() => responses.length === 1);
    responses[0]!.write(Array.from({ length: 6 }, (_, i) => line(A, `17928432300000000${10 + i}`)).join("\n") + "\n");
    await until(() => (s as unknown as { lastNano: bigint | null }).lastNano === 1792843230000000015n);
    expect(s.drain().map((e) => e.timeNano)).toEqual([1792843230000000013n, 1792843230000000014n, 1792843230000000015n]);
    expect(OOM_QUEUE_MAX).toBeGreaterThan(100);
  });

  it("cai: reconecta com espera e pede since = último instante + 1 ns; não repete o que já viu", async () => {
    await listen();
    const logs: string[] = [];
    const s = make({}, logs);
    s.start();
    await until(() => responses.length === 1);
    responses[0]!.write(line(A, "1792843230000000009") + "\n");
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 1);
    responses[0]!.end(); // o Docker fechou
    await until(() => responses.length === 2);
    expect(new URL(`http://x${requests[1]}`).searchParams.get("since")).toBe("1792843230.000000010");
    // o Docker reentrega o evento (since é inclusivo no buffer dele) e um novo
    responses[1]!.write(line(A, "1792843230000000009") + "\n" + line(B, "1792843231000000000") + "\n");
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 2);
    expect(s.drain().map((e) => e.id)).toEqual([A, B]);
    expect(logs.filter((m) => m.includes("fechou"))).toHaveLength(1);
  });

  it("resposta de erro do Docker: tenta de novo com espera crescente, avisa uma vez, e volta ao normal quando responde 200", async () => {
    status = 500;
    await listen();
    const logs: string[] = [];
    const s = make({}, logs);
    s.start();
    await until(() => requests.length >= 3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("500");
    status = 200;
    await until(() => responses.length === 1);
    responses[0]!.write(line(A, "1792843230000000001") + "\n");
    await until(() => (s as unknown as { queue: unknown[] }).queue.length === 1);
  });

  it("socket indisponível não lança nem derruba nada; quando o Docker aparece, conecta", async () => {
    const logs: string[] = [];
    const s = make({}, logs);
    s.start();
    await until(() => logs.length === 1);
    await new Promise((r) => setTimeout(r, 120)); // várias tentativas, um aviso só
    expect(logs).toHaveLength(1);
    expect(s.drain()).toEqual([]);
    await listen();
    await until(() => responses.length === 1);
  });

  it("stop fecha a conexão e cancela a reconexão (inclusive a já agendada); stop repetido e sem start não fazem nada", async () => {
    await listen();
    const idle = make();
    idle.stop();
    const s = make();
    s.start();
    await until(() => responses.length === 1);
    s.stop();
    s.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(1);
    // agendada e depois cancelada
    const s2 = make();
    status = 500;
    s2.start();
    await until(() => requests.length === 2);
    s2.stop();
    const n = requests.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(requests.length).toBe(n);
  });
});

const queueLen = (s: OomEventStream) => (s as unknown as { queue: unknown[] }).queue.length;

describe("reconexão: espera, log e pedidos sobrepostos", () => {

  it("a espera cresce, tem teto e volta ao mínimo só depois que o stream se mostra saudável (evento)", async () => {
    status = 500;
    await listen();
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w) });
    s.start();
    await until(() => waits.length >= 5);
    expect(waits.slice(0, 5)).toEqual([10, 20, 40, 40, 40]); // dobra, e o teto vale
    status = 200;
    await until(() => responses.length === 1);
    responses[0]!.write(line(A, "1792843230000000001") + "\n"); // chegou evento: saudável
    await until(() => queueLen(s) === 1);
    waits.length = 0;
    responses[0]!.end();
    await until(() => waits.length === 1);
    expect(waits[0]).toBe(10); // voltou ao mínimo
  });

  it("200 seguido de fechamento imediato não zera a espera nem repete o log a cada tentativa", async () => {
    flap = true;
    await listen();
    const logs: string[] = [];
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w), healthyMs: 10_000 }, logs);
    s.start();
    await until(() => waits.length >= 5);
    expect(waits.slice(0, 5)).toEqual([10, 20, 40, 40, 40]);
    expect(logs).toHaveLength(1);
  });

  it("conexão que fica aberta pelo tempo mínimo zera a espera", async () => {
    await listen();
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w), healthyMs: 40 });
    status = 500;
    s.start();
    await until(() => waits.length >= 2); // 10, 20
    status = 200;
    await until(() => responses.length === 1);
    await new Promise((r) => setTimeout(r, 120)); // aberta mais que healthyMs, sem evento
    waits.length = 0;
    responses[0]!.end();
    await until(() => waits.length === 1);
    expect(waits[0]).toBe(10);
  });

  it("queda prolongada: uma linha, e um resumo periódico (não uma por tentativa)", async () => {
    status = 500;
    await listen();
    const logs: string[] = [];
    let clock = 1_000_000;
    const waits: number[] = [];
    const s = make({ now: () => clock, summaryEveryMs: 60_000, onWait: (w) => waits.push(w) }, logs);
    s.start();
    await until(() => waits.length >= 3);
    expect(logs).toHaveLength(1);
    clock += 61_000;
    const n = waits.length;
    await until(() => waits.length > n);
    await until(() => logs.length === 2);
    expect(logs[1]).toContain("ainda indisponíveis");
    const m = waits.length;
    await until(() => waits.length > m + 1);
    expect(logs).toHaveLength(2); // sem novo resumo antes de outro minuto
  });

  it("evento atrasado de um pedido antigo não agenda conexão em dobro nem deixa socket órfão", async () => {
    await listen();
    const made: http.ClientRequest[] = [];
    const real = http.request;
    vi.spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
      const r = real(...args);
      made.push(r);
      return r;
    }) as typeof http.request);
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w) });
    s.start();
    await until(() => responses.length === 1);
    responses[0]!.end();
    await until(() => responses.length === 2); // reconectou: o pedido novo é o atual
    const old = made[0]!;
    old.emit("error", new Error("tardio"));
    old.emit("close");
    old.emit("error", new Error("tardio de novo"));
    await new Promise((r) => setTimeout(r, 100));
    expect(made).toHaveLength(2); // nenhuma terceira conexão
    expect(waits).toHaveLength(1);
    // o pedido atual continua aberto e recebendo
    expect(closedByPeer).toBe(1); // só a primeira resposta foi fechada
    responses[1]!.write(line(A, "1792843230000000001") + "\n");
    await until(() => queueLen(s) === 1);
  });

  it("o temporizador de 'conexão saudável' é cancelado quando a conexão cai antes do tempo: a espera não volta ao mínimo depois", async () => {
    flap = true; // a primeira conexão abre e fecha logo
    await listen();
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w), healthyMs: 120 });
    s.start();
    await until(() => responses.length >= 1);
    flap = false;
    status = 500; // as tentativas seguintes falham, passando bem do tempo de 120 ms
    await until(() => waits.length >= 10);
    expect(waits[0]).toBe(10);
    expect(waits.slice(1).every((w) => w > 10)).toBe(true); // um temporizador vivo teria zerado a espera
  });

  it("segunda queda depois da recuperação volta a ser anunciada no log", async () => {
    status = 500;
    await listen();
    const logs: string[] = [];
    const waits: number[] = [];
    const s = make({ onWait: (w) => waits.push(w) }, logs);
    s.start();
    await until(() => waits.length >= 3);
    expect(logs).toHaveLength(1);
    status = 200;
    await until(() => responses.length === 1);
    responses[0]!.write(line(A, "1792843230000000001") + "\n"); // recuperou: chegou evento
    await until(() => queueLen(s) === 1);
    status = 500;
    responses[0]!.end(); // segunda queda
    await until(() => logs.length === 2);
    expect(logs[1]).toContain("tentando de novo");
  });

  it("stop() destrói a conexão aberta (o servidor vê o fechamento)", async () => {
    await listen();
    const s = make();
    s.start();
    await until(() => responses.length === 1);
    expect(closedByPeer).toBe(0);
    s.stop();
    await until(() => closedByPeer === 1);
    expect(responses[0]!.destroyed || responses[0]!.writableEnded || closedByPeer === 1).toBe(true);
  });
});
