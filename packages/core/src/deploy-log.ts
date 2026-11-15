/**
 * deploy-log.ts — corte do log de deploy guardado por job.
 *
 * O log tem um teto (DEPLOY_LOG_MAX_CHARS). Passado o teto, ele guarda o COMEÇO (detecção, guardrails, primeiras
 * etapas e os primeiros erros de build) e o FIM (o erro final, o health check), com uma marca no meio dizendo quanto
 * foi omitido. O corte é feito a cada pedaço que chega (o log é escrito em tempo real), sem estado fora do próprio
 * texto: a marca guarda os contadores, então o mesmo log lido do disco depois de um reinício continua sendo cortado
 * do mesmo jeito.
 *
 * Regras do corte:
 *  - o começo é fixo depois do primeiro corte (até DEPLOY_LOG_HEAD_CHARS) e termina numa quebra de linha;
 *  - o fim é o que sobra do teto e começa no início de uma linha, salvo quando isso jogaria fora mais da metade do
 *    espaço do fim (linha gigante): aí o corte cai no meio da linha;
 *  - nenhum corte separa um par substituto (UTF-16) — um caractere fora do BMP (emoji, alguns ideogramas) nunca vira
 *    meio caractere, que viraria U+FFFD ao ser gravado em UTF-8;
 *  - começo + caracteres omitidos + fim = tudo o que foi escrito (a contagem é exata).
 */
import { DEPLOY_LOG_MAX_CHARS } from "./deploy";

/** Espaço do começo do log quando ele passa do teto (25% do teto; o resto fica para o fim, que traz o erro final). */
export const DEPLOY_LOG_HEAD_CHARS = 100_000;

/** Início fixo da marca do corte (o texto do log vem sempre em pt-BR; a tela traduz a marca ao copiar). */
export const DEPLOY_LOG_CUT_PREFIX = "\n[… log cortado no meio: ";

const CUT_RE = /\n\[… log cortado no meio: (\d+) caracteres e (\d+) linhas? omitidos; o começo e o fim foram guardados …\]\n/y;

/** O log cortado, separado nas três partes. */
export interface DeployLogCut {
  /** Começo guardado (texto original, termina numa quebra de linha ou no teto do começo). */
  head: string;
  /** Caracteres (unidades UTF-16, como `string.length`) que saíram do meio. */
  omittedChars: number;
  /** Quebras de linha que saíram do meio (linhas inteiras quando o corte cai em fronteira de linha). */
  omittedLines: number;
  /** Fim guardado (texto original, o mais recente). */
  tail: string;
  /** A marca como está no log. */
  marker: string;
}

/**
 * A marca do meio. Sempre numa linha própria: começa e termina com quebra de linha. Saem sempre mais caracteres do que
 * o espaço reservado para a marca, então "caracteres" fica sempre no plural.
 */
export function deployLogCutMarker(omittedChars: number, omittedLines: number): string {
  return `${DEPLOY_LOG_CUT_PREFIX}${omittedChars} caracteres e ${omittedLines} ${omittedLines === 1 ? "linha" : "linhas"} omitidos; o começo e o fim foram guardados …]\n`;
}

/** Maior tamanho possível da marca: o espaço reservado para ela, para o total nunca passar do teto. */
const MARKER_RESERVE = deployLogCutMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** A posição `at` cai entre as duas metades de um par substituto? (fora do texto, charCodeAt dá NaN: não cai) */
const splitsPair = (text: string, at: number) => isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Começo do log: até `max` caracteres, terminando na última quebra de linha que couber (senão, no próprio teto). */
function headOf(text: string, max: number): string {
  const nl = text.lastIndexOf("\n", max - 1);
  return nl === -1 ? text.slice(0, splitsPair(text, max) ? max - 1 : max) : text.slice(0, nl + 1);
}

/**
 * Onde o fim começa para caber em `budget`: no início da próxima linha, ou no meio dela se a linha for gigante.
 * Quem chama garante `text.length > budget > 0` (o texto passou do teto), então sempre sai alguma coisa.
 */
function tailStart(text: string, budget: number): number {
  const cut = text.length - budget;
  if (text.charCodeAt(cut - 1) === 10) return cut;
  const nl = text.indexOf("\n", cut);
  if (nl !== -1 && nl + 1 - cut <= budget / 2) return nl + 1;
  return splitsPair(text, cut) ? cut + 1 : cut;
}

/**
 * Lê a marca do corte. A marca de verdade começa logo depois do começo guardado (no máximo em `headMax`); uma frase
 * igual que o próprio build tenha escrito ANTES dela é ignorada (vale a última até `headMax`). Sem marca: null.
 */
export function parseDeployLogCut(log: string, headMax = DEPLOY_LOG_HEAD_CHARS): DeployLogCut | null {
  const at = log.lastIndexOf(DEPLOY_LOG_CUT_PREFIX, headMax);
  if (at === -1) return null;
  CUT_RE.lastIndex = at;
  const m = CUT_RE.exec(log);
  if (!m) return null;
  return {
    head: log.slice(0, at),
    omittedChars: Number(m[1]),
    omittedLines: Number(m[2]),
    tail: log.slice(at + m[0].length),
    marker: m[0],
  };
}

/**
 * Acrescenta um pedaço ao log respeitando o teto. Enquanto cabe, é só concatenar (o log fica intacto, inclusive no
 * teto exato). Passou: guarda o começo, a marca e o fim. Já cortado: o começo fica, o fim anda e a marca soma o que
 * saiu. O resultado nunca passa de `max`.
 */
export function appendDeployLog(log: string, chunk: string, max = DEPLOY_LOG_MAX_CHARS, headMax = DEPLOY_LOG_HEAD_CHARS): string {
  if (log.length + chunk.length <= max) return log + chunk;
  const cut = parseDeployLogCut(log, headMax);
  let head: string;
  let middle: string; // o que pode sair (fim antigo + pedaço novo), sem a marca
  let omittedChars = 0;
  let omittedLines = 0;
  if (cut) {
    ({ head, omittedChars, omittedLines } = cut);
    middle = cut.tail + chunk;
  } else {
    const full = log + chunk;
    head = headOf(full, headMax);
    middle = full.slice(head.length);
  }
  const start = tailStart(middle, max - head.length - MARKER_RESERVE);
  const dropped = middle.slice(0, start);
  return head + deployLogCutMarker(omittedChars + dropped.length, omittedLines + countLines(dropped)) + middle.slice(start);
}
