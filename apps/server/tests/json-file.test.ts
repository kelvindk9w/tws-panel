/**
 * json-file.test.ts — o "ler, alterar e gravar" comum dos stores
 * (services/json-file.ts), com arquivos de verdade numa pasta temporária e
 * concorrência real (Promise.all).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFile, createFileOnce, loadOrCreateKey, withFileLock, writeFileAtomic } from "../src/services/json-file.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-json-file-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Contador {
  n: number;
  quem: string[];
}

function contador(file: string): JsonFile<Contador> {
  return new JsonFile<Contador>(file, {
    empty: () => ({ n: 0, quem: [] }),
    parse: (raw) => {
      const r = raw as Partial<Contador>;
      return typeof r.n === "number" && Array.isArray(r.quem) ? { n: r.n, quem: r.quem } : null;
    },
  });
}

describe("withFileLock", () => {
  it("um de cada vez por arquivo, na ordem de chegada; um erro não trava a fila", async () => {
    const file = path.join(dir, "x.json");
    const ordem: string[] = [];
    const tarefa = (nome: string, falha = false) =>
      withFileLock(file, async () => {
        ordem.push(`início ${nome}`);
        await new Promise((r) => setImmediate(r));
        ordem.push(`fim ${nome}`);
        if (falha) throw new Error(nome);
        return nome;
      });
    const resultados = await Promise.allSettled([tarefa("a"), tarefa("b", true), tarefa("c")]);
    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(ordem).toEqual(["início a", "fim a", "início b", "fim b", "início c", "fim c"]);
  });

  it("arquivos diferentes não esperam um pelo outro; caminho relativo e absoluto são a mesma fila", async () => {
    const ordem: string[] = [];
    let soltar!: () => void;
    const preso = withFileLock(path.join(dir, "a.json"), () => new Promise<void>((r) => (soltar = r)));
    await withFileLock(path.join(dir, "b.json"), async () => void ordem.push("b"));
    expect(ordem).toEqual(["b"]);
    const relativo = path.relative(process.cwd(), path.join(dir, "a.json"));
    const depois = withFileLock(relativo, async () => void ordem.push("a depois"));
    await new Promise((r) => setImmediate(r));
    expect(ordem).toEqual(["b"]);
    soltar();
    await Promise.all([preso, depois]);
    expect(ordem).toEqual(["b", "a depois"]);
  });
});

describe("writeFileAtomic", () => {
  it("grava com 0600, cria a pasta e não deixa temporário", async () => {
    const file = path.join(dir, "sub", "dados.json");
    await writeFileAtomic(file, "conteúdo");
    expect(await readFile(file, "utf8")).toBe("conteúdo");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["dados.json"]);
    await writeFileAtomic(file, Buffer.from("outro"), { mode: 0o640 });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it("rename que falha (destino é uma pasta com conteúdo): erro, sem temporário sobrando", async () => {
    const file = path.join(dir, "pasta");
    await mkdir(path.join(file, "dentro"), { recursive: true });
    await expect(writeFileAtomic(file, "x")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["pasta"]);
  });

  it("pasta que não pode ser criada: erro", async () => {
    await writeFile(path.join(dir, "arquivo"), "");
    await expect(writeFileAtomic(path.join(dir, "arquivo", "x.json"), "x")).rejects.toThrow();
  });
});

describe("createFileOnce", () => {
  it("cria uma vez; a segunda não substitui", async () => {
    const file = path.join(dir, "chave");
    expect(await createFileOnce(file, "primeira")).toBe(true);
    expect(await createFileOnce(file, "segunda")).toBe(false);
    expect(await readFile(file, "utf8")).toBe("primeira");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["chave"]);
  });

  it("dez criações em paralelo: exatamente uma vence e o arquivo é o dela", async () => {
    const file = path.join(dir, "chave");
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) => createFileOnce(file, `chave-${i}`)));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(`chave-${r.indexOf(true)}`);
    expect(await readdir(dir)).toEqual(["chave"]);
  });

  it("erro de disco (pasta que é arquivo) chega a quem chamou", async () => {
    await writeFile(path.join(dir, "b"), "");
    await expect(createFileOnce(path.join(dir, "b", "chave"), "x")).rejects.toThrow();
  });
});

describe("loadOrCreateKey", () => {
  it("dez pedidos paralelos na primeira vez: a mesma chave para todos, gravada uma vez", async () => {
    const file = path.join(dir, "k");
    const chaves = await Promise.all(Array.from({ length: 10 }, () => loadOrCreateKey(file, 32)));
    const hex = chaves[0]!.toString("hex");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(chaves.every((k) => k.toString("hex") === hex)).toBe(true);
    expect((await readFile(file, "utf8")).trim()).toBe(hex);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["k"]);
    expect((await loadOrCreateKey(file, 32)).toString("hex")).toBe(hex);
  });

  it("conteúdo que não é chave do tamanho certo é trocado; erro de disco é lançado", async () => {
    const file = path.join(dir, "k");
    await writeFile(file, "abcd\n");
    const k = await loadOrCreateKey(file, 16);
    expect(k).toHaveLength(16);
    expect((await readFile(file, "utf8")).trim()).toBe(k.toString("hex"));
    await mkdir(path.join(dir, "pasta"));
    await expect(loadOrCreateKey(path.join(dir, "pasta"), 16)).rejects.toThrow();
  });

  it("conteúdo inválido (não-hexa, tamanho errado) é guardado à parte, nunca apagado", async () => {
    const file = path.join(dir, "k");
    await writeFile(file, "z".repeat(40) + "\n");
    const k = await loadOrCreateKey(file, 32);
    expect(k.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
    const aparte = (await readdir(dir)).filter((n) => n.startsWith("k.corrompido-"));
    expect(aparte).toHaveLength(1);
    expect(await readFile(path.join(dir, aparte[0]!), "utf8")).toBe("z".repeat(40) + "\n");
  });
});

describe("JsonFile", () => {
  it("sem arquivo: lê o vazio; update grava; read devolve o gravado", async () => {
    const f = contador(path.join(dir, "c.json"));
    expect(await f.read()).toEqual({ n: 0, quem: [] });
    await f.update((c) => ({ n: c.n + 1, quem: [...c.quem, "a"] }));
    expect(await f.read()).toEqual({ n: 1, quem: ["a"] });
    expect(await readFile(f.file, "utf8")).toBe(JSON.stringify({ n: 1, quem: ["a"] }, null, 2) + "\n");
  });

  it("50 alterações em paralelo, de duas instâncias: nenhuma se perde", async () => {
    const file = path.join(dir, "c.json");
    const a = contador(file);
    const b = contador(file);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).update((c) => ({ n: c.n + 1, quem: [...c.quem, `q${i}`] }))),
    );
    const final = await a.read();
    expect(final.n).toBe(50);
    expect(new Set(final.quem).size).toBe(50);
  });

  it("alteração que devolve o mesmo valor não grava; alteração que lança não muda o arquivo e não trava a fila", async () => {
    const f = contador(path.join(dir, "c.json"));
    await f.update((c) => c);
    expect(await readdir(dir)).toEqual([]);
    await f.update(() => ({ n: 7, quem: [] }));
    await expect(f.update(() => Promise.reject(new Error("recusado")))).rejects.toThrow("recusado");
    expect(await f.read()).toEqual({ n: 7, quem: [] });
    await f.update(async (c) => ({ ...c, n: c.n + 1 }));
    expect((await f.read()).n).toBe(8);
  });

  it("arquivo ilegível: read não mexe nele; update guarda à parte e começa do vazio", async () => {
    const file = path.join(dir, "c.json");
    await writeFile(file, "{ estragado");
    const f = contador(file);
    expect(await f.read()).toEqual({ n: 0, quem: [] });
    expect(await readFile(file, "utf8")).toBe("{ estragado");
    await f.update((c) => c); // sem mudança: nem guarda à parte
    expect(await readdir(dir)).toEqual(["c.json"]);
    await f.update((c) => ({ ...c, n: 1 }));
    const nomes = await readdir(dir);
    const guardado = nomes.find((n) => n.startsWith("c.json.corrompido-"))!;
    expect(await readFile(path.join(dir, guardado), "utf8")).toBe("{ estragado");
    expect((await f.read()).n).toBe(1);
  });

  it("formato não reconhecido (parse devolve null) também é guardado à parte", async () => {
    const file = path.join(dir, "c.json");
    await writeFile(file, JSON.stringify({ n: "texto" }));
    const f = contador(file);
    await f.update((c) => ({ ...c, n: 2 }));
    expect((await readdir(dir)).some((n) => n.startsWith("c.json.corrompido-"))).toBe(true);
    expect((await f.read()).n).toBe(2);
  });

  it("erro de disco que não é 'não existe' é lançado (nunca vira vazio para ser sobrescrito)", async () => {
    const file = path.join(dir, "c.json");
    await mkdir(file);
    const f = contador(file);
    await expect(f.read()).rejects.toThrow();
    await expect(f.update((c) => ({ ...c, n: 1 }))).rejects.toThrow();
  });

  it("serialize e mode próprios", async () => {
    const file = path.join(dir, "c.json");
    const f = new JsonFile<number>(file, { empty: () => 0, parse: (r) => (typeof r === "number" ? r : null), serialize: String, mode: 0o640 });
    await f.update((n) => n + 41);
    expect(await readFile(file, "utf8")).toBe("41");
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });
});
