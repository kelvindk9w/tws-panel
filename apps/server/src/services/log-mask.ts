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

/**
 * Padrões óbvios, aplicados depois dos valores exatos. Todos LINEARES no
 * tamanho da linha (log-mask-audit.test.ts roda entradas hostis sistemáticas
 * contra cada um): nenhum começa a casar em todo caractere e varre até o fim. O esquema da
 * URL, por exemplo, tem no máximo 32 caracteres e só começa onde não há letra
 * antes.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${LOG_MASK}`],
  [/(authorization["']?\s*[:=]\s*["']?(?:basic|digest|token)\s+)[^\s"',;]+/gi, `$1${LOG_MASK}`],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:)[^\s/]+(?=@)/gi, `$1${LOG_MASK}`],
  // Cookie / Set-Cookie: o valor todo (vários pares separados por ;) até o fim da linha ou da aspa
  [/((?<![A-Za-z0-9])(?:set-)?cookie(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^"'\r\n]+/gi, `$1${LOG_MASK}`],
  // session=, sessionid=, PHPSESSID=, JSESSIONID=
  [/((?<![A-Za-z0-9])(?:session(?:[_-]?id)?|phpsessid|jsessionid)=)[^\s"',;&]+/gi, `$1${LOG_MASK}`],
  [
    /((?<![A-Za-z0-9])(?:pass(?:word|wd)?|senha|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^\s"',;&\\]+/gi,
    `$1${LOG_MASK}`,
  ],
  // JWT: três partes base64url (o cabeçalho começa por eyJ)
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, LOG_MASK],
  [/tws_pat_[A-Za-z0-9_-]+/g, LOG_MASK],
];

function candidates(value: string): string[] {
  const out = [value, ...value.split("\n").map((l) => l.trim())];
  // forma de JSON (aspas e barras escapadas)
  out.push(JSON.stringify(value).slice(1, -1));
  try {
    const encoded = encodeURIComponent(value);
    // forma de URL e de formulário (espaço vira +)
    out.push(encoded, encoded.replace(/%20/g, "+"));
  } catch {
    // surrogate solto: sem a forma codificada
  }
  return out;
}

/** Máscara de UMA linha; `maxSecret` = tamanho do maior valor mascarado (quanto um começo de segredo pode medir). */
export type LogMasker = ((line: string) => string) & { readonly maxSecret: number };

/**
 * Monta a função que mascara UMA linha. `values` são os valores das variáveis
 * do projeto (próprias, do e-mail e as ligadas a ele). Uma passada só: o mais
 * longo vence quando um valor contém outro.
 */
export function buildLogMasker(values: readonly string[]): LogMasker {
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
  const mask = (line: string): string => {
    let out = exact ? line.replace(exact, LOG_MASK) : line;
    for (const [re, to] of PATTERNS) out = out.replace(re, to);
    return out;
  };
  return Object.assign(mask, { maxSecret: Math.max(0, ...[...secrets].map((x) => x.length)) });
}

/** Tira cores (ANSI), caracteres de controle e o \r final; o tab fica. */
export function stripLogControl(text: string): string {
  return text.replace(ANSI, "").replace(/\r+$/, "").replace(CONTROL, "");
}

/**
 * Texto de container → texto seguro para a tela: sem cores nem caracteres de
 * controle, com a máscara aplicada ANTES do corte de tamanho (um segredo na
 * fronteira não deixa o começo escapar).
 *
 * `cut`: a linha crua já foi cortada antes de chegar aqui (linha enorme), então
 * o fim dela pode ser o COMEÇO de um segredo ou de uma senha em URL que a máscara
 * não reconhece sem o resto. Nesse caso a ponta é descartada: a última "palavra"
 * (sem espaço) e, atrás dela, tantos caracteres quanto o maior segredo.
 */
export function cleanLogText(text: string, mask?: LogMasker, cut = false): string {
  let out = stripLogControl(text);
  if (mask) out = mask(out);
  if (cut) {
    out = out.replace(/\S+$/, "");
    const extra = mask ? Math.max(0, mask.maxSecret - 1) : 0;
    if (extra > 0) out = out.slice(0, Math.max(0, out.length - extra));
  }
  if (out.length > LOG_LINE_MAX) return `${out.slice(0, LOG_LINE_MAX)}…`;
  return cut ? `${out}…` : out;
}
