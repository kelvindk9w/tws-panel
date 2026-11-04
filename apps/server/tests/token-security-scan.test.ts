/**
 * Token de API e a varredura de segurança: sem relatório guardado, o GET não
 * dispara a varredura completa (ela roda no terminal root compartilhado); a
 * pessoa, no painel, continua gerando o primeiro relatório.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { buildApp } from "../src/app.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { sessionCookieOf } from "./test-utils.js";
import { removeDir } from "./helpers/tmp.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const saved: Record<string, string | undefined> = {};
let dir = "";
let opened = 0;

function fakePty(): RemotePty {
  const stream = new Duplex({ write: (_c, _e, cb) => cb(), read: () => undefined });
  return { stream, resize: () => undefined, kill: async () => undefined };
}

beforeEach(async () => {
  opened = 0;
  dir = await mkdtemp(path.join(tmpdir(), "paas-token-scan-"));
  await writeFile(path.join(dir, "setup-token"), SETUP);
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
  await removeDir(dir);
});

describe("GET /api/security/scan com token de leitura", () => {
  it("sem relatório guardado: 404 'sem relatório' e a varredura NÃO roda; com relatório em cache, responde", async () => {
    const app = await buildApp({ terminalPtyFactory: async () => (opened++, fakePty()) });
    try {
      await app.ready();
      app.terminalService.setEnsureTarget(undefined); // nenhum teste toca o Docker real
      const created = await app.inject({
        method: "POST",
        url: "/api/setup/admin",
        headers: { [SETUP_TOKEN_HEADER]: SETUP },
        payload: { username: "admin", password: PASSWORD },
      });
      expect(created.statusCode).toBe(201);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
      const cookie = sessionCookieOf(login);
      const made = await app.inject({
        method: "POST",
        url: "/api/settings/api-tokens",
        headers: { cookie },
        payload: { name: "leitor", scope: "read", currentPassword: PASSWORD },
      });
      expect(made.statusCode).toBe(201);
      const bearer = { authorization: `Bearer ${made.json().token as string}` };

      const none = await app.inject({ method: "GET", url: "/api/security/scan", headers: bearer });
      expect(none.statusCode).toBe(404);
      expect(none.json().error).toBe("scan_not_available");
      // a varredura teria aberto o terminal do servidor: nada foi aberto
      expect(opened).toBe(0);

      // com relatório já guardado, o token lê o cache
      await writeFile(
        path.join(dir, "security-last-scan.json"),
        JSON.stringify({ id: "scan-1", scannedAt: "2026-10-22T12:00:00.000Z", target: "container:fake", checks: [] }),
      );
      const cached = await app.inject({ method: "GET", url: "/api/security/scan", headers: bearer });
      expect(cached.statusCode).toBe(200);
      expect(cached.json().cached).toBe(true);
      expect(opened).toBe(0);
    } finally {
      await app.close();
    }
  }, 60_000);
});
