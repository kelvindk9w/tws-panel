/**
 * dockerfile.ts — leitura mínima de um Dockerfile do usuário (só texto, nunca executado).
 *
 * Duas perguntas: qual porta a imagem FINAL anuncia (EXPOSE do último estágio) e quais
 * argumentos de build (ARG) ele declara. Heurística simples, sem interpretar variáveis.
 */
import path from "node:path";
import { readRegularFileLimited } from "./safe-fs.js";

/** Teto de leitura do Dockerfile (o mesmo da detecção). */
export const DOCKERFILE_MAX_BYTES = 1024 * 1024;

interface Instruction {
  keyword: string;
  rest: string;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Tira um par de aspas simples ou duplas em volta do valor (sem regex). */
function unquote(value: string): string {
  const q = value[0];
  return value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q) ? value.slice(1, -1) : value;
}

/** Instruções do Dockerfile: junta linhas com `\` no fim, tira comentários e linhas em branco. */
function instructions(content: string): Instruction[] {
  const out: Instruction[] = [];
  let pending = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (pending !== "" && line.startsWith("#")) continue; // comentário no meio de uma instrução
    const continued = line.endsWith("\\");
    pending += (pending ? " " : "") + (continued ? line.slice(0, -1).trim() : line);
    if (continued) continue;
    // palavra-chave = letras ASCII do começo; varredura linear (sem regex sobre entrada do usuário)
    let end = 0;
    while (end < pending.length && isAsciiLetter(pending.charCodeAt(end))) end++;
    if (end > 0) out.push({ keyword: pending.slice(0, end).toUpperCase(), rest: pending.slice(end).trimStart() });
    pending = "";
  }
  return out;
}

interface Stage {
  /** Nome do estágio (`FROM x AS nome`), minúsculo; null se não tem. */
  alias: string | null;
  /** Imagem ou estágio de que parte (minúsculo). */
  from: string;
  ports: number[];
}

function stagesOf(content: string): Stage[] {
  const stages: Stage[] = [];
  for (const { keyword, rest } of instructions(content)) {
    if (keyword === "FROM") {
      const tokens = rest.split(/\s+/).filter((t) => t !== "" && !t.startsWith("--"));
      const asAt = tokens.findIndex((t) => t.toUpperCase() === "AS");
      stages.push({
        alias: asAt > 0 && tokens[asAt + 1] ? tokens[asAt + 1]!.toLowerCase() : null,
        from: (tokens[0] ?? "").toLowerCase(),
        ports: [],
      });
    } else if (keyword === "EXPOSE" && stages.length > 0) {
      for (const token of rest.split(/\s+/)) {
        const m = /^(\d{1,5})(?:\/(?:tcp|udp))?$/i.exec(token);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 65535) stages[stages.length - 1]!.ports.push(Number(m[1]));
      }
    }
  }
  return stages;
}

/**
 * Primeira porta do EXPOSE do ÚLTIMO estágio (a imagem que de fato roda). Estágio final sem EXPOSE
 * que parte de um estágio anterior (`FROM base AS final`) herda o EXPOSE dele; um estágio de build
 * qualquer no meio do arquivo não conta. null = nenhuma porta anunciada.
 */
export function dockerfileExposePort(content: string): number | null {
  const stages = stagesOf(content);
  let at = stages.length - 1;
  const seen = new Set<number>();
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    const stage = stages[at]!;
    if (stage.ports.length > 0) return stage.ports[0]!;
    at = stages.slice(0, at).map((s) => s.alias).lastIndexOf(stage.from);
  }
  return null;
}

/**
 * Imagem de que parte o ÚLTIMO estágio (ou o do `build.target`; segue os apelidos de estágio: `FROM base AS final` → a imagem de `base`).
 * null = sem FROM ou `scratch`.
 */
export function dockerfileFinalBaseImage(content: string, target?: string | null): string | null {
  const stages = stagesOf(content);
  let at = stages.length - 1;
  if (target) {
    // `build.target`: o estágio de apelido igual ao alvo é o que roda; alvo que não existe = não dá para saber
    at = stages.map((s) => s.alias).lastIndexOf(target.toLowerCase());
    if (at < 0) return null;
  }
  while (at >= 0) {
    const from = stages[at]!.from;
    const earlier = stages.slice(0, at).map((s) => s.alias).lastIndexOf(from);
    if (earlier < 0) return from === "" || from === "scratch" ? null : from;
    at = earlier;
  }
  return null;
}

/** Nomes declarados por `ARG` (em qualquer estágio, com ou sem valor padrão). */
export function dockerfileArgNames(content: string): string[] {
  const names = new Set<string>();
  for (const { keyword, rest } of instructions(content)) {
    if (keyword !== "ARG") continue;
    for (const token of rest.split(/\s+/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$/.exec(token);
      if (m) names.add(m[1]!);
    }
  }
  return [...names];
}

/** Lê o Dockerfile da pasta (arquivo comum, até 1 MB); null se não dá para ler. */
export async function readDockerfileText(dir: string, name = "Dockerfile"): Promise<string | null> {
  return (await readRegularFileLimited(path.join(dir, name), DOCKERFILE_MAX_BYTES)) ?? null;
}

/**
 * Valor de `ENV TZ` na imagem FINAL (último estágio; herda do estágio anterior quando o FROM é um alias).
 * undefined = o Dockerfile não define. Aceita `ENV TZ=x`, `ENV TZ x` e vários pares na mesma linha.
 */
export function dockerfileEnvTz(content: string): string | undefined {
  const tzByAlias = new Map<string, string | undefined>();
  let current: string | undefined;
  let alias: string | null = null;
  const close = () => {
    if (alias) tzByAlias.set(alias, current);
  };
  for (const { keyword, rest } of instructions(content)) {
    if (keyword === "FROM") {
      close();
      const tokens = rest.split(/\s+/).filter((t) => t !== "" && !t.startsWith("--"));
      const asAt = tokens.findIndex((t) => t.toUpperCase() === "AS");
      alias = asAt > 0 && tokens[asAt + 1] ? tokens[asAt + 1]!.toLowerCase() : null;
      current = tzByAlias.get((tokens[0] ?? "").toLowerCase());
    } else if (keyword === "ENV") {
      const tokens = rest.split(/\s+/).filter((t) => t !== "");
      if (tokens[0] === "TZ" && tokens.length > 1) {
        // forma antiga: `ENV TZ valor`
        current = unquote(rest.slice(2).trim());
        continue;
      }
      for (const token of tokens) if (token.startsWith("TZ=")) current = unquote(token.slice(3));
    }
  }
  // valor montado por ARG/variável (`ENV TZ=$TZ_BUILD`): o literal não diz o fuso
  return current !== undefined && current.includes("$") ? "(definido por ARG)" : current;
}
