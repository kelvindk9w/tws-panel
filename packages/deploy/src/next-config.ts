/**
 * next-config.ts — o que o `next.config.*` diz sobre o tipo de saída, lendo
 * só TEXTO. O arquivo nunca é executado nem importado: ele é código do
 * projeto e rodaria dentro do painel.
 *
 * Tudo aqui é linear no tamanho da entrada (um laço que anda uma vez sobre o
 * texto e expressões regulares sem repetição aninhada), e o texto lido é
 * limitado: um next.config hostil de megabytes não trava a detecção.
 */

/** Tamanho máximo lido de um next.config (um arquivo de configuração legítimo tem poucos KB). */
export const NEXT_CONFIG_MAX_CHARS = 256 * 1024;

/** Nomes aceitos, na ordem em que o Next.js os procura. */
export const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"] as const;

/**
 * Troca os comentários (de linha e de bloco) por um espaço, preservando o
 * conteúdo das strings ('…', "…", `…`). Assim um `// output: "export"`
 * esquecido num comentário não conta. Uma única passada; strings e
 * comentários sem fechamento vão até o fim do texto.
 */
export function stripJsComments(source: string): string {
  const text = source.length > NEXT_CONFIG_MAX_CHARS ? source.slice(0, NEXT_CONFIG_MAX_CHARS) : source;
  const parts: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      parts.push(" ");
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      parts.push(" ");
    } else if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i++;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i++;
      parts.push(text.slice(start, Math.min(i, n)));
    } else {
      parts.push(c);
      i++;
    }
  }
  return parts.join("");
}

/** O que o `output` do next.config declara. */
export type NextOutput = "export" | "standalone" | "other" | "dynamic" | "none";

// `output: <valor>` (chave com ou sem aspas). O valor vai até a vírgula, chave ou quebra de linha.
const OUTPUT_PROP = /(?:^|[\s,{(])["']?output["']?[ \t]*:[ \t]*([^,}\n]*)/g;
const LITERAL = /^(["'`])([A-Za-z-]*)\1(?:[ \t]+as[ \t]+const)?$/;

/**
 * Classifica o `output` do next.config (vale a melhor pista entre todas as
 * ocorrências, na ordem export > standalone > dynamic > other):
 *  - export / standalone: literais exatos;
 *  - dynamic: expressão (variável, ternário) — o painel não executa o arquivo, então não sabe;
 *  - other: outro literal (ex.: "server");
 *  - none: sem `output`. Um `output: { … }` (objeto) é do webpack, não do Next, e é ignorado.
 */
export function nextOutputOf(configSource: string): NextOutput {
  const found = new Set<NextOutput>();
  for (const match of stripJsComments(configSource).matchAll(OUTPUT_PROP)) {
    const value = match[1]!.trim(); // o grupo sempre participa do casamento
    if (value.startsWith("{")) continue;
    const literal = LITERAL.exec(value);
    if (!literal) found.add("dynamic");
    else if (literal[2] === "export") found.add("export");
    else if (literal[2] === "standalone") found.add("standalone");
    else found.add("other");
  }
  for (const kind of ["export", "standalone", "dynamic", "other"] as const) {
    if (found.has(kind)) return kind;
  }
  return "none";
}
