/**
 * notification-close-app.test.ts — com o painel real, fechar logo depois de
 * disparar a carga preguiçosa das notificações não deixa NENHUM arquivo novo ou
 * alterado na pasta de dados depois do app.close() (era a causa do ENOTEMPTY).
 * Repetido em laço curto: a corrida só aparecia em parte das rodadas.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { RemotePty } from "../src/services/docker-socket.js";
import { removeDir } from "./helpers/tmp.js";

const saved: Record<string, string | undefined> = {};
let root = "";

function fakePty(): RemotePty {
  const stream = new Duplex({ write: (_c, _e, cb) => cb(), read: () => undefined });
  return { stream, resize: () => undefined, kill: async () => undefined };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-notif-app-"));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await removeDir(root);
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).filter((n) => n.startsWith("notifications")).sort()) {
    out[name] = await readFile(path.join(dir, name), "utf8").catch(() => "<sumiu>");
  }
  return out;
}

describe("app.close() e as notificações", () => {
  it("nada de notifications* aparece ou muda na pasta de dados depois do close (12 rodadas)", async () => {
    for (let round = 0; round < 12; round++) {
      const dir = path.join(root, `r${round}`);
      await removeDir(dir);
      await writeFile(path.join(root, `setup-${round}`), "token-de-teste");
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
      for (const [k, v] of Object.entries({
        PAAS_DATA_DIR: dir,
        SETUP_TOKEN_FILE: path.join(root, `setup-${round}`),
        PAAS_PUBLIC_IP: "203.0.113.10",
        LOG_LEVEL: "silent",
      })) {
        if (!(k in saved)) saved[k] = process.env[k];
        process.env[k] = v;
      }
      const app = await buildApp({ terminalPtyFactory: async () => fakePty() });
      await app.ready();
      app.terminalService.setEnsureTarget(undefined); // nenhum teste toca o Docker real
      // dispara a carga preguiçosa (cria a chave) e fecha na hora, sem esperar
      void app.notificationService.tick().catch(() => undefined);
      await app.close();
      const logoDepois = await snapshot(dir);
      await new Promise((r) => setTimeout(r, 120));
      expect(await snapshot(dir), `rodada ${round}`).toEqual(logoDepois);
      // e a pasta pode ser apagada sem ENOTEMPTY
      await rm(dir, { recursive: true });
    }
  }, 120_000);
});
