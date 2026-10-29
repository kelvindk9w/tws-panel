/**
 * Eventos do terminal na Auditoria nunca saem como `token:<nome>`: a sessão do
 * PTY vive mais que a requisição de token que por acaso a abriu, e o contexto
 * de ator da requisição (AsyncLocalStorage) seguiria junto com os callbacks.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithActor } from "../src/services/request-actor.js";
import type { RemotePty } from "../src/services/docker-socket.js";

const saved: Record<string, string | undefined> = {};
let dir = "";

function fakePty(): RemotePty & { finish(): void } {
  const stream = new Duplex({ write: (_c, _e, cb) => cb(), read: () => undefined });
  return { stream, resize: () => undefined, kill: async () => undefined, finish: () => stream.push(null) };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-term-actor-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste");
  for (const [k, v] of Object.entries({
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
  })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("auditoria do terminal e o ator de token", () => {
  it("sessão aberta durante uma requisição de token e encerrada depois: os eventos saem como 'operador'", async () => {
    const pty = fakePty();
    const app = await buildApp({ terminalPtyFactory: async () => pty });
    try {
      await app.ready();
      // O SecurityService liga o terminal ao Docker do alvo (cria o container de teste);
      // nenhum teste pode tocar o Docker real.
      app.terminalService.setEnsureTarget(undefined);
      // o que uma rota chamada por token faz ao tocar o terminal compartilhado
      await runWithActor("token:agente", () => app.terminalService.connect());
      pty.finish();
      // espera o evento de fim de sessão chegar à Auditoria (sem depender de um tempo fixo)
      let entries: Awaited<ReturnType<typeof app.auditService.list>>["entries"] = [];
      for (let i = 0; i < 200 && entries.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
        await app.auditService.flush();
        entries = (await app.auditService.list()).entries.filter((e) => e.action.startsWith("terminal."));
      }
      expect(entries.map((e) => e.action).sort()).toEqual(["terminal.session", "terminal.session-end"]);
      for (const e of entries) expect(e.actor, e.action).toBe("operador");
    } finally {
      await app.close();
    }
  });
});
