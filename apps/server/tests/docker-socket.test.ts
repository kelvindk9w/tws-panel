/**
 * docker-socket.test.ts — reaper de helpers paas-terminal-* órfãos, no boot
 * E periodicamente (verificação recorrente — não só ao reiniciar o painel).
 *
 * Usa um servidor HTTP real escutando num unix socket temporário (mesma
 * forma de falar do cliente): verifica de verdade quais containers seriam
 * removidos — só os que batem o padrão EXATO paas-terminal-<8 hex>, e NUNCA
 * o helper de uma sessão ativa deste processo.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSocketError,
  createDockerPtyFactory,
  removeOrphanTerminalHelpers,
  scheduleOrphanTerminalHelperReap,
} from "../src/services/docker-socket.js";
import type { ServerConfig } from "../src/config.js";

interface MockState {
  containers: Array<{ Id: string; Names: string[] }>;
  deleted: string[];
  listStatus: number;
}

let server: http.Server | null = null;
let socketPath = "";
let tmp = "";
let state: MockState;
let upgradedSockets: Set<import("node:stream").Duplex>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-docker-mock-"));
  socketPath = path.join(tmp, "docker.sock");
  state = { containers: [], deleted: [], listStatus: 200 };
  upgradedSockets = new Set();
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
    // imagem "sempre presente" — o teste do helper ativo não exercita pull.
    if (req.method === "GET" && req.url?.startsWith("/images/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: "sha256:fake" }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/containers/create")) {
      const name = new URL(req.url, "http://docker").searchParams.get("name") ?? "sem-nome";
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        state.containers.push({ Id: name, Names: [`/${name}`] });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: name }));
      });
      return;
    }
    if (req.method === "POST" && /^\/containers\/[^/]+\/start$/.test(req.url ?? "")) {
      res.writeHead(204);
      res.end();
      return;
    }
    const del = /^DELETE \/containers\/([^?]+)\?force=true$/.exec(`${req.method} ${req.url}`);
    if (del) {
      const id = decodeURIComponent(del[1] ?? "");
      state.deleted.push(id);
      state.containers = state.containers.filter((c) => c.Id !== id);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: "not found" }));
  });
  // hijack (POST .../attach): responde com 101 Upgrade e mantém o socket
  // aberto — só precisa existir para openHostPty() resolver o RemotePty.
  // O socket do LADO DO SERVIDOR fica rastreado em upgradedSockets: sem
  // destruí-lo explicitamente no afterEach, server.close() trava para
  // sempre — mesmo com closeAllConnections() — porque uma conexão
  // "upgraded" (hijacked) não é liberada só por o CLIENTE destruir a dele.
  server.on("upgrade", (req, socket) => {
    if (req.url?.includes("/attach")) {
      upgradedSockets.add(socket);
      socket.on("close", () => upgradedSockets.delete(socket));
      socket.write("HTTP/1.1 101 UPGRADE\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      return;
    }
    socket.destroy();
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
});

afterEach(async () => {
  if (server) {
    for (const socket of upgradedSockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
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

/**
 * Bug do review 2026-08-24 (reaper-so-no-boot): a varredura só rodava no
 * boot — um leak por caminho de erro não coberto só seria limpo no próximo
 * restart. Mas uma varredura periódica ingênua (repetir a mesma lógica do
 * boot) removeria o helper de uma sessão de terminal ATIVA por baixo do
 * usuário, já que ele bate o mesmo padrão de nome paas-terminal-*. Por isso
 * a proteção abaixo é o requisito central do fix, testado separado da
 * simples repetição no tempo.
 */
describe("proteção do helper de sessão ativa", () => {
  const hostConfig = {
    dockerSocketPath: "",
    securityTarget: "host" as const,
    hostHelperImage: "alpine:3",
  } as unknown as ServerConfig;

  it("removeOrphanTerminalHelpers NUNCA remove o helper de uma sessão aberta por este processo", async () => {
    const factory = createDockerPtyFactory({ ...hostConfig, dockerSocketPath: socketPath });
    const pty = await factory();
    try {
      // o helper existe no daemon E bate o padrão paas-terminal-<8 hex> —
      // uma varredura ingênua o trataria como órfão.
      expect(state.containers).toHaveLength(1);
      const activeName = state.containers[0]!.Names[0]!.replace(/^\//, "");
      expect(activeName).toMatch(/^paas-terminal-[0-9a-f]{8}$/);

      const removed = await removeOrphanTerminalHelpers(socketPath);

      expect(removed).toEqual([]);
      expect(state.deleted).toEqual([]);
      expect(state.containers).toHaveLength(1); // continua vivo
    } finally {
      await pty.kill();
    }
  });

  it("depois de kill(), o helper deixa de ser protegido e volta a ser elegível para o reaper", async () => {
    const factory = createDockerPtyFactory({ ...hostConfig, dockerSocketPath: socketPath });
    const pty = await factory();
    const activeName = state.containers[0]!.Names[0]!.replace(/^\//, "");
    await pty.kill(); // sessão encerrada normalmente (equivalente a handleSessionEnd)

    // kill() já chama DELETE — mas simula o cenário do bug (caminho de erro
    // que NÃO limpou o container): ele reaparece no daemon como se o
    // AutoRemove não tivesse disparado, e a varredura deve pegá-lo agora.
    state.containers.push({ Id: activeName, Names: [`/${activeName}`] });
    const removed = await removeOrphanTerminalHelpers(socketPath);
    expect(removed).toEqual([activeName]);
  });
});

describe("scheduleOrphanTerminalHelperReap", () => {
  it("repete a varredura periodicamente E respeita a proteção do helper ativo", async () => {
    state.containers = [{ Id: "aaa111", Names: ["/paas-terminal-1a2b3c4d"] }];
    const timer = scheduleOrphanTerminalHelperReap(socketPath, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(state.deleted).toContain("aaa111");
    } finally {
      clearInterval(timer);
    }
  });

  it("o timer é unref()'d — não mantém o processo vivo sozinho", () => {
    const timer = scheduleOrphanTerminalHelperReap(socketPath, 60_000);
    try {
      // NodeJS.Timeout tem hasRef() quando unref()'d corretamente.
      expect((timer as unknown as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
