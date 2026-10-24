/**
 * token-host-metrics-store.test.ts — a opção "pode ver o monitoramento da VPS"
 * no cadastro de tokens: padrão desligada, só em token de projetos, arquivo
 * antigo ou ruim nunca ganha o poder (falha fechada), edição preserva ou muda,
 * e a decisão de alcance da rota "host".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiTokenStore, reachOf } from "../src/services/api-token-store.js";
import { CANNOT_SEE_HOST_REASON, checkReach } from "../src/services/token-policy.js";

let dir: string;
let store: ApiTokenStore;
const file = () => path.join(dir, "api-tokens.json");

const record = (extra: Record<string, unknown> = {}) => ({
  id: "0123456789abcdef",
  name: "antigo",
  scope: "read",
  hash: "a".repeat(64),
  userId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2999-12-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  ...extra,
});

async function seed(records: unknown[]) {
  await mkdir(dir, { recursive: true });
  await writeFile(file(), JSON.stringify({ tokens: records }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tokens-host-"));
  store = new ApiTokenStore(dir);
});
afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe("criação", () => {
  it("fica desligada por padrão, em token de painel e de projetos", async () => {
    expect((await store.create({ name: "a", scope: "read", ttlHours: 1, userId: "u" })).info.hostMetrics).toBe(false);
    expect((await store.create({ name: "b", scope: "read", ttlHours: 1, userId: "u", reach: "projects", projects: ["p1"] })).info.hostMetrics).toBe(false);
  });

  it("liga em token de projetos, de qualquer escopo (é só leitura)", async () => {
    for (const scope of ["read", "write", "admin"] as const) {
      const { info } = await store.create({ name: `t-${scope}`, scope, ttlHours: 1, userId: "u", reach: "projects", projects: ["p1"], hostMetrics: true });
      expect(info.hostMetrics).toBe(true);
    }
  });

  it("token de painel inteiro não aceita a opção (ele já vê tudo; evita token que parece limitado e não é)", async () => {
    await expect(store.create({ name: "x", scope: "read", ttlHours: 1, userId: "u", reach: "panel", hostMetrics: true })).rejects.toMatchObject({ code: "invalid_token_reach" });
  });

  it("grava no disco e volta ao ler", async () => {
    await store.create({ name: "g", scope: "read", ttlHours: 1, userId: "u", reach: "projects", projects: ["p1"], hostMetrics: true });
    await store.flush();
    const again = new ApiTokenStore(dir);
    expect((await again.list())[0]).toMatchObject({ reach: "projects", hostMetrics: true });
  });
});

describe("arquivo no disco (falha fechada)", () => {
  it("arquivo sem o campo (Fase 0b) carrega com a opção desligada", async () => {
    await seed([record({ reach: "projects", projects: ["p1"], canCreate: false })]);
    expect((await store.list())[0]).toMatchObject({ reach: "projects", hostMetrics: false });
  });

  it("arquivo da Fase 0 (painel inteiro, sem campos) continua painel inteiro com a opção desligada", async () => {
    await seed([record()]);
    expect((await store.list())[0]).toMatchObject({ reach: "panel", hostMetrics: false });
  });

  it("opção que não é booleano, ou 'true' em token de painel, vira SEM alcance (nunca amplia)", async () => {
    await seed([
      record({ id: "00000000000000a1", name: "a", reach: "projects", projects: ["p1"], canCreate: false, hostMetrics: "true" }),
      record({ id: "00000000000000a2", name: "b", reach: "panel", projects: [], canCreate: false, hostMetrics: true }),
      record({ id: "00000000000000a3", name: "c", hostMetrics: true }),
    ]);
    for (const t of await store.list()) expect(t).toMatchObject({ reach: "projects", projects: [], canCreate: false, hostMetrics: false });
  });

  it("'painel' com a opção explicitamente falsa continua painel inteiro", async () => {
    await seed([record({ reach: "panel", projects: [], canCreate: false, hostMetrics: false })]);
    expect((await store.list())[0]).toMatchObject({ reach: "panel", hostMetrics: false });
  });

  it("opção ligada e válida é lida", async () => {
    await seed([record({ reach: "projects", projects: ["p1"], canCreate: false, hostMetrics: true })]);
    expect((await store.list())[0]!.hostMetrics).toBe(true);
  });
});

describe("edição (updateReach)", () => {
  it("ausente = não muda; presente liga e desliga", async () => {
    const { info } = await store.create({ name: "e", scope: "read", ttlHours: 1, userId: "u", reach: "projects", projects: ["p1"], hostMetrics: true });
    expect((await store.updateReach(info.id, { projects: ["p1", "p2"], canCreate: false }))!.hostMetrics).toBe(true);
    expect((await store.updateReach(info.id, { projects: ["p1"], canCreate: false, hostMetrics: false }))!.hostMetrics).toBe(false);
    expect((await store.updateReach(info.id, { projects: ["p1"], canCreate: false }))!.hostMetrics).toBe(false);
    expect((await store.updateReach(info.id, { projects: ["p1"], canCreate: false, hostMetrics: true }))!.hostMetrics).toBe(true);
  });
});

describe("reachOf e a decisão da rota 'host'", () => {
  it("o alcance carrega a opção", () => {
    expect(reachOf({ reach: "projects", projects: ["p"], canCreate: false, hostMetrics: true })).toEqual({ kind: "projects", ids: ["p"], canCreate: false, hostMetrics: true });
  });

  it("token de painel inteiro passa; limitado só com a opção ligada; sem ela, 403 com o motivo", () => {
    expect(checkReach({ kind: "panel" }, "host", {})).toEqual({ kind: "allow" });
    expect(checkReach({ kind: "projects", ids: ["a"], canCreate: false, hostMetrics: true }, "host", {})).toEqual({ kind: "allow" });
    expect(checkReach({ kind: "projects", ids: ["a"], canCreate: false, hostMetrics: false }, "host", {})).toEqual({ kind: "forbidden", reason: CANNOT_SEE_HOST_REASON });
    // alcance sem o campo (tipo opcional) = sem a opção
    expect(checkReach({ kind: "projects", ids: ["a"], canCreate: true }, "host", {})).toEqual({ kind: "forbidden", reason: CANNOT_SEE_HOST_REASON });
  });

  it("a opção não abre rota do painel que não é de monitoramento", () => {
    expect(checkReach({ kind: "projects", ids: ["a"], canCreate: true, hostMetrics: true }, "panel", {})).toMatchObject({ kind: "forbidden" });
  });
});
