/**
 * redis-aof.test.ts — reconhecer no log do redis/valkey o AOF com o final corrompido: as mensagens das fontes
 * oficiais, com o texto exato de cada versão (src/aof.c, loadSingleAppendOnlyFile: Redis 7.2 :1629-1637, 8.0
 * :1712-1720, 8.2 :1715-1723, 8.4 :1736-1758; Valkey 8.1 :1623-1633 e unstable :1895-1905), o número de bytes
 * que só o Redis 8.4+ informa, mensagens parecidas que NÃO valem, nomes de arquivo maliciosos (o log é do
 * projeto: nada fora do formato seguro passa) e a pasta do AOF pela configuração do container.
 */
import { describe, expect, it } from "vitest";
import { aofDirFromArgs, aofFileParts, DEFAULT_AOF_DIR, detectAofCorruption, parseAofLoadError } from "../src/redis-aof";

const P = "1:M 14 Nov 2026 03:12:01.123 # ";
// Redis 8.4+: caminho com a pasta (aof_filepath), posição e tamanho do final; a continuação de linha no código
// deixa os espaços da indentação dentro da mensagem
const REDIS84 =
  P +
  "Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725.          make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>.          Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 and restart the server.";
// Redis 7.x, 8.0 e 8.2: só o nome do arquivo (filename), sem pasta, sem bytes
const REDIS7 = P + "Bad file format reading the append only file appendonly.aof.3.incr.aof: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>";
const VALKEY = P + "Bad file format reading the append only file appendonly.aof.5.incr.aof: make a backup of your AOF file, then use ./valkey-check-aof --fix <filename.manifest>";
// todas as versões: só o nome
const TRUNCATED =
  P +
  "Unexpected end of file reading the append only file appendonly.aof.9.incr.aof. You can: 1) Make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>. 2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and restart the server.";
const VALKEY_TRUNCATED = TRUNCATED.replace("./redis-check-aof", "./valkey-check-aof");

describe("parseAofLoadError — as mensagens oficiais", () => {
  it("Redis 8.4+: nome, a pasta escrita no log, manifesto, posição e os bytes do final que o próprio redis informa", () => {
    expect(parseAofLoadError(REDIS84)).toEqual({
      engine: "redis",
      tool: "redis-check-aof",
      kind: "format",
      file: "appendonly.aof.27.incr.aof",
      logDir: "appendonlydir",
      manifest: "appendonly.aof.manifest",
      offset: 29790725,
      bytes: 1397,
    });
  });

  it("Redis 7.x, 8.0 e 8.2: só o nome do arquivo, sem pasta, posição nem bytes", () => {
    expect(parseAofLoadError(REDIS7)).toEqual({
      engine: "redis",
      tool: "redis-check-aof",
      kind: "format",
      file: "appendonly.aof.3.incr.aof",
      logDir: null,
      manifest: "appendonly.aof.manifest",
      offset: null,
      bytes: null,
    });
  });

  it("Valkey: só o nome; a ferramenta é a valkey-check-aof", () => {
    expect(parseAofLoadError(VALKEY)).toMatchObject({ engine: "valkey", tool: "valkey-check-aof", file: "appendonly.aof.5.incr.aof", logDir: null, manifest: "appendonly.aof.manifest", bytes: null });
  });

  it("arquivo que acaba no meio de um comando (aof-load-truncated desligado), redis e valkey: kind truncated, só o nome", () => {
    expect(parseAofLoadError(TRUNCATED)).toMatchObject({ kind: "truncated", engine: "redis", file: "appendonly.aof.9.incr.aof", logDir: null, bytes: null });
    expect(parseAofLoadError(VALKEY_TRUNCATED)).toMatchObject({ kind: "truncated", engine: "valkey", tool: "valkey-check-aof", file: "appendonly.aof.9.incr.aof" });
  });

  it("nome de AOF trocado pela configuração (appendfilename) e arquivo base", () => {
    const line = P + "Bad file format reading the append only file fila.aof.1.base.rdb: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>";
    expect(parseAofLoadError(line)).toMatchObject({ file: "fila.aof.1.base.rdb", manifest: "fila.aof.manifest", logDir: null });
    const l84 = REDIS84.replace("appendonlydir/appendonly.aof.27.incr.aof", "dados-aof/fila.aof.2.incr.aof");
    expect(parseAofLoadError(l84)).toMatchObject({ file: "fila.aof.2.incr.aof", logDir: "dados-aof", manifest: "fila.aof.manifest" });
  });

  it("bytes acima do inteiro exato do JavaScript viram 'não informado' (nunca um número errado)", () => {
    const line = REDIS84.replace("to 1397", "to 99999999999999999999").replace("29790725", "9999999999999999999");
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

  it("aceita o nome sozinho (Redis 7.x a 8.2, Valkey) e com uma pasta (Redis 8.4+)", () => {
    expect(aofFileParts("appendonly.aof.27.incr.aof")).toEqual({ name: "appendonly.aof.27.incr.aof", logDir: null, manifest: "appendonly.aof.manifest" });
    expect(aofFileParts("appendonlydir/appendonly.aof.27.incr.aof")).toEqual({ name: "appendonly.aof.27.incr.aof", logDir: "appendonlydir", manifest: "appendonly.aof.manifest" });
  });

  it("um nome malicioso no log não vira diagnóstico, com ou sem pasta", () => {
    expect(parseAofLoadError(REDIS84.replace("appendonlydir/appendonly.aof.27.incr.aof", "../../etc/x.aof.27.incr.aof"))).toBeNull();
    expect(parseAofLoadError(REDIS7.replace("appendonly.aof.3.incr.aof", "..aof.3.incr.aof"))).toBeNull();
    expect(parseAofLoadError(REDIS7.replace("appendonly.aof.3.incr.aof", "$(id).aof.3.incr.aof"))).toBeNull();
  });
});

describe("aofDirFromArgs — a pasta do AOF vem da configuração do container, nunca do log", () => {
  it("sem --appenddirname: o padrão appendonlydir", () => {
    expect(aofDirFromArgs([])).toBe(DEFAULT_AOF_DIR);
    expect(aofDirFromArgs(["docker-entrypoint.sh", "redis-server", "--appendonly", "yes"])).toBe("appendonlydir");
  });

  it("com --appenddirname: o último vale", () => {
    expect(aofDirFromArgs(["redis-server", "--appenddirname", "a", "--appenddirname", "dados-aof"])).toBe("dados-aof");
  });

  it("valor fora do formato seguro (caminho, '..', vazio, opção): null", () => {
    for (const bad of ["../x", "/data/aof", "a/b", "..", ".", "", "-x", "a b"]) expect(aofDirFromArgs(["redis-server", "--appenddirname", bad])).toBeNull();
  });

  it("--appenddirname como último argumento, sem valor: fica o padrão (o redis nem sobe assim)", () => {
    expect(aofDirFromArgs(["redis-server", "--appenddirname"])).toBe("appendonlydir");
  });
});

describe("detectAofCorruption — as linhas recentes do container", () => {
  it("pega a última tentativa de subir que falhou", () => {
    const older = REDIS7.replace("appendonly.aof.3", "appendonly.aof.2");
    expect(detectAofCorruption(["* Server initialized", older, "* Server initialized", REDIS84])?.file).toBe("appendonly.aof.27.incr.aof");
    expect(detectAofCorruption([REDIS84, "* Server initialized", TRUNCATED])).toMatchObject({ kind: "truncated", file: "appendonly.aof.9.incr.aof" });
  });

  it("depois que o redis ficou pronto, o problema antigo não vale mais", () => {
    expect(detectAofCorruption([REDIS84, "* Server initialized", "* Ready to accept connections tcp"])).toBeNull();
  });

  it("pronto antes e falha depois: vale a falha", () => {
    expect(detectAofCorruption(["* Ready to accept connections tcp", REDIS84])?.bytes).toBe(1397);
  });

  it("sem nada do AOF: null", () => {
    expect(detectAofCorruption([])).toBeNull();
    expect(detectAofCorruption(["* Ready to accept connections tcp"])).toBeNull();
  });
});
