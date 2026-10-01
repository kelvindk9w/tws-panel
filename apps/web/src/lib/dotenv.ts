/**
 * dotenv.ts — leitura de um arquivo .env importado na seção Variáveis.
 *
 * O arquivo é lido no navegador; para o servidor vai só a lista nome/valor,
 * pelo mesmo caminho do formulário (gravada cifrada). Regras, no formato que o
 * docker compose aceita:
 *  - `# comentário`, linhas vazias e o prefixo `export ` são ignorados;
 *  - aspas simples: texto literal; aspas duplas: aceita \n, \r, \t, \" e \\;
 *    ambas podem continuar em várias linhas;
 *  - sem aspas: ` #` em diante é comentário; espaços nas pontas saem;
 *  - nome repetido: vale o último.
 */

export interface DotenvVar {
  key: string;
  value: string;
}

/** Mesma regra do servidor (project-env.ts). */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

export function parseDotenv(text: string): { vars: DotenvVar[]; skipped: number[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const found = new Map<string, string>();
  const skipped: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const key = eq === -1 ? "" : body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      skipped.push(lineNo);
      continue;
    }
    let rest = body.slice(eq + 1).trimStart();
    const quote = rest[0];

    if (quote === "'" || quote === '"') {
      // junta linhas até achar a aspa que fecha
      rest = rest.slice(1);
      let value = "";
      let closed = false;
      for (;;) {
        let j = 0;
        while (j < rest.length) {
          const c = rest[j]!;
          if (quote === '"' && c === "\\" && j + 1 < rest.length) {
            const next = rest[j + 1]!;
            value += ESCAPES[next] ?? `\\${next}`;
            j += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          value += c;
          j++;
        }
        if (closed || i + 1 >= lines.length) break;
        value += "\n";
        rest = lines[++i]!;
      }
      if (!closed) {
        skipped.push(lineNo);
        continue;
      }
      found.delete(key);
      found.set(key, value);
      continue;
    }

    const comment = rest.search(/\s#/);
    found.delete(key);
    found.set(key, (comment === -1 ? rest : rest.slice(0, comment)).trim());
  }

  return { vars: [...found].map(([key, value]) => ({ key, value })), skipped };
}
