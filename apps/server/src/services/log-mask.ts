/**
 * log-mask.ts — limpeza e máscara de segredos do texto dos logs dos containers
 * (aba Logs do projeto).
 *
 * MELHOR ESFORÇO, não garantia: esconde (1) os VALORES das variáveis do
 * próprio projeto que não são triviais (8 caracteres ou mais, fora algumas
 * palavras comuns de ambiente) e (2) padrões óbvios — Bearer/Basic, senha em
 * URL de conexão, `senha=`/`token:` e o token de API do painel. Os valores
 * também são reconhecidos em base64 e hexadecimal. Um segredo que o app escreve
 * de outro jeito (partido em duas linhas, transformado, outro nome de campo)
 * passa. Quem lê o log precisa saber disso.
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
  // base64 (comum e de URL, com e sem o "=" final) e hexadecimal (minúsculo e maiúsculo): um app que "imprime o
  // ambiente codificado" não fura a máscara só por isso. Melhor esforço: o valor emendado no meio de um texto
  // maior codificado muda de forma e não é reconhecido.
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  out.push(b64, b64.replace(/=+$/, ""), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase());
  return out;
}

/** Todas as formas (cru, JSON, URL, base64, hex) em que o valor de uma variável pode aparecer, já filtradas. */
export function secretForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    for (const c of candidates(value)) if (c.length >= LOG_SECRET_MIN && !TRIVIAL_VALUES.has(c.toLowerCase())) forms.add(c);
  }
  return [...forms];
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

/** Da ponta de uma linha cortada, no máximo isto da última "palavra" (sem espaço) é descartado. */
export const TAIL_RUN_MAX = 512;
/** Quanto do fim a procura de JWT e de URL parcial olha (linear, com teto). */
const TAIL_SCAN_MAX = 4096;
const SPACE = /\s/;
const B64 = /[A-Za-z0-9_-]/;
const JWT_CHAR = /[A-Za-z0-9_.-]/;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;

/**
 * Onde começar a descartar a ponta de uma linha cortada. Tudo é varredura com teto
 * (nada de regex ancorada no fim, que seria quadrática).
 */
function cutTailStart(out: string, maxSecret: number): number {
  const n = out.length;
  let start = n;
  // última palavra, até TAIL_RUN_MAX caracteres
  let i = n;
  while (i > 0 && n - i < TAIL_RUN_MAX && !SPACE.test(out[i - 1]!)) i--;
  start = Math.min(start, i);
  // começo do maior segredo
  if (maxSecret > 1) start = Math.min(start, Math.max(0, n - (maxSecret - 1)));
  // JWT cortado: o trecho final de [A-Za-z0-9_.-] que contém um "eyJ" que começa palavra
  let r = n;
  while (r > 0 && n - r < TAIL_SCAN_MAX && JWT_CHAR.test(out[r - 1]!)) r--;
  for (let k = out.indexOf("eyJ", r); k !== -1; k = out.indexOf("eyJ", k + 1)) {
    if (k === r ? r === 0 || !B64.test(out[r - 1]!) : !B64.test(out[k - 1]!)) {
      start = Math.min(start, k);
      break;
    }
  }
  // senha em URL ainda sem o "@": "esquema://usuário:senha" no fim
  const u = out.lastIndexOf("://");
  if (u !== -1 && n - u <= TAIL_SCAN_MAX) {
    let open = true;
    for (let j = u + 3; j < n; j++) {
      const c = out[j]!;
      if (c === "/" || c === "@" || SPACE.test(c)) {
        open = false;
        break;
      }
    }
    if (open) {
      let sch = u;
      while (sch > 0 && u - sch < 32 && SCHEME_CHAR.test(out[sch - 1]!)) sch--;
      start = Math.min(start, sch);
    }
  }
  return start;
}

/**
 * Texto de container → texto seguro para a tela: sem cores nem caracteres de
 * controle, com a máscara aplicada ANTES do corte de tamanho (um segredo na
 * fronteira não deixa o começo escapar).
 *
 * `cut`: a linha crua já foi cortada antes de chegar aqui (linha enorme), então
 * o fim dela pode ser o COMEÇO de um segredo, de um JWT ou de uma senha em URL
 * que a máscara não reconhece sem o resto. A ponta é descartada só no necessário
 * (cutTailStart): a última palavra (até TAIL_RUN_MAX caracteres), tantos
 * caracteres quanto o maior segredo, um JWT ou uma URL ainda sem o `@`.
 */
export function cleanLogText(text: string, mask?: LogMasker, cut = false): string {
  let out = stripLogControl(text);
  if (mask) out = mask(out);
  if (cut) {
    out = out.slice(0, cutTailStart(out, mask?.maxSecret ?? 0));
  }
  if (out.length > LOG_LINE_MAX) return `${out.slice(0, LOG_LINE_MAX)}…`;
  return cut ? `${out}…` : out;
}
