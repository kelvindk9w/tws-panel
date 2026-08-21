/**
 * docker-socket.test.ts — reaper de helpers paas-terminal-* órfãos no boot.
 *
 * Usa um servidor HTTP real escutando num unix socket temporário (mesma
 * forma de falar do cliente): verifica de verdade quais containers seriam
 * removidos — só os que batem o padrão EXATO paas-terminal-<8 hex>.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerSocketError, removeOrphanTerminalHelpers } from "../src/services/docker-socket.js";

interface MockState {
  containers: Array<{ Id: string; Names: string[] }>;
  deleted: string[];
  listStatus: number;
}

let server: http.Server | null = null;
let socketPath = "";
let tmp = "";
let state: MockState;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-docker-mock-"));
  socketPath = path.join(tmp, "docker.sock");
  state = { containers: [], deleted: [], listStatus: 200 };
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/containers/json")) {
      res.writeHead(state.listStatus, { "content-type": "application/json" });
      res.end(
        state.listStatus === 200
          ? JSON.stringify(state.containers)
          : JSON.stringify({ message: "daemon indisponível" }),
      );
      return;
    }
    const del = /^DELETE \/containers\/([^?]+)\?force=true$/.exec(`${req.method} ${req.url}`);
    if (del) {
      state.deleted.push(decodeURIComponent(del[1] ?? ""));
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await rm(tmp, { recursive: true, force: true });
});

describe("removeOrphanTerminalHelpers", () => {
  it("remove SÓ containers com o padrão exato paas-terminal-<8 hex>", async () => {
    state.containers = [
      { Id: "aaa111", Names: ["/paas-terminal-1a2b3c4d"] }, // órfão do painel → remove
      { Id: "bbb222", Names: ["/paas-terminal-custom"] }, // nome parecido do usuário → NÃO toca
      { Id: "ccc333", Names: ["/paas-terminal-1a2b3c4d5e"] }, // hex longo demais → NÃO toca
      { Id: "ddd444", Names: ["/meu-app"] }, // container do usuário → NÃO toca
      { Id: "eee555", Names: ["/paas-terminal-9f8e7d6c"] }, // outro órfão → remove
    ];

    const removed = await removeOrphanTerminalHelpers(socketPath);

    expect(removed).toEqual(["paas-terminal-1a2b3c4d", "paas-terminal-9f8e7d6c"]);
    expect(state.deleted).toEqual(["aaa111", "eee555"]);
  });

  it("sem órfãos: não remove nada e não chama DELETE", async () => {
    state.containers = [{ Id: "ddd444", Names: ["/meu-app"] }];
    const removed = await removeOrphanTerminalHelpers(socketPath);
    expect(removed).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  it("falha ao listar propaga DockerSocketError (caller loga como não fatal)", async () => {
    state.listStatus = 500;
    await expect(removeOrphanTerminalHelpers(socketPath)).rejects.toBeInstanceOf(DockerSocketError);
    expect(state.deleted).toEqual([]);
  });
});
