/**
 * revisao-mcp-pecas.test.ts — peças que a revisão do MCP mexeu: mescla atômica de variáveis, teto do arquivo
 * morto da Auditoria e formas em base64/hex na máscara dos logs.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../src/services/audit-service.js";
import { LOG_MASK, buildLogMasker, secretForms } from "../src/services/log-mask.js";
import { ENV_MAX_VARS, ProjectEnvStore } from "../src/services/project-env.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-revisao-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProjectEnvStore.merge", () => {
  it("acrescenta e troca sem apagar as outras; projeto sem registro começa do zero", async () => {
    const store = new ProjectEnvStore(dir);
    expect(await store.merge("p1", [{ key: "A", value: "1" }], { allowOverwrite: false })).toEqual([{ key: "A", value: "1" }]);
    await store.merge("p1", [{ key: "B", value: "2" }, { key: " C ", value: "3" }], { allowOverwrite: false });
    await store.merge("p1", [{ key: "A", value: "novo" }], { allowOverwrite: true });
    expect(Object.fromEntries((await store.get("p1")).map((v) => [v.key, v.value]))).toEqual({ A: "novo", B: "2", C: "3" });
    // outro projeto não é tocado
    await store.set("p2", [{ key: "X", value: "y" }]);
    await store.merge("p1", [{ key: "D", value: "4" }], { allowOverwrite: false });
    expect(await store.get("p2")).toEqual([{ key: "X", value: "y" }]);
  });

  it("sem permissão para sobrescrever: recusa trocar ou esvaziar valor existente (409), mas aceita valor igual, variável nova e variável vazia", async () => {
    const store = new ProjectEnvStore(dir);
    await store.set("p1", [{ key: "DB", value: "senha" }, { key: "VAZIA", value: "" }]);
    await expect(store.merge("p1", [{ key: "DB", value: "outra" }], { allowOverwrite: false })).rejects.toMatchObject({ statusCode: 409, code: "env_changed" });
    await expect(store.merge("p1", [{ key: "DB", value: "" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "env_changed" });
    await store.merge("p1", [{ key: "DB", value: "senha" }, { key: "VAZIA", value: "agora tem" }, { key: "NOVA", value: "n" }], { allowOverwrite: false });
    expect(Object.fromEntries((await store.get("p1")).map((v) => [v.key, v.value]))).toEqual({ DB: "senha", VAZIA: "agora tem", NOVA: "n" });
  });

  it("duas mesclas paralelas não perdem nenhuma das duas", async () => {
    const store = new ProjectEnvStore(dir);
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.merge("p1", [{ key: `K${i}`, value: String(i) }], { allowOverwrite: false })));
    expect((await store.get("p1")).map((v) => v.key).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `K${i}`).sort());
  });

  it("valida como o resto: nome inválido, repetido, valor nulo e o teto de variáveis", async () => {
    const store = new ProjectEnvStore(dir);
    await expect(store.merge("p1", [{ key: "nome inválido", value: "1" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "invalid_env_key" });
    await expect(store.merge("p1", [{ key: "A", value: "1" }, { key: "A", value: "2" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "duplicate_env_key" });
    await expect(store.merge("p1", [{ key: "A", value: "x\0y" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "invalid_env_value" });
    await store.set("p1", Array.from({ length: ENV_MAX_VARS }, (_, i) => ({ key: `V${i}`, value: "1" })));
    await expect(store.merge("p1", [{ key: "UMA_A_MAIS", value: "1" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "too_many_env_vars" });
    // nada foi gravado pela tentativa
    expect(await store.get("p1")).toHaveLength(ENV_MAX_VARS);
  });
});

describe("ProjectEnvStore: lista vazia e lista grande", () => {
  it("salva 260 variáveis, e salvar a lista vazia apaga tudo (inclusive a última)", async () => {
    const store = new ProjectEnvStore(dir);
    await store.set("p1", Array.from({ length: 260 }, (_, i) => ({ key: `V${i}`, value: "1" })));
    expect(await store.get("p1")).toHaveLength(260);
    await store.set("p1", [{ key: "ULTIMA", value: "1" }]);
    expect(await store.set("p1", [])).toEqual([]);
    expect(await store.get("p1")).toEqual([]);
    expect(await store.set("p1", [])).toEqual([]);
  });

  it("acima de 1000 a mensagem é clara e nada é gravado", async () => {
    const store = new ProjectEnvStore(dir);
    await expect(store.set("p1", Array.from({ length: 1001 }, (_, i) => ({ key: `V${i}`, value: "1" })))).rejects.toMatchObject({
      code: "too_many_env_vars",
      message: "No máximo 1000 variáveis.",
    });
    expect(await store.get("p1")).toEqual([]);
  });
});

describe("AuditService: teto do arquivo morto", () => {
  it("passado o teto, as entradas mais antigas do audit.1.json saem; são sempre dois arquivos", async () => {
    const service = new AuditService(dir, { maxEntries: 3, maxArchivedEntries: 4 });
    for (let i = 0; i < 12; i++) await service.record({ action: "teste", detail: `evento ${i}` });
    await service.flush();
    const archived = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8")).entries as { detail: string }[];
    expect(archived).toHaveLength(4);
    // ficaram as mais recentes entre as arquivadas (e o ativo guarda as 3 últimas)
    expect(archived.map((e) => e.detail)).toEqual(["evento 5", "evento 6", "evento 7", "evento 8"]);
    const active = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8")).entries as { detail: string }[];
    expect(active.map((e) => e.detail)).toEqual(["evento 9", "evento 10", "evento 11"]);
  });

  it("o teto padrão do arquivo morto é grande o bastante para uso normal e nunca é zero", async () => {
    const service = new AuditService(dir, { maxEntries: 2 });
    for (let i = 0; i < 6; i++) await service.record({ action: "teste", detail: `e${i}` });
    await service.flush();
    expect(JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8")).entries.length).toBe(4);
  });
});

describe("máscara de logs: base64 e hexadecimal", () => {
  const valor = "Senh@Secreta-2026";
  it("o valor sai também codificado (base64 com e sem '=', base64url, hex minúsculo e maiúsculo)", () => {
    const mask = buildLogMasker([valor]);
    const bytes = Buffer.from(valor);
    for (const form of [bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase()]) {
      expect(mask(`env: ${form} fim`), form).toBe(`env: ${LOG_MASK} fim`);
    }
  });

  it("secretForms devolve só formas longas o bastante e ignora valores triviais e vazios", () => {
    expect(secretForms([""])).toEqual([]);
    // valor trivial cru não é mascarado (ruído), valor curto cru também não
    expect(secretForms(["production", "curto"])).not.toContain("production");
    expect(secretForms(["production", "curto"])).not.toContain("curto");
    expect(secretForms([valor])).toContain(valor);
    expect(secretForms([valor, valor]).length).toBe(new Set(secretForms([valor])).size);
  });
});
