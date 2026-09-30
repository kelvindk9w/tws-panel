/**
 * project-env.test.ts — Variáveis de ambiente do projeto (seção Variáveis).
 * Valores cifrados em disco; nomes validados; injeção no deploy junto com as
 * do e-mail (as definidas pelo operador vencem).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectEnvStore } from "../src/services/project-env.js";

let dir: string;
let store: ProjectEnvStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-env-"));
  store = new ProjectEnvStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProjectEnvStore", () => {
  it("grava e lê as variáveis do projeto; em disco, o valor fica cifrado", async () => {
    await store.set("p1", [
      { key: "DATABASE_URL", value: "postgres://user:SENHA-SECRETA@db/app" },
      { key: "NODE_ENV", value: "production" },
    ]);
    expect(await store.get("p1")).toEqual([
      { key: "DATABASE_URL", value: "postgres://user:SENHA-SECRETA@db/app" },
      { key: "NODE_ENV", value: "production" },
    ]);
    expect(await store.asRecord("p1")).toEqual({ DATABASE_URL: "postgres://user:SENHA-SECRETA@db/app", NODE_ENV: "production" });
    const disco = await readFile(path.join(dir, "project-env.json"), "utf8");
    expect(disco).not.toContain("SENHA-SECRETA");
    expect(disco).not.toContain("production");
    expect(await store.get("outro")).toEqual([]);
  });

  it("recusa nome inválido, nome repetido e valor com caractere nulo", async () => {
    for (const vars of [
      [{ key: "1COMECA_COM_NUMERO", value: "x" }],
      [{ key: "COM ESPACO", value: "x" }],
      [{ key: "A", value: "1" }, { key: "A", value: "2" }],
      [{ key: "OK", value: "a\0b" }],
    ]) {
      await expect(store.set("p1", vars), JSON.stringify(vars)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("salvar a lista substitui a anterior (variável apagada sai); remover o projeto apaga tudo", async () => {
    await store.set("p1", [{ key: "A", value: "1" }, { key: "B", value: "2" }]);
    await store.set("p1", [{ key: "B", value: "3" }]);
    expect(await store.get("p1")).toEqual([{ key: "B", value: "3" }]);
    await store.remove("p1");
    expect(await store.get("p1")).toEqual([]);
  });
});
