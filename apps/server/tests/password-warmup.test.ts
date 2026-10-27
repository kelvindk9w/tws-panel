/**
 * password-warmup.test.ts — o hash fictício do login é gerado na
 * INICIALIZAÇÃO (e não no primeiro pedido com usuário inexistente), e o
 * buildApp de verdade faz essa chamada.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ hash: vi.fn(), warm: vi.fn() }));

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  spies.hash.mockImplementation(actual.hash);
  return { ...actual, hash: spies.hash };
});

describe("warmUpDummyHash (módulo)", () => {
  beforeEach(() => {
    vi.resetModules();
    spies.hash.mockClear();
  });

  it("gera o hash fictício na hora e o primeiro pedido com usuário inexistente não gera outro", async () => {
    const { warmUpDummyHash, verifyPasswordTimingSafe } = await import("../src/services/password.js");
    expect(spies.hash).not.toHaveBeenCalled();
    await warmUpDummyHash();
    expect(spies.hash).toHaveBeenCalledTimes(1);
    await warmUpDummyHash(); // idempotente
    expect(await verifyPasswordTimingSafe(null, "qualquer")).toBe(false);
    expect(spies.hash).toHaveBeenCalledTimes(1);
  });

  it("sem aquecer, o hash só nasce no primeiro pedido (a diferença que o aquecimento evita)", async () => {
    const { verifyPasswordTimingSafe } = await import("../src/services/password.js");
    expect(await verifyPasswordTimingSafe(null, "qualquer")).toBe(false);
    expect(spies.hash).toHaveBeenCalledTimes(1);
  });

  it("falha ao gerar não derruba: tenta de novo no primeiro uso", async () => {
    spies.hash.mockRejectedValueOnce(new Error("sem memória"));
    const { warmUpDummyHash, verifyPasswordTimingSafe } = await import("../src/services/password.js");
    await expect(warmUpDummyHash()).resolves.toBeUndefined();
    expect(await verifyPasswordTimingSafe(null, "qualquer")).toBe(false);
    expect(spies.hash).toHaveBeenCalledTimes(2);
  });
});

describe("buildApp chama o aquecimento na inicialização", () => {
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(async () => {
    vi.resetModules();
    dir = await mkdtemp(path.join(tmpdir(), "paas-warmup-"));
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
    vi.doUnmock("../src/services/password.js");
  });

  it("o hash fictício já existe depois que o app sobe", async () => {
    spies.hash.mockClear();
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      // o aquecimento roda em segundo plano: espera o hash sair
      await vi.waitFor(() => expect(spies.hash).toHaveBeenCalled());
      const chamadas = spies.hash.mock.calls.length;
      const { verifyPasswordTimingSafe } = await import("../src/services/password.js");
      await verifyPasswordTimingSafe(null, "qualquer");
      expect(spies.hash.mock.calls.length).toBe(chamadas); // nenhum hash novo no primeiro pedido
    } finally {
      await app.close();
    }
  });
});
