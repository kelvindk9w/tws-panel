/**
 * project-dotenv.ts — as Variáveis do projeto viram o `.env` do compose.
 *
 * O compose lê o `.env` da pasta do projeto para interpolar `${VAR}` e para
 * `env_file: .env` (validação real: o compose do cassino exige dezenas de
 * `${VAR:?…}`). O arquivo é gravado com 0600 e entra no `.git/info/exclude`
 * (nunca aparece como mudança do repositório). Se o repositório VERSIONA um
 * `.env`, ele não é sobrescrito: as variáveis vão para um arquivo à parte,
 * passado com `--env-file` (vale para a interpolação).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ComposeVariable } from "@paas/core";
import { GIT_DIR_NAME, GIT_SAFE_CONFIG, gitLocation, gitSafeEnv } from "./git-safe.js";
import { appendNoFollow, isRealDirectory, isRegularFile, writeFileNoFollow } from "./safe-fs.js";

export type { ComposeVariable };

const execFileAsync = promisify(execFile);

/**
 * Uma linha KEY=valor no formato do `.env` do compose. Aspas simples = texto
 * literal (sem interpolação de `$`); com aspas simples ou quebra de linha no
 * valor, aspas duplas com escape e `$` dobrado (`$$`).
 */
export function dotenvLine(key: string, value: string): string {
  if (!value.includes("'") && !value.includes("\n") && !value.includes("\r")) return `${key}='${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "$$$$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `${key}="${escaped}"`;
}

/**
 * Onde está o repositório git do projeto: o do painel (modo git, fora de
 * `src`) ou, nos demais modos, o `.git` da própria pasta. Em qualquer caso o
 * git roda sem hooks nem fsmonitor (git-safe.ts).
 */
function gitDirDoPainel(workDir: string): string | null {
  const dir = path.join(workDir, GIT_DIR_NAME);
  return existsSync(path.join(dir, "HEAD")) ? dir : null;
}

async function isTracked(src: string, workDir: string, file: string): Promise<boolean> {
  const where = gitDirDoPainel(workDir) ? gitLocation(workDir, src) : ["-C", src];
  try {
    await execFileAsync("git", [...GIT_SAFE_CONFIG, ...where, "ls-files", "--error-unmatch", file], {
      env: gitSafeEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Põe `/.env` no exclude do repositório, sem seguir link simbólico plantado em `src`. */
async function excludeFromGit(src: string, workDir: string): Promise<void> {
  let infoDir: string;
  const dirDoPainel = gitDirDoPainel(workDir);
  if (dirDoPainel) {
    infoDir = path.join(dirDoPainel, "info");
  } else {
    // repositório da própria pasta (modo existing): `src/.git` e `info` precisam ser pastas de verdade
    const gitDir = path.join(src, ".git");
    infoDir = path.join(gitDir, "info");
    if (!(await isRealDirectory(gitDir))) return;
    if (existsSync(infoDir) && !(await isRealDirectory(infoDir))) return;
  }
  await mkdir(infoDir, { recursive: true });
  const exclude = path.join(infoDir, "exclude");
  const existe = existsSync(exclude);
  if (existe && !(await isRegularFile(exclude))) return;
  const current = existe ? await readFile(exclude, "utf8") : "";
  if (!/^\/\.env$/m.test(current)) {
    await appendNoFollow(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.env\n`);
  }
}

/** Primeira linha de todo `.env` que o painel grava: é por ela que ele reconhece o que é seu. */
const GENERATED_HEADER = "# Gerado pelo painel (seção Variáveis do projeto) — não editar aqui: edite no painel.";

/** Apaga o `.env` da pasta do projeto só se foi o painel que o gerou (o do dono fica). */
async function removeGeneratedDotenv(src: string): Promise<void> {
  const file = path.join(src, ".env");
  // link simbólico (ou outra coisa que não um arquivo) não é do painel: fica
  if (!(await isRegularFile(file))) return;
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch {
    return; // não existe
  }
  if (current.startsWith(GENERATED_HEADER)) await rm(file, { force: true });
}

/**
 * Grava as variáveis para o compose. Devolve argumentos extras do `docker compose`.
 *
 * Sem variáveis, o estado vazio também é gravado: o `.env` gerado pelo painel
 * e o `paas.env` do workDir são apagados — o clone fica entre deploys, e um
 * arquivo velho faria o container subir com o valor que o dono acabou de
 * excluir (achado 9 da revisão).
 */
export async function writeProjectDotenv(
  src: string,
  workDir: string,
  vars: Record<string, string>,
): Promise<{ envFileArgs: string[]; note: string | null }> {
  const keys = Object.keys(vars);
  const separate = path.join(workDir, "paas.env");
  if (keys.length === 0) {
    await rm(separate, { force: true });
    if (!(await isTracked(src, workDir, ".env"))) await removeGeneratedDotenv(src);
    return { envFileArgs: [], note: null };
  }
  const content =
    GENERATED_HEADER +
    "\n" +
    keys.map((k) => dotenvLine(k, vars[k]!)).join("\n") +
    "\n";

  if (await isTracked(src, workDir, ".env")) {
    await mkdir(workDir, { recursive: true });
    await writeFile(separate, content, { encoding: "utf8", mode: 0o600 });
    await chmod(separate, 0o600);
    return {
      envFileArgs: ["--env-file", separate],
      note:
        "O repositório tem um .env versionado: ele não foi sobrescrito. As variáveis do painel valem para os ${VAR} do " +
        "compose (--env-file); um `env_file: .env` continua lendo o arquivo do repositório.",
    };
  }
  // o .env deixou de ser versionado: o paas.env antigo não pode continuar valendo
  await rm(separate, { force: true });
  const file = path.join(src, ".env");
  // sem seguir link: um `.env` que aponte para fora de `src` é trocado, nunca atravessado
  await writeFileNoFollow(file, content, 0o600);
  await excludeFromGit(src, workDir);
  return { envFileArgs: [], note: null };
}

/**
 * Lê `${NOME…}` com chaves aninhadas: no padrão de outra variável
 * (`${A:-${B:?…}}`) a obrigatória de dentro só vale com a de fora vazia.
 */
function scanVariables(text: string, found: Map<string, ComposeVariable>, outer: string[]): void {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("${", i);
    if (start === -1) return;
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?/.exec(text.slice(start));
    if (!m) {
      i = start + 2;
      continue;
    }
    // acha o "}" que fecha esta variável (contando as aninhadas)
    let depth = 1;
    let j = start + m[0].length;
    while (j < text.length && depth > 0) {
      if (text.startsWith("${", j)) {
        depth++;
        j += 2;
        continue;
      }
      if (text[j] === "}") depth--;
      j++;
    }
    const name = m[1]!;
    const op = m[2];
    const arg = op ? text.slice(start + m[0].length, j - 1) : null;
    const required = Boolean(op?.includes("?"));
    const prev = found.get(name);
    const next: ComposeVariable = {
      name,
      required: required || (prev?.required ?? false),
      defaultValue: op?.includes("-") ? (arg ?? "") : (prev?.defaultValue ?? null),
    };
    // alternativa só enquanto TODA ocorrência obrigatória estiver aninhada
    const alternatives =
      required && outer.length > 0
        ? prev && prev.required && !prev.alternatives
          ? undefined
          : [...new Set([...(prev?.alternatives ?? []), ...outer])]
        : required
          ? undefined
          : prev?.alternatives;
    if (alternatives && alternatives.length > 0) next.alternatives = alternatives;
    found.set(name, next);
    // padrão (`:-`) pode trazer outras variáveis, valendo só com esta vazia
    if (op?.includes("-") && arg) scanVariables(arg, found, [...outer, name]);
    i = j;
  }
}

/** Variáveis que o compose interpola (`${VAR}`, `$VAR`) e se ele usa `env_file: .env`. */
export function composeVariables(content: string): { variables: ComposeVariable[]; usesEnvFile: boolean } {
  const found = new Map<string, ComposeVariable>();
  // $$ é "$" literal no compose: tira antes de procurar
  const text = content.replace(/\$\$/g, "");
  scanVariables(text, found, []);
  for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!found.has(m[1]!)) found.set(m[1]!, { name: m[1]!, required: false, defaultValue: null });
  }
  const usesEnvFile = /env_file:\s*(?:\n\s*-\s*)?['"]?\.env['"]?/m.test(content);
  return { variables: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), usesEnvFile };
}

/** Nomes das variáveis que o `docker compose` disse faltar ("required variable X is missing a value"). */
export function missingFromComposeOutput(output: string): string[] {
  return [...new Set([...output.matchAll(/required variable ([A-Za-z_][A-Za-z0-9_]*) is missing a value/g)].map((m) => m[1]!))];
}
