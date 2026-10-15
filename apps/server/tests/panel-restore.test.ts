/**
 * panel-restore.test.ts — a troca do estado do painel na subida seguinte à
 * restauração (antes de qualquer serviço ler o disco).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPendingPanelRestore } from "../src/services/panel-restore.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-panel-restore-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
}

describe("restauração do painel na subida", () => {
  it("sem marcador: não mexe em nada", async () => {
    await put("users.json", "atual");
    expect(await applyPendingPanelRestore(dir)).toBeNull();
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe("atual");
  });

  it("troca o estado, guarda o anterior e mantém backups, setup-token e projects", async () => {
    await put("users.json", "atual");
    await put("mail/config.json", "atual");
    await put("setup-token", "token-desta-vps");
    await put("projects/site/src/index.html", "codigo");
    await put("backups/loja/2026-10-14_03-00.7z", "copia");
    await put("backups/.restaurar-painel/users.json", "do-backup");
    await put("backups/.restaurar-painel/backups-key", "chave");
    await put("backups/.restaurar-painel/setup-token", "token-antigo");
    await put("backups/.restaurar-painel/LEIA-ME.txt", "leia");
    await put("backups/.restaurar-painel/manifesto.json", "{}");
    await put("backups/.restaurar-painel/backups-history.json", JSON.stringify({ entries: [] }));
    await put(
      "backups/.restaurar-painel.json",
      JSON.stringify({ requestedAt: "2026-10-14T12:00:00Z", fileName: "2026-10-14_03-00.7z", actor: "admin" }),
    );

    const marker = await applyPendingPanelRestore(dir, () => new Date("2026-10-14T12:01:00Z"));
    expect(marker?.fileName).toBe("2026-10-14_03-00.7z");
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe("do-backup");
    expect(await readFile(path.join(dir, "backups-key"), "utf8")).toBe("chave");
    expect(existsSync(path.join(dir, "mail"))).toBe(false);
    expect(await readFile(path.join(dir, "setup-token"), "utf8")).toBe("token-desta-vps");
    expect(await readFile(path.join(dir, "projects/site/src/index.html"), "utf8")).toBe("codigo");
    expect(await readFile(path.join(dir, "backups/loja/2026-10-14_03-00.7z"), "utf8")).toBe("copia");
    expect(existsSync(path.join(dir, "LEIA-ME.txt"))).toBe(false);
    expect(await readFile(path.join(dir, "backups/_painel/antes-da-restauracao/users.json"), "utf8")).toBe("atual");
    expect(await readFile(path.join(dir, "backups/_painel/antes-da-restauracao/mail/config.json"), "utf8")).toBe("atual");
    expect(existsSync(path.join(dir, "backups/.restaurar-painel"))).toBe(false);
    expect(existsSync(path.join(dir, "backups/.restaurar-painel.json"))).toBe(false);
    const history = JSON.parse(await readFile(path.join(dir, "backups-history.json"), "utf8")) as { entries: Array<{ operation: string; status: string }> };
    expect(history.entries.at(-1)).toMatchObject({ operation: "restore", status: "success" });
  });

  it("marcador estragado ou sem a pasta extraída: só apaga o marcador", async () => {
    await put("users.json", "atual");
    await put("backups/.restaurar-painel.json", "{");
    expect(await applyPendingPanelRestore(dir)).toBeNull();
    await put("backups/.restaurar-painel.json", JSON.stringify({ requestedAt: "x", fileName: "y", actor: "z" }));
    expect(await applyPendingPanelRestore(dir)).toBeNull();
    expect(existsSync(path.join(dir, "backups/.restaurar-painel.json"))).toBe(false);
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe("atual");
  });

  it("histórico estragado no backup: começa um novo", async () => {
    await put("backups/.restaurar-painel/backups-history.json", "{");
    await put("backups/.restaurar-painel.json", JSON.stringify({ requestedAt: "x", fileName: "y", actor: "z" }));
    await applyPendingPanelRestore(dir);
    const history = JSON.parse(await readFile(path.join(dir, "backups-history.json"), "utf8")) as { entries: unknown[] };
    expect(history.entries).toHaveLength(1);
  });
});
