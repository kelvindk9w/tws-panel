/**
 * metrics-docker.test.ts — lista de containers e estatísticas pela API do Docker.
 * Servidor HTTP real num socket temporário (sem Docker).
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CONTAINERS, dockerListEntries, dockerStatsRaw } from "../src/services/metrics-docker.js";
import { DOCKER_STATS } from "./fixtures/metrics-proc.js";

let server: http.Server;
let tmp: string;
let socket: string;
let seen: string[];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
const ID = "b".repeat(64);

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-mdocker-"));
  socket = path.join(tmp, "d.sock");
  seen = [];
  handler = (_req, res) => res.writeHead(404).end();
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(socket, r));
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});

const json = (body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(200).end(JSON.stringify(body));

describe("dockerListEntries", () => {
  it("pede /containers/json?all=1 e classifica pelo rótulo do compose (identidade que o projeto não forja)", async () => {
    handler = json([
      { Id: ID, Names: ["/paas-loja-web-1"], State: "running", Labels: { "com.docker.compose.project": "paas-loja", "com.docker.compose.service": "web", "paas.project": "outro" } },
      { Id: "c".repeat(64), Names: ["/tws-caddy"], State: "exited", Labels: { "paas.managed": "true" } },
      { Id: "d".repeat(64), Names: ["/redis-externo"], State: "running", Labels: {} },
    ]);
    const r = (await dockerListEntries(socket))!;
    expect(seen).toEqual(["GET /containers/json?all=1"]);
    expect(r[0]).toEqual({ id: ID, name: "paas-loja-web-1", state: "running", managed: true, projectSlug: "loja", service: "web" });
    expect(r[1]).toMatchObject({ name: "tws-caddy", state: "exited", managed: true, projectSlug: null, service: null });
    expect(r[2]).toMatchObject({ managed: false, projectSlug: null });
  });

  it("rótulo de projeto de outro dono (compose de fora do painel) não vira projeto do painel", async () => {
    handler = json([{ Id: ID, Names: ["/x"], State: "running", Labels: { "com.docker.compose.project": "meuapp", "paas.project": "loja", "paas.managed": "true" } }]);
    expect((await dockerListEntries(socket))![0]).toMatchObject({ managed: false, projectSlug: null });
  });

  it("entradas estragadas são puladas: sem Id, Id fora do formato, não-objeto; nome e estado ausentes têm padrão", async () => {
    handler = json([null, 5, [], {}, { Id: "../etc" }, { Id: "ZZZ" + "a".repeat(61) }, { Id: ID, Labels: "x", Names: [5], State: 3 }, { Id: "e".repeat(64), Names: [] }]);
    const r = (await dockerListEntries(socket))!;
    expect(r.map((e) => e.id)).toEqual([ID, "e".repeat(64)]);
    expect(r[0]).toMatchObject({ name: ID.slice(0, 12), state: "unknown", managed: false });
  });

  it("rótulos que não são texto e __proto__ são ignorados", async () => {
    handler = (_req, res) => res.writeHead(200).end(`[{"Id":"${ID}","Names":["/a"],"State":"running","Labels":{"__proto__":"x","com.docker.compose.service":5,"com.docker.compose.project":"paas-p"}}]`);
    const r = (await dockerListEntries(socket))![0]!;
    expect(r.service).toBeNull();
    expect(r.projectSlug).toBe("p");
  });

  it("no máximo MAX_CONTAINERS entradas", async () => {
    handler = json(Array.from({ length: MAX_CONTAINERS + 50 }, (_, i) => ({ Id: i.toString(16).padStart(64, "0"), Names: [`/c${i}`], State: "running" })));
    expect(await dockerListEntries(socket)).toHaveLength(MAX_CONTAINERS);
  });

  it("erro do Docker, JSON ruim, objeto no lugar da lista, resposta grande demais e socket inexistente: null (nunca lista vazia enganosa)", async () => {
    expect(await dockerListEntries(socket)).toBeNull(); // 404
    handler = (_req, res) => res.writeHead(200).end("não é json");
    expect(await dockerListEntries(socket)).toBeNull();
    handler = json({ Id: ID });
    expect(await dockerListEntries(socket)).toBeNull();
    expect(await dockerListEntries(path.join(tmp, "nao.sock"))).toBeNull();
  });

  it("lista vazia do Docker é lista vazia (diferente de falha)", async () => {
    handler = json([]);
    expect(await dockerListEntries(socket)).toEqual([]);
  });

  it("cancelamento derruba a requisição", async () => {
    handler = () => undefined; // nunca responde
    const ac = new AbortController();
    const p = dockerListEntries(socket, 5000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    expect(await p).toBeNull();
  });
});

describe("dockerStatsRaw", () => {
  it("pede uma leitura única e converte", async () => {
    handler = json(DOCKER_STATS);
    const r = await dockerStatsRaw(socket, ID);
    expect(seen).toEqual([`GET /containers/${ID}/stats?stream=false&one-shot=true`]);
    expect(r).toMatchObject({ cpuUsec: 91234567, memWorkingBytes: 157286400, netRxBytes: 123466 });
  });

  it("id ruim nunca vai ao Docker; erro, JSON ruim e socket inexistente dão null", async () => {
    expect(await dockerStatsRaw(socket, "../x")).toBeNull();
    expect(seen).toEqual([]);
    expect(await dockerStatsRaw(socket, ID)).toBeNull(); // 404
    handler = (_req, res) => res.writeHead(200).end("x");
    expect(await dockerStatsRaw(socket, ID)).toBeNull();
    expect(await dockerStatsRaw(path.join(tmp, "nao.sock"), ID)).toBeNull();
  });
});
