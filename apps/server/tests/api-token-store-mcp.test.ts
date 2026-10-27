/**
 * api-token-store-mcp.test.ts — MCP Fase 1 no cadastro de tokens: opções do MCP (tudo desligado por padrão e
 * por qualquer lixo no disco), validade "ilimitada" e troca das opções com compare-and-set.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_NEVER_EXPIRES_AT, defaultMcpOptions } from "@paas/core";
import { ApiTokenStore } from "../src/services/api-token-store.js";

let dir: string;
let store: ApiTokenStore;
const file = () => path.join(dir, "api-tokens.json");

const record = (extra: Record<string, unknown> = {}) => ({
  id: "0123456789abcdef",
  name: "antigo",
  scope: "write",
  hash: "a".repeat(64),
  userId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2099-12-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tokens-mcp-"));
  store = new ApiTokenStore(dir);
});

afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("opções do MCP", () => {
  it("token novo sem opções: tudo desligado", async () => {
    const { info } = await store.create({ name: "a", scope: "read", ttlHours: 24, userId: "u" });
    expect(info.mcp).toEqual(defaultMcpOptions());
    expect(info.neverExpires).toBe(false);
  });

  it("só `true` de verdade liga, na criação e ao ler do disco", async () => {
    const { info } = await store.create({ name: "b", scope: "admin", ttlHours: 24, userId: "u", mcp: { securityApply: true, metrics: true } });
    expect(info.mcp).toEqual({ securityApply: true, secretsRead: false, skipApproval: false, metrics: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      file(),
      JSON.stringify({
        tokens: [
          record({ id: "0000000000000001", name: "sem-campo" }),
          record({ id: "0000000000000002", name: "lixo", mcp: { securityApply: "true", secretsRead: 1, skipApproval: "sim", metrics: null } }),
          record({ id: "0000000000000003", name: "texto", mcp: "tudo" }),
          record({ id: "0000000000000004", name: "ligado", mcp: { skipApproval: true } }),
        ],
      }),
    );
    const fresh = new ApiTokenStore(dir);
    const list = await fresh.list();
    const by = (n: string) => list.find((t) => t.name === n)!.mcp;
    expect(by("sem-campo")).toEqual(defaultMcpOptions());
    expect(by("lixo")).toEqual(defaultMcpOptions());
    expect(by("texto")).toEqual(defaultMcpOptions());
    expect(by("ligado")).toEqual({ ...defaultMcpOptions(), skipApproval: true });
    await fresh.flush();
  });

  it("a sessão sintética do token leva as opções (resolve devolve o registro)", async () => {
    const { token } = await store.create({ name: "c", scope: "write", ttlHours: 24, userId: "u", mcp: { secretsRead: true } });
    const found = await store.resolve(token);
    expect(found?.mcp).toEqual({ ...defaultMcpOptions(), secretsRead: true });
  });
});

describe("validade ilimitada", () => {
  it("ttlHours null grava a data fixa, vale e aparece como ilimitado; e sobrevive à poda", async () => {
    const { token, info } = await store.create({ name: "eterno", scope: "read", ttlHours: null, userId: "u" });
    expect(info.expiresAt).toBe(API_TOKEN_NEVER_EXPIRES_AT);
    expect(info.neverExpires).toBe(true);
    expect(info.status).toBe("active");
    expect((await store.resolve(token))?.name).toBe("eterno");
    const normal = await store.create({ name: "normal", scope: "read", ttlHours: 720, userId: "u" });
    expect(normal.info.neverExpires).toBe(false);
    // revogado, sai de ativo como qualquer outro
    await store.revoke(info.id);
    expect((await store.list()).find((t) => t.name === "eterno")?.status).toBe("revoked");
    expect(await store.resolve(token)).toBeNull();
  });
});

describe("updateMcp", () => {
  it("troca as opções de um token ativo e grava", async () => {
    const { info } = await store.create({ name: "d", scope: "write", ttlHours: 24, userId: "u" });
    const next = { ...defaultMcpOptions(), skipApproval: true };
    const updated = await store.updateMcp(info.id, next, defaultMcpOptions());
    expect(updated?.mcp).toEqual(next);
    const onDisk = JSON.parse(await readFile(file(), "utf8")).tokens[0];
    expect(onDisk.mcp).toEqual(next);
    expect(new ApiTokenStore(dir)).toBeDefined();
  });

  it("compare-and-set: se as opções mudaram desde que a pessoa viu, 409 e nada muda", async () => {
    const { info } = await store.create({ name: "e", scope: "write", ttlHours: 24, userId: "u", mcp: { metrics: true } });
    await expect(store.updateMcp(info.id, { ...defaultMcpOptions(), secretsRead: true }, defaultMcpOptions())).rejects.toMatchObject({
      statusCode: 409,
      code: "token_mcp_changed",
    });
    expect((await store.list())[0]!.mcp).toEqual({ ...defaultMcpOptions(), metrics: true });
  });

  it("sem `expected` troca direto; token inexistente, revogado ou vencido = null", async () => {
    const { info } = await store.create({ name: "f", scope: "write", ttlHours: 24, userId: "u" });
    expect((await store.updateMcp(info.id, { ...defaultMcpOptions(), metrics: true }))?.mcp.metrics).toBe(true);
    expect(await store.updateMcp("ffffffffffffffff", defaultMcpOptions())).toBeNull();
    await store.revoke(info.id);
    expect(await store.updateMcp(info.id, defaultMcpOptions())).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const curto = await store.create({ name: "g", scope: "write", ttlHours: 1, userId: "u" });
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      expect(await store.updateMcp(curto.info.id, defaultMcpOptions())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
