/**
 * Segredos do painel para a máscara dos logs do servidor: arquivos de chave da pasta de dados e fontes cifradas.
 * Falha fechada: fonte que lança derruba a coleta (a página responde 503 em vez de mostrar log sem máscara).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_FILES, collectPanelSecrets } from "../src/services/panel-secrets.js";
import { deriveMcpSetupCredential } from "../src/services/setup-token.js";
import { removeDir } from "./helpers/tmp.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-panel-secrets-"));
});
afterEach(async () => {
  await removeDir(dir);
});

describe("collectPanelSecrets", () => {
  it("lê os arquivos de chave que existem, as fontes e o setup token (com a credencial derivada)", async () => {
    await writeFile(path.join(dir, "session-secret"), "a".repeat(64) + "\n");
    await writeFile(path.join(dir, "credentials-key"), "b".repeat(64));
    await writeFile(path.join(dir, "backups-key"), "\n");
    const out = await collectPanelSecrets({
      dataDir: dir,
      setupToken: "setup-token-123456",
      providers: [async () => ["cf-token-abcdefgh"], async () => [], async () => ["s3-key-abcdefgh", ""]],
    });
    expect(out).toEqual(["a".repeat(64), "b".repeat(64), "cf-token-abcdefgh", "s3-key-abcdefgh", "setup-token-123456", deriveMcpSetupCredential("setup-token-123456")]);
    expect(KEY_FILES).toContain("two-factor-key");
  });

  it("sem setup token e sem arquivos: lista vazia", async () => {
    expect(await collectPanelSecrets({ dataDir: dir, setupToken: null, providers: [] })).toEqual([]);
    expect(await collectPanelSecrets({ dataDir: dir, providers: [] })).toEqual([]);
  });

  it("falha fechada: fonte que lança lança", async () => {
    await expect(collectPanelSecrets({ dataDir: dir, providers: [async () => Promise.reject(new Error("cofre"))] })).rejects.toThrow("cofre");
  });

  it("falha fechada: arquivo de chave ilegível (não é 'ainda não existe') lança", async () => {
    // "session-secret" vira uma PASTA: a leitura falha com EISDIR
    await mkdir(path.join(dir, "session-secret"));
    await expect(collectPanelSecrets({ dataDir: dir, providers: [] })).rejects.toMatchObject({ code: "EISDIR" });
  });
});
