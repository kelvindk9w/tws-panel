/**
 * Lote 6 / M6 — erro passageiro ao LER uma chave não pode gerar uma chave nova.
 *
 * Antes: credential-vault, backups, notificações e sessões trocavam qualquer
 * erro de leitura (E/S, permissão) por uma chave nova gravada por cima, e tudo
 * que estava cifrado com a antiga ficava ilegível para sempre. Agora a carga
 * falha (fechada), o arquivo da chave fica como estava e, passado o erro, a
 * MESMA chave volta a valer.
 *
 * Arquivo separado: o mock de node:fs/promises vale para o módulo todo.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const falha = vi.hoisted(() => ({ arquivo: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (async (...args: Parameters<typeof original.readFile>) => {
      if (falha.arquivo && String(args[0]).endsWith(falha.arquivo)) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      return original.readFile(...args);
    }) as typeof original.readFile,
  };
});

const { CredentialVault } = await import("../src/services/credential-vault.js");
const { SessionStore } = await import("../src/services/session-store.js");
const { NotificationService } = await import("../src/services/notification-service.js");
const { BackupService } = await import("../src/services/backup-service.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-chaves-"));
  falha.arquivo = null;
});
afterEach(async () => {
  falha.arquivo = null;
  await rm(dir, { recursive: true, force: true });
});

const lerChave = (nome: string) => readFile(path.join(dir, nome), "utf8");

describe("M6 — chave ilegível por erro passageiro", () => {
  it("cofre de credenciais: falha fechada, chave intacta, volta a decifrar depois", async () => {
    const primeiro = new CredentialVault(dir);
    await primeiro.set("p1", { username: "u", token: "token-secreto-1234" });
    const antes = await lerChave("credentials-key");

    falha.arquivo = "credentials-key";
    const durante = new CredentialVault(dir);
    await expect(durante.get("p1")).rejects.toThrow();
    falha.arquivo = null;
    expect(await lerChave("credentials-key")).toBe(antes);

    expect(await new CredentialVault(dir).get("p1")).toEqual({ username: "u", token: "token-secreto-1234" });
  });

  it("sessões: falha fechada, segredo intacto, cookie antigo segue valendo", async () => {
    const primeiro = new SessionStore(dir);
    const { cookieValue } = await primeiro.create({ id: "u1", username: "admin" });
    const antes = await lerChave("session-secret");

    falha.arquivo = "session-secret";
    await expect(new SessionStore(dir).init()).rejects.toThrow();
    falha.arquivo = null;
    expect(await lerChave("session-secret")).toBe(antes);

    expect((await new SessionStore(dir).resolve(cookieValue))?.username).toBe("admin");
  });

  it("sessões: segredo com 32+ caracteres que não são hexa não vira chave vazia", async () => {
    await writeFile(path.join(dir, "session-secret"), "z".repeat(40) + "\n");
    const store = new SessionStore(dir);
    const { cookieValue } = await store.create({ id: "u1", username: "admin" });
    const [id, assinatura] = [cookieValue.split(".")[0]!, cookieValue.split(".")[1]!];
    // a assinatura vem de um segredo de 32 bytes, não de uma chave vazia
    expect(assinatura).not.toBe(createHmac("sha256", Buffer.alloc(0)).update(id).digest("hex"));
    expect((await lerChave("session-secret")).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("notificações: falha fechada, o token do Telegram segue legível depois", async () => {
    const opcoes = {
      dataDir: dir,
      telegram: {
        getMe: async () => ({ username: "bot", name: "Bot" }),
        findLatestChat: async () => null,
        sendMessage: async () => undefined,
      },
      audit: { record: async () => undefined },
      log: () => undefined,
    } as unknown as ConstructorParameters<typeof NotificationService>[0];
    const primeiro = new NotificationService(opcoes);
    await primeiro.setTelegramToken("123456789:AAEXEMPLOxxxxxxxxxxxxxxxxxxxxxxxxxx", "admin");
    await primeiro.flush();
    const antes = await lerChave("notifications-key");

    falha.arquivo = "notifications-key";
    await expect(new NotificationService(opcoes).status()).rejects.toThrow();
    falha.arquivo = null;
    expect(await lerChave("notifications-key")).toBe(antes);

    const depois = new NotificationService(opcoes);
    await depois.status();
    expect(await lerChave("notifications-key")).toBe(antes);
  });

  it("backups: falha fechada, a chave dos segredos do destino não é trocada", async () => {
    const opcoes = (): ConstructorParameters<typeof BackupService>[0] =>
      ({
        dataDir: dir,
        projectsDir: path.join(dir, "projects"),
        docker: {},
        archiver: { available: async () => true },
        storage: () => ({}),
        projects: { list: async () => [], get: async () => null, srcDir: () => dir, redeploy: async () => undefined },
        mail: {},
        verifyLogin: async () => true,
        log: () => undefined,
      }) as unknown as ConstructorParameters<typeof BackupService>[0];
    const primeiro = new BackupService(opcoes());
    await primeiro.status();
    await primeiro.flush();
    const antes = await lerChave("backups-key");

    falha.arquivo = "backups-key";
    const durante = new BackupService(opcoes());
    await expect(durante.status()).rejects.toThrow();
    falha.arquivo = null;
    expect(await lerChave("backups-key")).toBe(antes);
  });
});
