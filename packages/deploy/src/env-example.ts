/**
 * env-example.ts — nomes das variáveis que o repositório documenta num
 * arquivo de exemplo (`.env.example`, `.env.sample`, `.env.dist`,
 * `.env.template`) ou, quando existe, no exemplo de PRODUÇÃO
 * (`.env.production.example`, `.env.prod.example` e variações).
 *
 * Caso real (06/11/2026): o `.env.example` de um kit Laravel é o ambiente de
 * DESENVOLVIMENTO (~250 nomes: DEV_*, COMPOSE_*, APP_DEBUG…) e a lista de
 * produção fica no `.env.prod.example` (36). Sugerir os dois encheu a tela de
 * campos vazios que a produção não usa. Com um exemplo de produção no
 * repositório, só ele vale; sem ele, vale o `.env.example`.
 *
 * Validação real (vitrine, 03/10/2026): o app lê SMTP_USUARIO e SMTP_SENHA
 * por `env_file: .env`, sem `${...}` no compose; só o `.env.example` as cita.
 * A tela usa estes nomes como sugestões (ex.: "Ligar às variáveis do
 * projeto"). Só os NOMES saem daqui — o valor de exemplo pode ser um
 * segredo esquecido no repositório.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { EnvExampleList, EnvExampleVariable } from "@paas/core";

export type { EnvExampleList, EnvExampleVariable };

/** Arquivos de exemplo procurados, nesta ordem (quando o repositório não tem um exemplo de produção). */
export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.dist", ".env.template"] as const;

/**
 * Exemplos de PRODUÇÃO, nesta ordem. Se qualquer um existir (na raiz ou na pasta do compose), só eles são lidos.
 * O `.env.production` sem sufixo fica de fora: é um arquivo de ambiente de verdade, não uma lista de exemplo.
 */
export const PROD_ENV_EXAMPLE_FILES = [
  ".env.production.example",
  ".env.prod.example",
  ".env.example.production",
  ".env.example.prod",
  ".env.production.sample",
  ".env.prod.sample",
  ".env.production.dist",
  ".env.prod.dist",
  ".env.production.template",
  ".env.prod.template",
] as const;

/** Um arquivo de exemplo de verdade tem poucos KB. */
const MAX_EXAMPLE_BYTES = 256 * 1024;

/**
 * Nomes citados no texto, sem repetir, na ordem em que aparecem. Vale só
 * `NOME=` e `export NOME=`; linha comentada (`# NOME=…`), comentário comum e
 * linha inválida não geram nome (comentários rendiam nomes-lixo como `VAR`).
 */
export function envExampleNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Lê os arquivos de exemplo de cada pasta (relativa a `srcDir`; "" = raiz),
 * ignorando pasta repetida, caminho ou link que sai do código e arquivo
 * grande demais. Cada nome fica com o primeiro arquivo onde aparece.
 *
 * Se alguma pasta tem um exemplo de produção (`PROD_ENV_EXAMPLE_FILES`), só os
 * de produção são lidos — em todas as pastas — e `production` vem `true`; os de
 * desenvolvimento (`.env.example`…) ficam de fora, inclusive os de outra pasta.
 * Exemplo de produção ignorado (link para fora, grande demais, pasta) não conta.
 * `null` quando não há nenhum arquivo de exemplo.
 */
export async function readEnvExamples(srcDir: string, dirs: string[]): Promise<EnvExampleList | null> {
  const root = await realpath(srcDir);
  const unique = [...new Set(dirs)];
  const prod = await readSet(root, unique, PROD_ENV_EXAMPLE_FILES);
  if (prod.length > 0) return collect(prod, true);
  const dev = await readSet(root, unique, ENV_EXAMPLE_FILES);
  return dev.length > 0 ? collect(dev, false) : null;
}

/**
 * Nomes citados em TODOS os arquivos de exemplo (produção E desenvolvimento), sem a preferência de `readEnvExamples`.
 * Para proteções que não podem deixar passar nada que o app talvez leia (ex.: a migração de rede não move o projeto
 * cujo `.env.example` cita PAAS_PROXY_IP, mesmo que o `.env.prod.example` não cite). Mesmas regras de leitura.
 */
export async function readAllEnvExampleNames(srcDir: string, dirs: string[]): Promise<string[]> {
  const root = await realpath(srcDir);
  const unique = [...new Set(dirs)];
  const found = [...(await readSet(root, unique, PROD_ENV_EXAMPLE_FILES)), ...(await readSet(root, unique, ENV_EXAMPLE_FILES))];
  return collect(found, false).variables.map((v) => v.name);
}

/** Os arquivos de `names` que existem em cada pasta, com o texto, na ordem das pastas e dos nomes. */
async function readSet(root: string, dirs: string[], names: readonly string[]): Promise<Array<{ rel: string; text: string }>> {
  const found: Array<{ rel: string; text: string }> = [];
  for (const dir of dirs) {
    for (const name of names) {
      const rel = path.posix.join(dir.split(path.sep).join("/"), name);
      const text = await readInside(root, path.join(root, rel));
      if (text !== null) found.push({ rel, text });
    }
  }
  return found;
}

/** Só os nomes, cada um com o primeiro arquivo onde aparece. */
function collect(found: Array<{ rel: string; text: string }>, production: boolean): EnvExampleList {
  const byName = new Map<string, EnvExampleVariable>();
  for (const { rel, text } of found) {
    for (const v of envExampleNames(text)) if (!byName.has(v)) byName.set(v, { name: v, file: rel });
  }
  return { files: found.map((f) => f.rel), variables: [...byName.values()], production };
}

/** Conteúdo do arquivo se ele existe, é arquivo comum, pequeno e fica dentro de `root`. */
async function readInside(root: string, file: string): Promise<string | null> {
  try {
    const real = await realpath(file);
    if (!real.startsWith(root + path.sep)) return null;
    const info = await stat(real);
    if (!info.isFile() || info.size > MAX_EXAMPLE_BYTES) return null;
    return await readFile(real, "utf8");
  } catch {
    return null;
  }
}
