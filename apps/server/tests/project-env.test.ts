/**
 * project-env.test.ts — Variáveis de ambiente do projeto (seção Variáveis).
 * Valores cifrados em disco; nomes validados; injeção no deploy junto com as
 * do e-mail (as definidas pelo operador vencem).
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVarIssues, ProjectEnvStore } from "../src/services/project-env.js";

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

describe("variáveis marcadas como \"de build\"", () => {
  it("a marca fica gravada (cifrada) e buildRecord devolve só as marcadas; sem marca não há campo build", async () => {
    await store.set("p1", [
      { key: "VITE_API_URL", value: "https://api.example.com", build: true },
      { key: "SEGREDO_DB", value: "senha-do-banco" },
      { key: "VITE_OUTRA", value: "x", build: false },
    ]);
    expect(await store.get("p1")).toEqual([
      { key: "VITE_API_URL", value: "https://api.example.com", build: true },
      { key: "SEGREDO_DB", value: "senha-do-banco" },
      { key: "VITE_OUTRA", value: "x" },
    ]);
    expect(await store.buildRecord("p1")).toEqual({ VITE_API_URL: "https://api.example.com" });
    expect(await store.buildRecord("outro")).toEqual({});
    expect(await readFile(path.join(dir, "project-env.json"), "utf8")).not.toContain("VITE_API_URL");
  });

  it("nome reservado ou valor que não cabe no build NÃO impede salvar; o aviso lista só nome e motivo", async () => {
    const lista = [
      { key: "PATH", value: "/x", build: true },
      { key: "DOCKER_HOST", value: "tcp://x", build: true },
      { key: "VITE_A", value: "a\nb", build: true },
      { key: "VITE_OK", value: "ok", build: true },
    ];
    await expect(store.set("p1", lista)).resolves.toEqual(lista);
    expect(buildVarIssues(lista)).toEqual([
      { name: "PATH", reason: "nome reservado" },
      { name: "DOCKER_HOST", reason: "nome reservado" },
      { name: "VITE_A", reason: "valor com quebra de linha" },
    ]);
    // nome de variável inválido continua barrando
    await expect(store.set("p1", [{ key: "1RUIM", value: "x", build: true }])).rejects.toMatchObject({ statusCode: 400, code: "invalid_env_key" });
    // o mesmo nome sem a marca é uma variável comum (vai só à execução)
    await expect(store.set("p1", [{ key: "PATH", value: "/x" }])).resolves.toBeDefined();
  });
});

/**
 * Concorrência real (achado 8 da revisão), com Promise.all sobre arquivos de
 * verdade. Antes da correção, set() lia a lista dos outros projetos fora da
 * fila de gravação (a última gravação apagava a outra) e a chave de cifra
 * podia ser gerada duas vezes na primeira gravação (variáveis cifradas com
 * uma chave que deixava de existir).
 */
describe("ProjectEnvStore com gravações em paralelo", () => {
  it("salvar projetos diferentes ao mesmo tempo não apaga as variáveis de outro", async () => {
    await store.set("seed", [{ key: "S", value: "0" }]);
    await Promise.all([
      store.set("p1", [{ key: "A", value: "1" }]),
      store.set("p2", [{ key: "B", value: "2" }]),
      store.set("p3", [{ key: "C", value: "3" }]),
    ]);
    const relido = new ProjectEnvStore(dir); // "depois de reiniciar": só o disco
    expect(await relido.get("seed")).toEqual([{ key: "S", value: "0" }]);
    expect(await relido.get("p1")).toEqual([{ key: "A", value: "1" }]);
    expect(await relido.get("p2")).toEqual([{ key: "B", value: "2" }]);
    expect(await relido.get("p3")).toEqual([{ key: "C", value: "3" }]);
  });

  it("remover um projeto enquanto outro salva não perde o que foi salvo", async () => {
    await store.set("velho", [{ key: "V", value: "1" }]);
    await Promise.all([store.remove("velho"), store.set("novo", [{ key: "N", value: "2" }])]);
    const relido = new ProjectEnvStore(dir);
    expect(await relido.get("velho")).toEqual([]);
    expect(await relido.get("novo")).toEqual([{ key: "N", value: "2" }]);
  });

  it("primeira gravação em paralelo cria UMA chave só e tudo continua legível", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.set(`p${i}`, [{ key: "K", value: String(i) }])));
    const relido = new ProjectEnvStore(dir);
    for (let i = 0; i < 6; i++) expect(await relido.get(`p${i}`)).toEqual([{ key: "K", value: String(i) }]);
  });

  it("duas instâncias na mesma pasta (duas abas, duas rotas) também não geram chaves diferentes", async () => {
    const outra = new ProjectEnvStore(dir);
    await Promise.all([store.set("a", [{ key: "A", value: "1" }]), outra.set("b", [{ key: "B", value: "2" }])]);
    const relido = new ProjectEnvStore(dir);
    expect(await relido.get("a")).toEqual([{ key: "A", value: "1" }]);
    expect(await relido.get("b")).toEqual([{ key: "B", value: "2" }]);
  });

  it("arquivo de chave com conteúdo que não é chave: troca por uma nova e segue", async () => {
    await writeFile(path.join(dir, "project-env-key"), "curta\n", "utf8");
    await store.set("p1", [{ key: "A", value: "1" }]);
    expect((await readFile(path.join(dir, "project-env-key"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(await new ProjectEnvStore(dir).get("p1")).toEqual([{ key: "A", value: "1" }]);
  });

  it("project-env.json ilegível é guardado à parte em vez de sobrescrito", async () => {
    await writeFile(path.join(dir, "project-env.json"), "{ estragado", "utf8");
    await store.set("p1", [{ key: "A", value: "1" }]);
    const guardado = (await readdir(dir)).find((n) => n.startsWith("project-env.json.corrompido-"));
    expect(guardado).toBeDefined();
    expect(await readFile(path.join(dir, guardado!), "utf8")).toBe("{ estragado");
    expect(await store.get("p1")).toEqual([{ key: "A", value: "1" }]);
  });
});
