/**
 * api-token-store-alcance.test.ts — Fase 0b: o ALCANCE do token (painel inteiro
 * ou só os projetos da lista) no cadastro: criação, compatibilidade com o
 * arquivo da Fase 0, lista corrompida (falha fechada: nunca amplia), registro
 * atômico de projeto criado pelo token, edição da lista e esquecimento de
 * projeto apagado.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTokenStore, reachOf } from "../src/services/api-token-store.js";

let dir: string;
let store: ApiTokenStore;
const file = () => path.join(dir, "api-tokens.json");
const NOW = Date.parse("2026-10-22T12:00:00Z");

const record = (extra: Record<string, unknown> = {}) => ({
  id: "0123456789abcdef",
  name: "antigo",
  scope: "write",
  hash: "a".repeat(64),
  userId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  ...extra,
});

async function seed(records: unknown[]) {
  await mkdir(dir, { recursive: true });
  await writeFile(file(), JSON.stringify({ tokens: records }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tokens-alcance-"));
  store = new ApiTokenStore(dir);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await store.flush();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("criação com alcance", () => {
  it("sem alcance informado vale o painel inteiro (comportamento da Fase 0)", async () => {
    const { info } = await store.create({ name: "a", scope: "read", ttlHours: 1, userId: "u1" });
    expect(info).toMatchObject({ reach: "panel", projects: [], canCreate: false });
  });

  it("alcance 'projects' grava a lista e o 'pode criar'; a lista sai sem repetição", async () => {
    const { info } = await store.create({
      name: "fazenda",
      scope: "write",
      ttlHours: 1,
      userId: "u1",
      reach: "projects",
      projects: ["p1", "p2", "p1"],
      canCreate: true,
    });
    expect(info).toMatchObject({ reach: "projects", projects: ["p1", "p2"], canCreate: true });
    const disk = JSON.parse(await readFile(file(), "utf8")).tokens[0];
    expect(disk).toMatchObject({ reach: "projects", projects: ["p1", "p2"], canCreate: true });
  });

  it("alcance 'projects' com lista vazia e sem 'pode criar' é inválido", async () => {
    await expect(
      store.create({ name: "vazio", scope: "read", ttlHours: 1, userId: "u1", reach: "projects", projects: [], canCreate: false }),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_token_reach" });
    expect(await store.list()).toEqual([]);
  });

  it("lista vazia COM 'pode criar' é válida (o primeiro projeto entra quando o token o criar)", async () => {
    const { info } = await store.create({ name: "criador", scope: "admin", ttlHours: 1, userId: "u1", reach: "projects", projects: [], canCreate: true });
    expect(info).toMatchObject({ reach: "projects", projects: [], canCreate: true });
  });

  it("alcance 'panel' não aceita lista nem 'pode criar' (evita token que parece limitado e não é)", async () => {
    await expect(
      store.create({ name: "x", scope: "read", ttlHours: 1, userId: "u1", reach: "panel", projects: ["p1"] }),
    ).rejects.toMatchObject({ code: "invalid_token_reach" });
    await expect(
      store.create({ name: "y", scope: "read", ttlHours: 1, userId: "u1", reach: "panel", canCreate: true }),
    ).rejects.toMatchObject({ code: "invalid_token_reach" });
  });

  it("lista grande demais é recusada", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`);
    await expect(
      store.create({ name: "z", scope: "read", ttlHours: 1, userId: "u1", reach: "projects", projects: many }),
    ).rejects.toMatchObject({ code: "invalid_token_reach" });
  });
});

describe("compatibilidade e falha fechada ao ler o arquivo", () => {
  it("arquivo da Fase 0 (sem campos de alcance) carrega como painel inteiro", async () => {
    await seed([record()]);
    const [info] = await store.list();
    expect(info).toMatchObject({ reach: "panel", projects: [], canCreate: false });
    expect(reachOf((await store.list())[0]!)).toEqual({ kind: "panel" });
  });

  it("alcance 'projects' válido carrega com a lista", async () => {
    await seed([record({ reach: "projects", projects: ["a", "b"], canCreate: true })]);
    expect((await store.list())[0]).toMatchObject({ reach: "projects", projects: ["a", "b"], canCreate: true });
  });

  it.each([
    ["alcance desconhecido", { reach: "tudo" }],
    ["lista que não é lista", { reach: "projects", projects: "p1" }],
    ["lista com item que não é texto", { reach: "projects", projects: ["p1", 7] }],
    ["lista sumiu mas o alcance diz projetos", { reach: "projects" }],
    ["lista sem o campo de alcance (campo apagado)", { projects: ["p1"] }],
    ["canCreate que não é booleano", { reach: "projects", projects: ["p1"], canCreate: "sim" }],
    ["alcance nulo", { reach: null }],
  ])("%s: o token fica SEM alcance (lista vazia, não cria) e nunca vira painel inteiro", async (_n, extra) => {
    await seed([record(extra)]);
    const info = (await store.list())[0]!;
    expect(info).toMatchObject({ reach: "projects", projects: [], canCreate: false });
  });

  it("o arquivo inteiro NÃO é descartado por um alcance ruim (os outros tokens continuam)", async () => {
    await seed([record({ id: "1111111111111111", name: "ok" }), record({ id: "2222222222222222", name: "ruim", reach: 5 })]);
    const list = await store.list();
    expect(list.map((t) => [t.name, t.reach]).sort()).toEqual([["ok", "panel"], ["ruim", "projects"]]);
  });

  it("alcance 'panel' explícito com lista junto ignora a lista", async () => {
    await seed([record({ reach: "panel", projects: ["p1"] })]);
    expect((await store.list())[0]).toMatchObject({ reach: "panel", projects: [] });
  });
});

describe("addProject (projeto criado pelo token entra na lista)", () => {
  async function limited(canCreate: boolean, projects = ["p1"]) {
    return store.create({ name: "lim", scope: "admin", ttlHours: 1, userId: "u1", reach: "projects", projects, canCreate });
  }

  it("com 'pode criar': entra na lista e vai para o disco; repetir não duplica", async () => {
    const { info } = await limited(true);
    expect(await store.addProject(info.id, "p2")).toBe(true);
    expect(await store.addProject(info.id, "p2")).toBe(true);
    expect((await store.list())[0]!.projects).toEqual(["p1", "p2"]);
    expect(JSON.parse(await readFile(file(), "utf8")).tokens[0].projects).toEqual(["p1", "p2"]);
  });

  it("sem 'pode criar': recusa e a lista não muda", async () => {
    const { info } = await limited(false);
    expect(await store.addProject(info.id, "p2")).toBe(false);
    expect((await store.list())[0]!.projects).toEqual(["p1"]);
  });

  it("token de painel inteiro, revogado, vencido ou inexistente: recusa", async () => {
    const panel = await store.create({ name: "pn", scope: "admin", ttlHours: 1, userId: "u1" });
    expect(await store.addProject(panel.info.id, "p2")).toBe(false);
    const revoked = await limited(true);
    await store.revoke(revoked.info.id);
    expect(await store.addProject(revoked.info.id, "p2")).toBe(false);
    const expired = await store.create({ name: "ven", scope: "admin", ttlHours: 1, userId: "u1", reach: "projects", projects: [], canCreate: true });
    vi.setSystemTime(NOW + 2 * 3_600_000);
    expect(await store.addProject(expired.info.id, "p2")).toBe(false);
    expect(await store.addProject("ffffffffffffffff", "p2")).toBe(false);
  });

  it("falha de gravação: devolve erro, a lista volta ao que era (nada entra pela metade)", async () => {
    const { info } = await limited(true);
    await store.flush();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "no lugar da pasta");
    await expect(store.addProject(info.id, "p2")).rejects.toMatchObject({ code: "storage_write_failed" });
    await rm(dir, { force: true });
    await mkdir(dir, { recursive: true });
    expect((await store.list())[0]!.projects).toEqual(["p1"]);
  });

  it("ids de projeto de outros formatos não entram (defesa)", async () => {
    const { info } = await limited(true);
    await expect(store.addProject(info.id, "")).rejects.toMatchObject({ code: "invalid_token_reach" });
  });
});

describe("updateReach (editar a lista)", () => {
  it("troca a lista e o 'pode criar' de um token de projetos ativo", async () => {
    const { info } = await store.create({ name: "e", scope: "write", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p1"], canCreate: false });
    const out = await store.updateReach(info.id, { projects: ["p2", "p3", "p2"], canCreate: true });
    expect(out).toMatchObject({ projects: ["p2", "p3"], canCreate: true });
    expect((await store.list())[0]).toMatchObject({ projects: ["p2", "p3"], canCreate: true });
  });

  it("devolve null para token inexistente, revogado, vencido ou de painel inteiro", async () => {
    const panel = await store.create({ name: "pn", scope: "admin", ttlHours: 1, userId: "u1" });
    expect(await store.updateReach(panel.info.id, { projects: ["p1"], canCreate: false })).toBeNull();
    expect(await store.updateReach("ffffffffffffffff", { projects: ["p1"], canCreate: false })).toBeNull();
    const rev = await store.create({ name: "rv", scope: "admin", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p1"] });
    await store.revoke(rev.info.id);
    expect(await store.updateReach(rev.info.id, { projects: ["p2"], canCreate: false })).toBeNull();
  });

  it("resultado vazio sem 'pode criar' é recusado e nada muda", async () => {
    const { info } = await store.create({ name: "e", scope: "write", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p1"] });
    await expect(store.updateReach(info.id, { projects: [], canCreate: false })).rejects.toMatchObject({ code: "invalid_token_reach" });
    expect((await store.list())[0]!.projects).toEqual(["p1"]);
  });
});

describe("forgetProject (projeto apagado sai de todas as listas)", () => {
  it("remove o id de todos os tokens, inclusive dos inativos, e grava", async () => {
    const a = await store.create({ name: "a", scope: "read", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p1", "p2"] });
    const b = await store.create({ name: "b", scope: "read", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p1"], canCreate: true });
    await store.revoke(b.info.id);
    await store.forgetProject("p1");
    const list = await store.list();
    expect(list.find((t) => t.id === a.info.id)!.projects).toEqual(["p2"]);
    expect(list.find((t) => t.id === b.info.id)!.projects).toEqual([]);
    expect(JSON.parse(await readFile(file(), "utf8")).tokens.flatMap((t: { projects?: string[] }) => t.projects ?? [])).not.toContain("p1");
  });

  it("id que ninguém tem: nada é regravado", async () => {
    await store.create({ name: "a", scope: "read", ttlHours: 1, userId: "u1", reach: "projects", projects: ["p2"] });
    await store.flush();
    const before = await readFile(file(), "utf8");
    await rm(file());
    await store.forgetProject("nao-existe");
    await expect(readFile(file(), "utf8")).rejects.toThrow();
    expect(before).toContain("p2");
  });
});

describe("reachOf", () => {
  it("painel inteiro", () => {
    expect(reachOf({ reach: "panel", projects: [], canCreate: false })).toEqual({ kind: "panel" });
  });
  it("projetos: lista e 'pode criar' (cópia, não a mesma referência)", () => {
    const list = ["p1"];
    const r = reachOf({ reach: "projects", projects: list, canCreate: true });
    expect(r).toEqual({ kind: "projects", ids: ["p1"], canCreate: true });
    expect((r as { ids: readonly string[] }).ids).not.toBe(list);
  });
});
