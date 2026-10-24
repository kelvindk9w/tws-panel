/**
 * panel-restore.test.ts — a troca do estado do painel na subida seguinte à
 * restauração (antes de qualquer serviço ler o disco).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

    const result = await applyPendingPanelRestore(dir, { now: () => new Date("2026-10-14T12:01:00Z") });
    expect(result).toMatchObject({ outcome: "applied", error: null });
    expect(result?.marker.fileName).toBe("2026-10-14_03-00.7z");
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

  it("api-tokens.json fica como está: a restauração não ressuscita token revogado depois do backup", async () => {
    await put("users.json", "atual");
    await put("api-tokens.json", "so-os-tokens-de-agora");
    await put("backups/.restaurar-painel/users.json", "do-backup");
    await put("backups/.restaurar-painel/api-tokens.json", "token-revogado-que-voltaria");
    await put(
      "backups/.restaurar-painel.json",
      JSON.stringify({ requestedAt: "2026-10-14T12:00:00Z", fileName: "2026-10-14_03-00.7z", actor: "admin" }),
    );
    const result = await applyPendingPanelRestore(dir, { now: () => new Date("2026-10-14T12:01:00Z") });
    expect(result).toMatchObject({ outcome: "applied" });
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe("do-backup");
    expect(await readFile(path.join(dir, "api-tokens.json"), "utf8")).toBe("so-os-tokens-de-agora");
    // nem na cópia "antes da restauração": o arquivo nunca saiu do lugar
    expect(existsSync(path.join(dir, "backups/_painel/antes-da-restauracao/api-tokens.json"))).toBe(false);
  });

  it("assunto e corpo dos envios nunca vão para a cópia 'antes da restauração' (escapariam da retenção)", async () => {
    await put("users.json", "atual");
    await put("envios-conteudo/123.json", "segredo");
    await put("backups/.restaurar-painel/users.json", "do-backup");
    await put("backups/.restaurar-painel/envios-conteudo/999.json", "de-outro-backup");
    await put(
      "backups/.restaurar-painel.json",
      JSON.stringify({ requestedAt: "2026-10-14T12:00:00Z", fileName: "2026-10-14_03-00.7z", actor: "admin" }),
    );
    const result = await applyPendingPanelRestore(dir, { now: () => new Date("2026-10-14T12:01:00Z") });
    expect(result?.outcome).toBe("applied");
    // continua onde a retenção e o "desligar apaga" o alcançam
    expect(await readFile(path.join(dir, "envios-conteudo/123.json"), "utf8")).toBe("segredo");
    expect(existsSync(path.join(dir, "envios-conteudo/999.json"))).toBe(false);
    expect(existsSync(path.join(dir, "backups/_painel/antes-da-restauracao/envios-conteudo"))).toBe(false);
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

  it("o que volta fica só para o dono: arquivos 0600 (0700 se executável) e pastas 0700", async () => {
    await put("backups/.restaurar-painel/users.json", "do-backup");
    await put("backups/.restaurar-painel/backups-key", "chave");
    await put("backups/.restaurar-painel/certificates/site/key.pem", "chave-tls");
    await put("backups/.restaurar-painel/ferramentas/rodar.sh", "#!/bin/sh");
    const staged = path.join(dir, "backups/.restaurar-painel");
    // Como chegaria de um .7z feito no Windows ou com umask aberto.
    await chmod(path.join(staged, "users.json"), 0o644);
    await chmod(path.join(staged, "backups-key"), 0o600);
    await chmod(path.join(staged, "certificates/site/key.pem"), 0o666);
    await chmod(path.join(staged, "certificates/site"), 0o755);
    await chmod(path.join(staged, "certificates"), 0o775);
    await chmod(path.join(staged, "ferramentas/rodar.sh"), 0o755);
    await put("backups/.restaurar-painel.json", JSON.stringify({ requestedAt: "x", fileName: "y", actor: "z" }));

    await applyPendingPanelRestore(dir);

    const mode = async (rel: string) => (await stat(path.join(dir, rel))).mode & 0o777;
    expect(await mode("users.json")).toBe(0o600);
    expect(await mode("backups-key")).toBe(0o600);
    expect(await mode("certificates")).toBe(0o700);
    expect(await mode("certificates/site")).toBe(0o700);
    expect(await mode("certificates/site/key.pem")).toBe(0o600);
    expect(await mode("ferramentas/rodar.sh")).toBe(0o700);
    expect(await mode("backups-history.json")).toBe(0o600);
    // Mesmo dono do processo do painel (quem vai ler e gravar esses arquivos).
    expect((await stat(path.join(dir, "users.json"))).uid).toBe(process.getuid!());
  });

  it("um link simbólico que veio no backup não leva o chmod para fora do diretório de dados", async () => {
    const fora = path.join(dir, "..", `${path.basename(dir)}-fora.txt`);
    await writeFile(fora, "fora");
    await chmod(fora, 0o644);
    await put("backups/.restaurar-painel/users.json", "do-backup");
    await symlink(fora, path.join(dir, "backups/.restaurar-painel/atalho"));
    await put("backups/.restaurar-painel.json", JSON.stringify({ requestedAt: "x", fileName: "y", actor: "z" }));
    await applyPendingPanelRestore(dir);
    expect((await stat(fora)).mode & 0o777).toBe(0o644);
    await rm(fora, { force: true });
  });
});
