/**
 * docker-logs.test.ts — leitura de logs e estado de container pela Docker
 * Engine API (unix socket): desmultiplexação stdout/stderr, horário por linha,
 * limite de bytes e de tempo. Servidor HTTP real num socket temporário.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCKER_LOGS_MAX_BYTES,
  demuxLogStream,
  dockerInspect,
  dockerLogs,
  splitTimestamp,
} from "../src/services/docker-logs.js";

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxLogStream", () => {
  it("separa stdout e stderr pelos quadros do Docker, na ordem", () => {
    const buf = Buffer.concat([frame(1, "a\n"), frame(2, "b\n"), frame(1, "c\n")]);
    expect(demuxLogStream(buf, false)).toEqual([
      { stream: "stdout", text: "a" },
      { stream: "stderr", text: "b" },
      { stream: "stdout", text: "c" },
    ]);
  });

  it("um quadro com várias linhas vira várias linhas; \\r\\n e linha vazia final", () => {
    const buf = frame(1, "um\r\ndois\n\ntres\n");
    expect(demuxLogStream(buf, false).map((l) => l.text)).toEqual(["um", "dois", "", "tres"]);
  });

  it("quadro cortado no meio (resposta interrompida) é ignorado, os anteriores ficam", () => {
    const whole = frame(1, "inteiro\n");
    const cut = frame(2, "cortado\n").subarray(0, 12);
    expect(demuxLogStream(Buffer.concat([whole, cut]), false)).toEqual([{ stream: "stdout", text: "inteiro" }]);
  });

  it("cabeçalho incompleto no fim não quebra", () => {
    expect(demuxLogStream(Buffer.concat([frame(1, "x\n"), Buffer.from([1, 0, 0])]), false)).toHaveLength(1);
  });

  it("tipo de quadro desconhecido (0 = stdin) conta como stdout", () => {
    const header = Buffer.alloc(8);
    header[0] = 0;
    header.writeUInt32BE(2, 4);
    expect(demuxLogStream(Buffer.concat([header, Buffer.from("z\n")]), false)).toEqual([{ stream: "stdout", text: "z" }]);
  });

  it("container com TTY: fluxo cru, tudo stdout", () => {
    expect(demuxLogStream(Buffer.from("l1\r\nl2\n"), true)).toEqual([
      { stream: "stdout", text: "l1" },
      { stream: "stdout", text: "l2" },
    ]);
  });

  it("vazio devolve nada", () => {
    expect(demuxLogStream(Buffer.alloc(0), false)).toEqual([]);
    expect(demuxLogStream(Buffer.alloc(0), true)).toEqual([]);
  });
});

describe("splitTimestamp", () => {
  it("separa o horário RFC 3339 do Docker do texto", () => {
    expect(splitTimestamp("2026-10-24T10:00:00.123456789Z servidor no ar")).toEqual({
      time: "2026-10-24T10:00:00.123456789Z",
      text: "servidor no ar",
    });
  });

  it("aceita horário sem fração e com deslocamento", () => {
    expect(splitTimestamp("2026-10-24T10:00:00Z x").time).toBe("2026-10-24T10:00:00Z");
    expect(splitTimestamp("2026-10-24T10:00:00.5-03:00 x").time).toBe("2026-10-24T10:00:00.5-03:00");
  });

  it("texto que não começa com horário fica inteiro, sem horário", () => {
    expect(splitTimestamp("sem horário aqui")).toEqual({ time: null, text: "sem horário aqui" });
    expect(splitTimestamp("2026-10-24 10:00 formato errado")).toEqual({ time: null, text: "2026-10-24 10:00 formato errado" });
  });

  it("horário seguido de nada (linha vazia do app) dá texto vazio", () => {
    expect(splitTimestamp("2026-10-24T10:00:00Z ")).toEqual({ time: "2026-10-24T10:00:00Z", text: "" });
    expect(splitTimestamp("2026-10-24T10:00:00Z")).toEqual({ time: "2026-10-24T10:00:00Z", text: "" });
  });

  it("data impossível não vira horário", () => {
    expect(splitTimestamp("2026-13-45T99:99:99Z x").time).toBeNull();
  });
});

describe("cliente HTTP no unix socket", () => {
  let server: http.Server;
  let tmp: string;
  let socket: string;
  let seen: string[];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "paas-dlogs-"));
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
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const ID = "0123456789ab";

  it("logs: pede stdout+stderr com horário, tail e since; devolve o corpo", async () => {
    handler = (_req, res) => res.writeHead(200).end(frame(1, "oi\n"));
    const r = await dockerLogs(socket, ID, { tail: 50, sinceSeconds: 1_700_000_000 });
    expect(r).toEqual({ ok: true, body: frame(1, "oi\n") });
    expect(seen).toEqual([`GET /containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&tail=50&since=1700000000`]);
  });

  it("logs: sem since não manda since", async () => {
    handler = (_req, res) => res.writeHead(200).end();
    await dockerLogs(socket, ID, { tail: 10, sinceSeconds: null });
    expect(seen[0]).toBe(`GET /containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&tail=10`);
  });

  it("logs: id fora do formato nunca vai ao Docker", async () => {
    for (const bad of ["../etc", "abc/../x", "ABC", "x".repeat(12), "0123456789a", `${ID}?all=1`, ""]) {
      expect(await dockerLogs(socket, bad, { tail: 5, sinceSeconds: null })).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(seen).toEqual([]);
  });

  it("logs: status diferente de 200 = indisponível", async () => {
    handler = (_req, res) => res.writeHead(404).end("no such container");
    expect(await dockerLogs(socket, ID, { tail: 5, sinceSeconds: null })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("logs: resposta acima do limite de bytes = too_large, e a leitura é abortada", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(1024 * 1024, 65));
      const timer = setInterval(() => res.write(Buffer.alloc(1024 * 1024, 65)), 1);
      res.on("close", () => clearInterval(timer));
    };
    const r = await dockerLogs(socket, ID, { tail: 5, sinceSeconds: null, maxBytes: 3 * 1024 * 1024 });
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("logs: limite padrão é de 8 MiB", () => {
    expect(DOCKER_LOGS_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("logs: Docker que não responde a tempo = indisponível", async () => {
    handler = () => {
      /* nunca responde */
    };
    const t0 = Date.now();
    expect(await dockerLogs(socket, ID, { tail: 5, sinceSeconds: null, timeoutMs: 80 })).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("logs: socket inexistente = indisponível", async () => {
    expect(await dockerLogs(path.join(tmp, "nao-existe.sock"), ID, { tail: 5, sinceSeconds: null })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("inspect: lê estado, saúde, reinícios, horários e TTY", async () => {
    handler = (_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          RestartCount: 3,
          Config: { Tty: true },
          State: {
            Status: "running",
            ExitCode: 0,
            StartedAt: "2026-10-24T08:00:00.5Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            Health: { Status: "healthy" },
            Pid: 4242,
            OOMKilled: true,
          },
        }),
      );
    expect(await dockerInspect(socket, ID)).toEqual({
      state: "running",
      health: "healthy",
      restartCount: 3,
      startedAt: "2026-10-24T08:00:00.5Z",
      finishedAt: null,
      exitCode: 0,
      tty: true,
      pid: 4242,
      oomKilled: true,
      restartPolicy: null,
      networkMode: null,
      healthyAt: null,
    });
    expect(seen).toEqual([`GET /containers/${ID}/json`]);
  });

  it("inspect: container parado traz a hora da parada e o código; sem healthcheck, health null", async () => {
    handler = (_req, res) =>
      res.writeHead(200).end(
        JSON.stringify({
          State: { Status: "exited", ExitCode: 137, StartedAt: "2026-10-24T08:00:00Z", FinishedAt: "2026-10-24T09:00:00Z" },
        }),
      );
    expect(await dockerInspect(socket, ID)).toMatchObject({
      state: "exited",
      health: null,
      restartCount: null,
      finishedAt: "2026-10-24T09:00:00Z",
      exitCode: 137,
      tty: false,
    });
  });

  it("inspect: saúde desconhecida vira null; campos de tipo errado viram null", async () => {
    handler = (_req, res) =>
      res.writeHead(200).end(
        JSON.stringify({ RestartCount: "x", State: { Status: 5, ExitCode: "1", StartedAt: 1, FinishedAt: null, Health: { Status: "none" } } }),
      );
    expect(await dockerInspect(socket, ID)).toEqual({
      state: "unknown",
      health: null,
      restartCount: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      tty: false,
      pid: null,
      oomKilled: false,
      restartPolicy: null,
      networkMode: null,
      healthyAt: null,
    });
  });

  it("inspect: política de reinício e a primeira verificação de saúde que passou (a mais antiga depois do início)", async () => {
    handler = (_req, res) =>
      res.writeHead(200).end(
        JSON.stringify({
          HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 }, NetworkMode: "host" },
          State: {
            Status: "running",
            StartedAt: "2026-10-27T10:00:00Z",
            Health: {
              Status: "healthy",
              Log: [
                { ExitCode: 0, End: "2026-10-27T09:59:00Z" }, // de antes deste início
                { ExitCode: 1, End: "2026-10-27T10:00:05Z" },
                { ExitCode: 0, End: "2026-10-27T10:00:35Z" },
                { ExitCode: 0, End: "2026-10-27T10:00:20Z" },
                { ExitCode: 0, End: "0001-01-01T00:00:00Z" },
                { ExitCode: 0 },
                null,
                "x",
              ],
            },
          },
        }),
      );
    expect(await dockerInspect(socket, ID)).toMatchObject({ restartPolicy: "unless-stopped", networkMode: "host", healthyAt: "2026-10-27T10:00:20Z" });
  });

  it("inspect: política vazia vira 'no'; sem HostConfig é null; registro de saúde que não é lista ou sem sucesso é null", async () => {
    handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ HostConfig: { RestartPolicy: { Name: "" } }, State: { Status: "running", Health: { Status: "starting", Log: [{ ExitCode: 1, End: "2026-10-27T10:00:05Z" }] } } }));
    expect(await dockerInspect(socket, ID)).toMatchObject({ restartPolicy: "no", healthyAt: null });
    handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ State: { Status: "running", Health: { Status: "healthy", Log: "x" } } }));
    expect(await dockerInspect(socket, ID)).toMatchObject({ restartPolicy: null, healthyAt: null });
    // sem horário de início: não dá para saber se a verificação é deste início, aceita a mais antiga
    handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ State: { Status: "running", Health: { Status: "healthy", Log: [{ ExitCode: 0, End: "2026-10-27T10:00:35Z" }, { ExitCode: 0, End: "lixo" }] } } }));
    expect(await dockerInspect(socket, ID)).toMatchObject({ healthyAt: "2026-10-27T10:00:35Z" });
  });

  it("inspect: Pid zero, negativo, decimal ou texto não vira PID (container parado tem Pid 0)", async () => {
    for (const pid of [0, -5, 1.5, "12", null]) {
      handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ State: { Status: "exited", Pid: pid, OOMKilled: "true" } }));
      expect(await dockerInspect(socket, ID)).toMatchObject({ pid: null, oomKilled: false });
    }
  });

  it("inspect: 404, JSON inválido, não-objeto, id ruim e socket inexistente dão null", async () => {
    expect(await dockerInspect(socket, ID)).toBeNull();
    handler = (_req, res) => res.writeHead(200).end("não é json");
    expect(await dockerInspect(socket, ID)).toBeNull();
    handler = (_req, res) => res.writeHead(200).end("null");
    expect(await dockerInspect(socket, ID)).toBeNull();
    handler = (_req, res) => res.writeHead(200).end("{}");
    expect(await dockerInspect(socket, "../x")).toBeNull();
    expect(await dockerInspect(path.join(tmp, "nao.sock"), ID)).toBeNull();
  });
});
