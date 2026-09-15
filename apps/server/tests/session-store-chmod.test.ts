/**
 * SessionStore em sistema de arquivos que recusa chmod (ex.: volume montado
 * de NTFS/CIFS): o segredo é gerado e gravado mesmo assim, e o painel sobe.
 * Arquivo separado porque o mock de node:fs/promises vale para o módulo todo.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chmodChamadas = vi.hoisted(() => ({ total: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    chmod: async () => {
      chmodChamadas.total += 1;
      throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
    },
  };
});

const { SessionStore } = await import("../src/services/session-store.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-sessions-chmod-"));
  chmodChamadas.total = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore — chmod recusado pelo sistema de arquivos", () => {
  it("init() conclui, grava o segredo e as sessões assinadas funcionam", async () => {
    const store = new SessionStore(dir);
    await expect(store.init()).resolves.toBeUndefined();
    expect(chmodChamadas.total).toBe(1);

    const raw = (await readFile(path.join(dir, "session-secret"), "utf8")).trim();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);

    const { cookieValue } = await store.create({ id: "u1", username: "admin" });
    expect((await store.resolve(cookieValue))?.username).toBe("admin");
  });
});
