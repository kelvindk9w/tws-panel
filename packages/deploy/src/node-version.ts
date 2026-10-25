/**
 * node-version.ts — qual Node o build e a execução de um servidor Node usam.
 *
 * Fontes, na ordem: `engines.node` do package.json, `.nvmrc`, `.node-version`.
 * A primeira que existir decide. Só os majors de NODE_SERVER_MAJORS têm
 * imagem (fixada por digest); o resto cai no padrão (Node 22 LTS) com um
 * aviso. A leitura é só de texto, linear e limitada: nada de `semver`.
 *
 * Aproximação deliberada: a faixa é avaliada por MAJOR (a imagem é sempre a
 * última linha daquele major, ex. 22.x mais recente). `^22.12`, `~22.1`, `22`
 * e `22.12.0` pedem o major 22; `>=`/`>` e `<`/`<=` comparam com a última
 * versão do major.
 */
import {
  NODE_SERVER_DEFAULT_MAJOR,
  NODE_SERVER_MAJORS,
  type NodeMajor,
  type NodeVersionSource,
} from "@paas/core";

const MAX_RANGE_CHARS = 200;
const MAX_SETS = 20;
const MAX_TOKENS = 20;

interface Partial3 {
  major: number;
  minor: number | null;
  patch: number | null;
}

/** "22", "v22.1", "22.x", "22.1.0" → componentes; "x"/"*"/ausente = curinga. Inválido = null. */
function parsePartial(text: string): Partial3 | null {
  const m = /^v?(\d{1,4})(?:\.(\d{1,5}|[xX*]))?(?:\.(\d{1,5}|[xX*]))?(?:[-+][0-9A-Za-z.+-]*)?$/.exec(text);
  if (!m) return null;
  const num = (s: string | undefined): number | null => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  return { major: Number(m[1]), minor: num(m[2]), patch: num(m[3]) };
}

/** Candidato: a última versão do major (major.99.99). */
function cmpLatest(major: number, p: Partial3): number {
  if (major !== p.major) return major < p.major ? -1 : 1;
  const minor = p.minor ?? 0;
  const patch = p.patch ?? 0;
  if (99 !== minor) return 99 < minor ? -1 : 1;
  if (99 !== patch) return 99 < patch ? -1 : 1;
  return 0;
}

function satisfiesComparator(major: number, token: string): boolean | null {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!; // casa sempre: `.*` aceita qualquer texto
  const op = m[1] ?? "";
  const p = parsePartial(m[2]!);
  if (!p) return null;
  switch (op) {
    case ">=":
      return cmpLatest(major, p) >= 0;
    case ">":
      return p.minor === null ? major > p.major : cmpLatest(major, p) > 0;
    case "<=":
      return p.minor === null ? major <= p.major : cmpLatest(major, p) <= 0;
    case "<":
      return cmpLatest(major, { ...p, minor: p.minor ?? 0, patch: p.patch ?? 0 }) < 0;
    default:
      // "", "=", "^", "~": a linha do major (22.12.0 também pede o Node 22)
      return major === p.major;
  }
}

/** Todos os comparadores de um conjunto (separados por espaço; "A - B" vira >=A <=B). */
function satisfiesSet(major: number, set: string): boolean | null {
  const parts = set.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_TOKENS) return null;
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i + 1] === "-" && parts[i + 2] !== undefined) {
      tokens.push(`>=${parts[i]}`, `<=${parts[i + 2]}`);
      i += 2;
    } else {
      tokens.push(parts[i]!);
    }
  }
  let all = true;
  for (const token of tokens) {
    const ok = satisfiesComparator(major, token);
    if (ok === null) return null;
    if (!ok) all = false;
  }
  return all;
}

/**
 * O major satisfaz a faixa `engines.node`? null = faixa que não entendemos
 * (nesse caso o chamador usa o padrão).
 */
export function majorSatisfies(range: string, major: number): boolean | null {
  const text = range.trim();
  if (text === "" || text.length > MAX_RANGE_CHARS) return null;
  if (text === "*" || text.toLowerCase() === "x") return true;
  const sets = text.split("||");
  if (sets.length > MAX_SETS) return null;
  let any = false;
  for (const set of sets) {
    const ok = satisfiesSet(major, set.trim());
    if (ok === null) return null;
    if (ok) any = true;
  }
  return any;
}

export interface NodeVersionInput {
  /** `engines.node` do package.json. */
  engines?: string | undefined;
  /** Conteúdo do `.nvmrc`. */
  nvmrc?: string | undefined;
  /** Conteúdo do `.node-version`. */
  nodeVersionFile?: string | undefined;
}

export interface NodeVersionChoice {
  major: NodeMajor;
  source: NodeVersionSource;
  notes: string[];
}

const SUPPORTED_TEXT = NODE_SERVER_MAJORS.join(", ");

function fallback(source: NodeVersionSource, notes: string[], why: string): NodeVersionChoice {
  notes.push(`${why} O painel usa o Node ${NODE_SERVER_DEFAULT_MAJOR} (LTS). Versões aceitas: ${SUPPORTED_TEXT}.`);
  return { major: NODE_SERVER_DEFAULT_MAJOR, source, notes };
}

/** Escolhe o major do Node (ver o cabeçalho do arquivo para as regras). */
export function pickNodeMajor(input: NodeVersionInput): NodeVersionChoice {
  const notes: string[] = [];
  const engines = input.engines?.trim();
  if (engines) {
    // prefere o padrão (22) quando a faixa aceita; senão o major mais novo que ela aceita
    const order = [NODE_SERVER_DEFAULT_MAJOR, ...[...NODE_SERVER_MAJORS].reverse().filter((m) => m !== NODE_SERVER_DEFAULT_MAJOR)];
    let understood = true;
    for (const major of order) {
      const ok = majorSatisfies(engines, major);
      if (ok === null) {
        understood = false;
        break;
      }
      if (ok) {
        notes.push(`engines.node → Node ${major}.`);
        return { major: major as NodeMajor, source: "engines", notes };
      }
    }
    return fallback(
      "engines",
      notes,
      understood
        ? "engines.node não aceita nenhum Node disponível."
        : "engines.node com valor inválido (o painel não entendeu a faixa).",
    );
  }
  for (const [text, source, name] of [
    [input.nvmrc, "nvmrc", ".nvmrc"],
    [input.nodeVersionFile, "node-version", ".node-version"],
  ] as const) {
    const line = text?.trim().split(/\r?\n/, 1)[0]?.trim();
    if (!line) continue;
    const m = /^v?(\d{1,4})(?:\.|$)/.exec(line);
    if (!m) return fallback(source, notes, `${name} com valor inválido (não indica um número de versão).`);
    const major = Number(m[1]);
    if ((NODE_SERVER_MAJORS as readonly number[]).includes(major)) {
      notes.push(`${name} → Node ${major}.`);
      return { major: major as NodeMajor, source, notes };
    }
    return fallback(source, notes, `${name} pede o Node ${major}, que o painel não oferece.`);
  }
  notes.push(`Nenhuma versão do Node pedida (engines.node, .nvmrc, .node-version): Node ${NODE_SERVER_DEFAULT_MAJOR} (LTS).`);
  return { major: NODE_SERVER_DEFAULT_MAJOR, source: "default", notes };
}
