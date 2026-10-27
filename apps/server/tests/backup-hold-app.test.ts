/**
 * Backup/restauração reservam o deploy — a ligação que só existe em app.ts, com o app de verdade (buildApp):
 * o motivo da reserva ("Backup em andamento") tem de chegar à recusa do deploy. O Docker nunca roda.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const saved: Record<string, string | undefined> = {};
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-hold-app-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste-reserva");
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
  await rm(dir, { recursive: true, force: true });
});

describe("reserva do deploy pelo backup (ligação real de app.ts)", () => {
  it("o hold que o BackupService recebe leva o motivo até a recusa do deploy", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const created = await app.deployService.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "loja.example.com" });
      // a função de reserva é a MESMA que o app.ts entrega ao BackupService
      const hold = (app.backupService as unknown as { opts: { projects: { hold: (id: string, reason?: string) => Promise<() => void> } } }).opts.projects.hold;
      const release = await hold(created.id, "Backup em andamento");
      await expect(app.deployService.startDeploy(created.id)).rejects.toMatchObject({
        code: "deploy_in_progress",
        message: expect.stringMatching(/^Backup em andamento neste projeto\./),
      });
      release();
      // solta: a mensagem comum volta
      const again = await hold(created.id);
      await expect(app.deployService.startDeploy(created.id)).rejects.toMatchObject({ message: expect.stringMatching(/Já existe um deploy em andamento/) });
      again();
    } finally {
      await app.close();
    }
  }, 30_000);
});
