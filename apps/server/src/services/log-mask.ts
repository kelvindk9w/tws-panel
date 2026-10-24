/**
 * log-mask.ts — limpeza e máscara de segredos do texto dos logs dos containers
 * (aba Logs do projeto).
 *
 * MELHOR ESFORÇO, não garantia: esconde (1) os VALORES das variáveis do
 * próprio projeto que não são triviais (8 caracteres ou mais, fora algumas
 * palavras comuns de ambiente) e (2) padrões óbvios — Bearer/Basic, senha em
 * URL de conexão, `senha=`/`token:` e o token de API do painel. Um segredo
 * que o app escreve de outro jeito (partido em duas linhas, em base64, outro
 * nome de campo) passa. Quem lê o log precisa saber disso.
 */

export const LOG_MASK = "[oculto]";
/** Valor de variável com menos caracteres que isto não é mascarado (viraria ruído: portas, flags). */
export const LOG_SECRET_MIN = 8;
/** Uma linha de log nunca passa disto na resposta (o resto vira reticências). */
export const LOG_LINE_MAX = 2_000;

/** Valores que se repetem em qualquer log e não são segredo. */
const TRIVIAL_VALUES = new Set(["production", "development", "localhost", "127.0.0.1", "staging", "testing"]);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Padrões óbvios, aplicados depois dos valores exatos. Todos lineares (sem aninhar repetição). */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${LOG_MASK}`],
  [/(authorization["']?\s*[:=]\s*["']?(?:basic|digest|token)\s+)[^\s"',;]+/gi, `$1${LOG_MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/]+(?=@)/gi, `$1${LOG_MASK}`],
  [
    /((?<![A-Za-z0-9])(?:pass(?:word|wd)?|senha|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1${LOG_MASK}`,
  ],
  [/tws_pat_[A-Za-z0-9_-]+/g, LOG_MASK],
];

function candidates(value: string): string[] {
  const out = [value, ...value.split("\n").map((l) => l.trim())];
  try {
    out.push(encodeURIComponent(value));
  } catch {
    // surrogate solto: sem a forma codificada
  }
  return out;
}

/**
 * Monta a função que mascara UMA linha. `values` são os valores das variáveis
 * do projeto (próprias, do e-mail e as ligadas a ele). Uma passada só: o mais
 * longo vence quando um valor contém outro.
 */
export function buildLogMasker(values: readonly string[]): (line: string) => string {
  const secrets = new Set<string>();
  for (const value of values) {
    for (const c of candidates(value)) {
      if (c.length >= LOG_SECRET_MIN && !TRIVIAL_VALUES.has(c.toLowerCase())) secrets.add(c);
    }
  }
  const exact =
    secrets.size === 0
      ? null
      : new RegExp([...secrets].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");
  return (line) => {
    let out = exact ? line.replace(exact, LOG_MASK) : line;
    for (const [re, to] of PATTERNS) out = out.replace(re, to);
    return out;
  };
}

/**
 * Texto de container → texto seguro para a tela: sem cores nem caracteres de
 * controle (tab fica), com a máscara aplicada ANTES do corte de tamanho (um
 * segredo na fronteira não deixa o começo escapar).
 */
export function cleanLogText(text: string, mask?: (line: string) => string): string {
  let out = text.replace(ANSI, "").replace(/\r+$/, "").replace(CONTROL, "");
  if (mask) out = mask(out);
  return out.length > LOG_LINE_MAX ? `${out.slice(0, LOG_LINE_MAX)}…` : out;
}
