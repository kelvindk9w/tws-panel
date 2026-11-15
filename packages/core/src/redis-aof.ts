/**
 * redis-aof.ts — arquivo de persistência (AOF) do Redis/Valkey com o final corrompido.
 *
 * Caso real: a VPS cai de forma brusca no meio de uma gravação e o fim do .incr.aof fica com conteúdo inválido
 * (zeros ou lixo: o sistema de arquivos guardou o tamanho novo sem o conteúdo). Ao subir de novo, o redis lê o AOF
 * de vários arquivos (<appenddirname>/<nome>.<n>.incr.aof + <nome>.manifest), acha bytes que não formam comando
 * e PARA ("Bad file format"). O Docker reinicia o container sem parar (e quem depende dele cai junto). A correção
 * é a do próprio redis: cópia da pasta e `redis-check-aof --fix <manifest>`, que corta o final a partir do último
 * comando inteiro.
 * Arquivo só TRUNCADO (o último comando pela metade) não trava o redis: com `aof-load-truncated yes`, o padrão,
 * ele descarta esse pedaço e sobe sozinho (conferido no Redis 8.10.3, num ambiente de teste; ver
 * https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/#what-should-i-do-if-my-aof-gets-truncated).
 * Reproduzir num ambiente de teste: parar o redis, acrescentar 2048 bytes de zeros no fim do .incr.aof mais
 * recente e ligar de novo (o guia site/src/content/docs/pt-br/guides/redis-aof-repair.md tem o passo a passo).
 *
 * As mensagens, conferidas no código do servidor (src/aof.c, função loadSingleAppendOnlyFile):
 *  - Redis 7.x, 8.0 e 8.2, e Valkey (com ./valkey-check-aof): só o NOME do arquivo, sem a pasta e sem os bytes:
 *      Bad file format reading the append only file appendonly.aof.27.incr.aof: make a backup of your AOF file,
 *      then use ./redis-check-aof --fix <filename.manifest>
 *  - Redis 8.4 em diante: o caminho com a pasta (aof_filepath), a posição e o tamanho do final ilegível
 *    (st_size − último ponto válido), que só existe a partir dessa versão:
 *      Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725.
 *               make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>.
 *               Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 ...
 *  - todas as versões, com aof-load-truncated desligado (o arquivo acaba no meio de um comando, por exemplo lixo
 *    que parece o começo de um comando): só o nome:
 *      Unexpected end of file reading the append only file appendonly.aof.9.incr.aof. You can: 1) ...
 *
 * Só o formato de vários arquivos (pasta + manifesto, Redis 7+ e Valkey) é reconhecido: é nele que o
 * `--fix <manifesto>` funciona. A PASTA do AOF nunca vem do log: vem da configuração do container
 * (`aofDirFromArgs`); a pasta que o Redis 8.4+ escreve no log só serve para conferir. O nome do arquivo vem do
 * log do container, que o projeto controla: ele só vale no formato `<nome>.<n>.(incr|base).(aof|rdb)` (com ou
 * sem uma pasta na frente) com caracteres seguros, e nunca vira texto de shell (vai como argumento).
 */

export type AofEngine = "redis" | "valkey";

/** O que o log do container diz sobre o AOF corrompido. */
export interface AofCorruption {
  engine: AofEngine;
  /** Ferramenta de reparo que vem na própria imagem. */
  tool: "redis-check-aof" | "valkey-check-aof";
  /** "format": bytes que não formam comando (ex.: zeros ou lixo no fim); "truncated": o arquivo acaba no meio de um comando (só com aof-load-truncated desligado). */
  kind: "format" | "truncated";
  /** Nome do arquivo citado, sem pasta (ex.: appendonly.aof.27.incr.aof). */
  file: string;
  /** Pasta que o Redis 8.4+ escreve antes do nome; null nas outras versões. Só para conferir: a pasta usada vem do container. */
  logDir: string | null;
  /** Nome do manifesto dentro da pasta do AOF (appendfilename + ".manifest"). */
  manifest: string;
  /** Posição do último comando inteiro, quando o redis a informa (Redis 8.4+). */
  offset: number | null;
  /** Bytes do final que não puderam ser lidos (e serão descartados), quando o redis os informa (Redis 8.4+). */
  bytes: number | null;
}

/** Um serviço de projeto em ciclo de reinício por causa do AOF corrompido. */
export interface ProjectAofFinding {
  /** Serviço do compose (ou nome do container, fora de compose). */
  service: string;
  /** Nome do container. */
  container: string;
  engine: AofEngine;
  kind: AofCorruption["kind"];
  /** Nome do arquivo, sem pasta. */
  file: string;
  /** Bytes que o próprio redis diz que não conseguiu ler; null = ele não informa (Redis antes do 8.4, Valkey). */
  bytes: number | null;
}

/** POST /api/projects/:id/aof-repair/measure — quanto a ferramenta cortaria (nada é alterado). */
export interface AofMeasureRequest {
  service: string;
}

export interface AofMeasureResponse {
  service: string;
  file: string;
  /** Bytes que o `--fix` descartaria agora, medidos pela ferramenta da imagem. */
  bytes: number;
}

/** POST /api/projects/:id/aof-repair — o reparo confirmado pela pessoa. */
export interface AofRepairRequest {
  service: string;
  /** O máximo que a pessoa aceitou descartar (o número que ela viu na confirmação). Acima disso, nada é cortado. */
  maxBytes: number;
}

/** Resultado do reparo que chegou a parar o serviço (as falhas antes disso voltam como erro, sem nada alterado). */
export interface AofRepairResponse {
  ok: boolean;
  /**
   * repaired: copiou, cortou e religou (ou deixou parado, com o projeto parado pela pessoa: keptStopped);
   * fix_failed: a cópia foi feita mas a ferramenta não cortou (o serviço foi religado como estava);
   * backup_failed: a cópia não pôde ser feita (nada foi cortado; o serviço foi religado);
   * start_failed: cortou, mas o serviço não voltou a subir (veja os logs).
   */
  outcome: "repaired" | "fix_failed" | "backup_failed" | "start_failed";
  service: string;
  /** Pasta da cópia feita antes do corte (relativa à pasta de dados); null = não foi feita. */
  backup: string | null;
  /** Bytes descartados pela ferramenta; null = nada foi cortado (ou a saída não disse). */
  discardedBytes: number | null;
  /** O serviço foi ligado de novo depois do reparo. */
  restarted: boolean;
  /**
   * O projeto está parado pela pessoa (botão Parar): o painel não liga o serviço no fim, deixa como ela deixou.
   * Com true, `restarted` é false de propósito.
   */
  keptStopped: boolean;
  /** Saída das etapas (ferramenta e Docker), sem cores, cortada. */
  output: string;
}

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,199}";
/** [<pasta>/]<nome>.<n>.(incr|base).(aof|rdb) — o formato de vários arquivos do Redis 7+ e do Valkey. */
const MULTIPART_FILE = new RegExp(`^(?:(${SEGMENT})/)?(${SEGMENT})\\.(\\d{1,12})\\.(incr|base)\\.(aof|rdb)$`);
const DIR_NAME = new RegExp(`^${SEGMENT}$`);
/** Pasta do AOF quando a configuração não diz outra (appenddirname, Redis 7+ e Valkey). */
export const DEFAULT_AOF_DIR = "appendonlydir";

const LOAD_ERROR = /(Bad file format|Unexpected end of file) reading the append only file (\S+?)(?: at offset (\d{1,19}))?(?=[.:]?(?:\s|$))/;
const TOOL = /\.\/(redis|valkey)-check-aof\b/;
const TAIL_SIZE = /'aof-load-corrupt-tail-max-size' configuration option to (\d{1,19})\b/;

function safeInt(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  // só dígitos chegam aqui: o que importa é caber num inteiro exato
  return Number.isSafeInteger(n) ? n : null;
}

/** Nome de arquivo do log → nome sem pasta, a pasta escrita no log (Redis 8.4+) e o manifesto; null fora do formato seguro. */
export function aofFileParts(file: string): { name: string; logDir: string | null; manifest: string } | null {
  const m = MULTIPART_FILE.exec(file);
  if (!m) return null;
  // cada parte começa com letra ou número: "." e ".." nunca passam, e no máximo um nível de pasta
  return { name: file.slice(file.lastIndexOf("/") + 1), logDir: m[1] ?? null, manifest: `${m[2]!}.manifest` };
}

/**
 * Pasta do AOF pela configuração do container: o último `--appenddirname <nome>` dos argumentos ou, sem ele, o
 * padrão `appendonlydir`. O redis só aceita um nome (sem barra: isValidAOFdirname em config.c); null = valor fora
 * do formato seguro. Uma pasta trocada num arquivo redis.conf não aparece aqui: o manifesto não é achado e nada é feito.
 */
export function aofDirFromArgs(argv: readonly string[]): string | null {
  let dir: string = DEFAULT_AOF_DIR;
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--appenddirname") dir = argv[i + 1]!;
  return DIR_NAME.test(dir) ? dir : null;
}

/** Uma linha de log → o AOF corrompido que ela descreve; null se não for a mensagem de carga do AOF que falhou. */
export function parseAofLoadError(line: string): AofCorruption | null {
  const m = LOAD_ERROR.exec(line);
  if (!m) return null;
  const tool = TOOL.exec(line);
  if (!tool) return null;
  const parts = aofFileParts(m[2]!);
  if (!parts) return null;
  const engine: AofEngine = tool[1] === "valkey" ? "valkey" : "redis";
  return {
    engine,
    tool: engine === "valkey" ? "valkey-check-aof" : "redis-check-aof",
    kind: m[1] === "Bad file format" ? "format" : "truncated",
    file: parts.name,
    logDir: parts.logDir,
    manifest: parts.manifest,
    offset: safeInt(m[3]),
    bytes: safeInt(TAIL_SIZE.exec(line)?.[1]),
  };
}

/**
 * As linhas recentes do log de um container → o AOF corrompido da ÚLTIMA tentativa de subir que falhou por ele.
 * Depois de uma linha que mostra o redis pronto ("Ready to accept connections"), o problema anterior não vale mais.
 */
export function detectAofCorruption(lines: readonly string[]): AofCorruption | null {
  let found: AofCorruption | null = null;
  for (const line of lines) {
    const hit = parseAofLoadError(line);
    if (hit) found = hit;
    else if (found !== null && /Ready to accept connections/.test(line)) found = null;
  }
  return found;
}
