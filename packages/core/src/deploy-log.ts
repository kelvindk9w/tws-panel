/**
 * deploy-log.ts — corte do log de deploy guardado por job.
 *
 * O log tem um teto (DEPLOY_LOG_MAX_CHARS). Passado o teto, ele guarda o COMEÇO (detecção, guardrails, primeiras
 * etapas e os primeiros erros de build) e o FIM (o erro final, o health check), com uma marca no meio dizendo quanto
 * foi omitido. O corte é feito a cada pedaço que chega (o log é escrito em tempo real).
 *
 * Regras do corte:
 *  - o começo é fixo depois do primeiro corte (até DEPLOY_LOG_HEAD_CHARS) e termina numa quebra de linha (sem nenhuma
 *    quebra no espaço do começo, o corte cai no próprio teto do começo);
 *  - o fim é o que sobra do teto (menos uma folga de até 16.384 caracteres, que os pedaços seguintes vão ocupando) e
 *    começa no início de uma linha, salvo quando isso jogaria fora mais da metade do espaço do fim (linha gigante): aí
 *    o corte cai no meio da linha;
 *  - nenhum corte separa um par substituto (UTF-16) — um caractere fora do BMP (emoji, alguns ideogramas) nunca vira
 *    meio caractere, que viraria U+FFFD ao ser gravado em UTF-8;
 *  - começo + caracteres omitidos + fim = tudo o que foi escrito (a contagem é exata);
 *  - o total nunca passa do teto, venha o texto de onde vier.
 *
 * Onde a marca está: quem escreve o log de um job usa deployLogAppender, que guarda em memória a posição e o tamanho
 * da marca entre um pedaço e outro. Assim o texto que o build escreve nunca é confundido com a marca, e antes do
 * primeiro corte nada é procurado. Só quando essa informação não existe (log relido do disco depois de um reinício do
 * painel, ou a tela lendo o log) a marca é procurada no texto, com as regras de parseDeployLogCut.
 */
import { DEPLOY_LOG_MAX_CHARS } from "./deploy";

/** Espaço do começo do log quando ele passa do teto (25% do teto; o resto fica para o fim, que traz o erro final). */
export const DEPLOY_LOG_HEAD_CHARS = 100_000;

/** Início fixo da marca do corte (o texto do log vem sempre em pt-BR; a tela traduz a marca ao copiar). */
export const DEPLOY_LOG_CUT_PREFIX = "\n[… log cortado no meio: ";

const CUT_RE = /\n\[… log cortado no meio: (\d{1,16}) caracteres e (\d{1,16}) linhas? omitidos; o começo e o fim foram guardados …\]\n/y;

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

/** Onde está a marca num log cortado: o começo vai até `headLen`, a marca ocupa `markerLen`, o resto é o fim. */
interface CutState {
  headLen: number;
  markerLen: number;
  omittedChars: number;
  omittedLines: number;
}

/**
 * A marca do meio. Sempre numa linha própria: começa e termina com quebra de linha; depois de um começo que termina em
 * quebra de linha, fica uma linha em branco antes dela (é por isso que uma frase igual escrita pelo build, que vem logo
 * depois de uma linha comum, não passa por marca). Saem sempre mais caracteres do que o espaço reservado para a marca,
 * então "caracteres" fica sempre no plural. Contadores acima do maior inteiro seguro ficam nele (a marca tem tamanho
 * máximo conhecido, e o teto vale).
 */
export function deployLogCutMarker(omittedChars: number, omittedLines: number): string {
  const chars = Math.min(omittedChars, Number.MAX_SAFE_INTEGER);
  const lines = Math.min(omittedLines, Number.MAX_SAFE_INTEGER);
  return `${DEPLOY_LOG_CUT_PREFIX}${chars} caracteres e ${lines} ${lines === 1 ? "linha" : "linhas"} omitidos; o começo e o fim foram guardados …]\n`;
}

/** Maior tamanho possível da marca: o espaço reservado para ela, para o total nunca passar do teto. */
const MARKER_RESERVE = deployLogCutMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length;

/**
 * Folga do corte do fim: cada corte deixa até esta quantidade (no máximo 1/8 do espaço do fim) livre, para os pedaços
 * seguintes entrarem só concatenando. Sem ela, todo pedaço depois do primeiro corte recopiava o log inteiro.
 */
export const DEPLOY_LOG_TRIM_SLACK = 16_384;

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
 * O começo antes da posição `at` é um que o corte produziria? Termina em quebra de linha, ou não tem nenhuma quebra e
 * tem exatamente o teto do começo (um a menos quando o teto cairia no meio de um emoji).
 */
function isCutHead(log: string, at: number, headMax: number): boolean {
  if (log.charCodeAt(at - 1) === 10) return true;
  return (at === headMax || at === headMax - 1) && log.lastIndexOf("\n", at - 1) === -1;
}

/** Procura a marca no texto (sem estado): da última candidata até `headMax` para trás, a primeira que vale. */
function readCut(log: string, headMax: number): CutState | null {
  for (let at = log.lastIndexOf(DEPLOY_LOG_CUT_PREFIX, headMax); at > 0; at = log.lastIndexOf(DEPLOY_LOG_CUT_PREFIX, at - 1)) {
    if (!isCutHead(log, at, headMax)) continue;
    CUT_RE.lastIndex = at;
    const m = CUT_RE.exec(log);
    if (!m) continue;
    const omittedChars = Number(m[1]);
    const omittedLines = Number(m[2]);
    if (omittedChars > Number.MAX_SAFE_INTEGER || omittedLines > Number.MAX_SAFE_INTEGER) continue;
    return { headLen: at, markerLen: m[0].length, omittedChars, omittedLines };
  }
  return null;
}

/**
 * Lê a marca do corte direto do texto, para quem não tem o estado do escritor (a tela; o log relido do disco).
 * Vale a candidata mais perto do teto do começo cujo começo segue a regra do corte e cujos contadores são inteiros
 * seguros; senão, a anterior. Risco que sobra: o próprio build escrever uma linha em branco seguida de uma frase
 * idêntica à marca dentro dos primeiros `headMax` caracteres — aí essa frase passa por marca nesta leitura (os números
 * e a divisão começo/fim saem errados, o teto continua valendo). O escritor com estado (deployLogAppender) não lê o
 * texto e não tem esse risco.
 */
export function parseDeployLogCut(log: string, headMax = DEPLOY_LOG_HEAD_CHARS): DeployLogCut | null {
  const cut = readCut(log, headMax);
  if (!cut) return null;
  const end = cut.headLen + cut.markerLen;
  return {
    head: log.slice(0, cut.headLen),
    omittedChars: cut.omittedChars,
    omittedLines: cut.omittedLines,
    tail: log.slice(end),
    marker: log.slice(cut.headLen, end),
  };
}

/**
 * Um passo do corte. `state`: a marca conhecida (CutState), log sabidamente sem corte (null) ou desconhecido
 * (undefined: procura no texto, só se passar do teto).
 */
function step(log: string, chunk: string, state: CutState | null | undefined, max: number, headMax: number): { log: string; state: CutState | null | undefined } {
  if (log.length + chunk.length <= max) return { log: log + chunk, state };
  const cut = state === undefined ? readCut(log, headMax) : state;
  let head: string;
  let middle: string; // o que pode sair (fim antigo + pedaço novo), sem a marca
  let omittedChars = 0;
  let omittedLines = 0;
  if (cut) {
    head = log.slice(0, cut.headLen);
    middle = log.slice(cut.headLen + cut.markerLen) + chunk;
    ({ omittedChars, omittedLines } = cut);
  } else {
    const full = log + chunk;
    head = headOf(full, headMax);
    middle = full.slice(head.length);
  }
  // corta um pouco mais que o necessário (folga): os próximos pedaços cabem só concatenando, sem cortar a cada pedaço
  const room = max - head.length - MARKER_RESERVE;
  const start = tailStart(middle, room - Math.min(DEPLOY_LOG_TRIM_SLACK, Math.floor(room / 8)));
  const dropped = middle.slice(0, start);
  omittedChars += dropped.length;
  omittedLines += countLines(dropped);
  const marker = deployLogCutMarker(omittedChars, omittedLines);
  return { log: head + marker + middle.slice(start), state: { headLen: head.length, markerLen: marker.length, omittedChars, omittedLines } };
}

/**
 * Acrescenta um pedaço a um log sem estado (a marca, se houver, é procurada no texto com as regras de
 * parseDeployLogCut). Enquanto cabe, é só concatenar (o log fica intacto, inclusive no teto exato). O resultado nunca
 * passa de `max`. Para o log de um job, prefira deployLogAppender.
 */
export function appendDeployLog(log: string, chunk: string, max = DEPLOY_LOG_MAX_CHARS, headMax = DEPLOY_LOG_HEAD_CHARS): string {
  return step(log, chunk, undefined, max, headMax).log;
}

export interface DeployLogAppenderOptions {
  /** O log inicial veio do disco (deploy interrompido): pode já estar cortado. Sem isso, o log inicial é tido como sem corte. */
  resumed?: boolean;
  max?: number;
  headMax?: number;
}

/**
 * Escritor do log de um job: `(logAtual, pedaço) => logNovo`. Guarda em memória onde está a marca, então não procura
 * nada no texto (nem antes do primeiro corte, nem depois). Se o log recebido não for o que ele devolveu da última vez
 * (alguém mexeu no texto), volta a não saber e, ao passar do teto, procura a marca no texto.
 */
export function deployLogAppender(options: DeployLogAppenderOptions = {}): (log: string, chunk: string) => string {
  const max = options.max ?? DEPLOY_LOG_MAX_CHARS;
  const headMax = options.headMax ?? DEPLOY_LOG_HEAD_CHARS;
  let state: CutState | null | undefined = options.resumed ? undefined : null;
  let last: string | null = null;
  return (log, chunk) => {
    if (last !== null && log !== last) state = undefined;
    const next = step(log, chunk, state, max, headMax);
    state = next.state;
    last = next.log;
    return next.log;
  };
}
