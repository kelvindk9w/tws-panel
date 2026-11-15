/**
 * painel-sem-socket-docker.test.ts — o painel subido com a configuração padrão (sem DOCKER_HOST nem
 * DOCKER_SOCKET_PATH do teste) não tenta conexão nenhuma com o socket do Docker da máquina.
 *
 * Na subida, o painel varre os helpers de terminal órfãos pela API do Docker (lista containers e REMOVE à força os
 * paas-terminal-*). Nos testes, o setup do servidor aponta DOCKER_SOCKET_PATH para SOCKET_DUBLE (pasta temporária
 * que não existe): o reaper roda, chega ao dublê e falha sozinho; o /var/run/docker.sock nunca é procurado. As
 * conexões são observadas no net.Socket, abaixo de qualquer cliente HTTP, e o registro da barreira tem de ficar
 * vazio.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SOCKET_DUBLE } from "./helpers/docker-duble.js";
import { removeDir } from "./helpers/tmp.js";

const KEYS = ["RATE_LIMIT_MAX", "PAAS_DATA_DIR", "SETUP_TOKEN_FILE", "PAAS_PUBLIC_IP", "LOG_LEVEL", "PAAS_PROJECTS_DIR", "PAAS_TEST_DOCKER_LOG"] as const;
const saved: Record<string, string | undefined> = {};
const conexoes: string[] = [];
let dir: string;
let registro: string;
let app: FastifyInstance | undefined;

function caminho(args: unknown[]): string | null {
  const a = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof a === "string" && !/^\d+$/.test(a)) return a;
  if (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") return (a as { path: string }).path;
  return null;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-sem-socket-"));
  registro = path.join(dir, "registro-barreira.log");
  for (const k of KEYS) saved[k] = process.env[k];
  await writeFile(path.join(dir, "setup-token"), "token-de-teste");
  Object.assign(process.env, {
    RATE_LIMIT_MAX: "1000000",
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
    PAAS_PROJECTS_DIR: path.join(dir, "projects"),
    // só o deste arquivo: o que interessa é ver se ESTE painel caiu na barreira
    PAAS_TEST_DOCKER_LOG: registro,
  });
  const original = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const alvo = caminho(args);
    if (alvo) conexoes.push(alvo);
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await removeDir(dir);
});

describe("painel com a configuração padrão, nos testes", () => {
  it("o socket do Docker da configuração é o dublê (pasta temporária que não existe)", () => {
    expect(app!.config.dockerSocketPath).toBe(SOCKET_DUBLE);
  });

  it("o reaper da subida vai ao dublê e nenhuma conexão procura o socket do Docker da máquina", async () => {
    await vi.waitFor(() => expect(conexoes).toContain(SOCKET_DUBLE), { timeout: 15_000 });
    const docker = conexoes.filter((c) => /docker[^/]*\.sock$/.test(c) && c !== SOCKET_DUBLE);
    expect(docker).toEqual([]);
    expect(conexoes).not.toContain("/var/run/docker.sock");
    expect(conexoes).not.toContain("/run/docker.sock");
  });

  it("o registro da barreira continua vazio", async () => {
    const texto = await readFile(registro, "utf8").catch(() => "");
    expect(texto).toBe("");
  });
});
