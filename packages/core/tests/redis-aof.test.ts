/**
 * redis-aof.test.ts — reconhecer no log do redis/valkey o AOF com o final corrompido: as três mensagens das
 * fontes oficiais, o número de bytes que o Redis 8 informa, mensagens parecidas que NÃO valem e nomes de
 * arquivo maliciosos (o log é do projeto: nada fora do formato seguro passa).
 */
import { describe, expect, it } from "vitest";
import { aofFileParts, detectAofCorruption, parseAofLoadError } from "../src/redis-aof";

const REDIS8 =
  "1:M 14 Nov 2026 03:12:01.123 # Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725.          make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>.          Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 and restart the server.";
const REDIS7 =
  "1:M 14 Nov 2026 03:12:01.123 # Bad file format reading the append only file appendonlydir/appendonly.aof.3.incr.aof: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>";
const VALKEY =
  "1:M 14 Nov 2026 03:12:01.123 # Bad file format reading the append only file appendonlydir/appendonly.aof.5.incr.aof: make a backup of your AOF file, then use ./valkey-check-aof --fix <filename.manifest>";
const TRUNCATED =
  "1:M 14 Nov 2026 03:12:01.123 # Unexpected end of file reading the append only file appendonlydir/appendonly.aof.9.incr.aof. You can: 1) Make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>. 2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and restart the server.";

describe("parseAofLoadError — as mensagens oficiais", () => {
  it("Redis 8: arquivo, pasta, manifesto, posição e os bytes do final que o próprio redis informa", () => {
    expect(parseAofLoadError(REDIS8)).toEqual({
      engine: "redis",
      tool: "redis-check-aof",
      kind: "format",
      file: "appendonlydir/appendonly.aof.27.incr.aof",
      dir: "appendonlydir",
      manifest: "appendonly.aof.manifest",
      offset: 29790725,
      bytes: 1397,
    });
  });

  it("Redis 7: reconhece, sem posição nem bytes (a mensagem não traz)", () => {
    expect(parseAofLoadError(REDIS7)).toMatchObject({ engine: "redis", kind: "format", file: "appendonlydir/appendonly.aof.3.incr.aof", offset: null, bytes: null });
  });

  it("Valkey: a ferramenta é a valkey-check-aof", () => {
    expect(parseAofLoadError(VALKEY)).toMatchObject({ engine: "valkey", tool: "valkey-check-aof", manifest: "appendonly.aof.manifest", bytes: null });
  });

  it("arquivo que acaba no meio de um comando (aof-load-truncated desligado): kind truncated", () => {
    expect(parseAofLoadError(TRUNCATED)).toMatchObject({ kind: "truncated", file: "appendonlydir/appendonly.aof.9.incr.aof", bytes: null });
  });

  it("nome de AOF e pasta trocados pela configuração (appendfilename/appenddirname) e arquivo base", () => {
    const line = "# Bad file format reading the append only file dados-aof/fila.aof.1.base.rdb: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>";
    expect(parseAofLoadError(line)).toMatchObject({ dir: "dados-aof", manifest: "fila.aof.manifest", file: "dados-aof/fila.aof.1.base.rdb" });
  });

  it("bytes acima do inteiro exato do JavaScript viram 'não informado' (nunca um número errado)", () => {
    const line = REDIS8.replace("to 1397", "to 99999999999999999999").replace("29790725", "9999999999999999999");
    expect(parseAofLoadError(line)).toMatchObject({ bytes: null, offset: null });
  });
});

describe("parseAofLoadError — o que NÃO dispara", () => {
  it.each([
    ["linha comum do redis", "1:M 14 Nov 2026 03:12:01.123 * Ready to accept connections tcp"],
    ["carga que deu certo", "1:M 14 Nov 2026 03:12:01.123 * DB loaded from incr file appendonly.aof.27.incr.aof: 0.004 seconds"],
    ["recuperação automática do redis (truncou sozinho)", "# !!! Truncating the AOF appendonlydir/appendonly.aof.27.incr.aof at offset 29790725 !!!"],
    ["sem citar a ferramenta de reparo", "# Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 1."],
    ["ferramenta de outro produto", "# Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof: use ./keydb-check-aof --fix x"],
    ["AOF de arquivo único (Redis 6): o --fix do manifesto não se aplica", "# Bad file format reading the append only file appendonly.aof: make a backup of your AOF file, then use ./redis-check-aof --fix <filename>"],
    ["RDB corrompido é outro caso", "# Short read or OOM loading DB. Unrecoverable error, aborting now. use ./redis-check-rdb"],
  ])("%s", (_name, line) => {
    expect(parseAofLoadError(line)).toBeNull();
  });
});

describe("aofFileParts — nomes vindos do log (o projeto controla o log)", () => {
  it.each([
    "../etc/appendonly.aof.1.incr.aof",
    "appendonlydir/../appendonly.aof.1.incr.aof",
    "/data/appendonlydir/appendonly.aof.1.incr.aof",
    "a/b/appendonly.aof.1.incr.aof",
    "appendonlydir/.aof.1.incr.aof",
    "appendonlydir/..aof.1.incr.aof",
    ".hidden/appendonly.aof.1.incr.aof",
    "appendonlydir/appendonly.aof.1.incr.aof;rm",
    "appendonlydir/appendonly.aof.1.incr.txt",
    "appendonlydir/appendonly.aof.x.incr.aof",
    "-rf/appendonly.aof.1.incr.aof",
    "appendonlydir/$(id).aof.1.incr.aof",
  ])("recusa %s", (file) => {
    expect(aofFileParts(file)).toBeNull();
  });

  it("aceita o formato padrão", () => {
    expect(aofFileParts("appendonlydir/appendonly.aof.27.incr.aof")).toEqual({ dir: "appendonlydir", manifest: "appendonly.aof.manifest" });
  });

  it("um nome malicioso no log não vira diagnóstico", () => {
    expect(parseAofLoadError(REDIS8.replace("appendonlydir/appendonly.aof.27.incr.aof", "../../etc/x.aof.27.incr.aof"))).toBeNull();
  });
});

describe("detectAofCorruption — as linhas recentes do container", () => {
  it("pega a última tentativa de subir que falhou", () => {
    const older = REDIS8.replace("appendonly.aof.27", "appendonly.aof.26");
    expect(detectAofCorruption(["* Server initialized", older, "* Server initialized", REDIS8])?.file).toBe("appendonlydir/appendonly.aof.27.incr.aof");
  });

  it("depois que o redis ficou pronto, o problema antigo não vale mais", () => {
    expect(detectAofCorruption([REDIS8, "* Server initialized", "* Ready to accept connections tcp"])).toBeNull();
  });

  it("pronto antes e falha depois: vale a falha", () => {
    expect(detectAofCorruption(["* Ready to accept connections tcp", REDIS8])?.bytes).toBe(1397);
  });

  it("sem nada do AOF: null", () => {
    expect(detectAofCorruption([])).toBeNull();
    expect(detectAofCorruption(["* Ready to accept connections tcp"])).toBeNull();
  });
});
