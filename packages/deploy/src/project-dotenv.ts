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
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

async function isTracked(src: string, file: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", src, "ls-files", "--error-unmatch", file]);
    return true;
  } catch {
    return false;
  }
}

async function excludeFromGit(src: string): Promise<void> {
  const infoDir = path.join(src, ".git", "info");
  if (!existsSync(path.join(src, ".git"))) return;
  await mkdir(infoDir, { recursive: true });
  const exclude = path.join(infoDir, "exclude");
  const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (!/^\/\.env$/m.test(current)) {
    await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.env\n`);
  }
}

/** Grava as variáveis para o compose. Devolve argumentos extras do `docker compose`. */
export async function writeProjectDotenv(
  src: string,
  workDir: string,
  vars: Record<string, string>,
): Promise<{ envFileArgs: string[]; note: string | null }> {
  const keys = Object.keys(vars);
  if (keys.length === 0) return { envFileArgs: [], note: null };
  const content =
    "# Gerado pelo painel (seção Variáveis do projeto) — não editar aqui: edite no painel.\n" +
    keys.map((k) => dotenvLine(k, vars[k]!)).join("\n") +
    "\n";

  if (await isTracked(src, ".env")) {
    const file = path.join(workDir, "paas.env");
    await mkdir(workDir, { recursive: true });
    await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return {
      envFileArgs: ["--env-file", file],
      note:
        "O repositório tem um .env versionado: ele não foi sobrescrito. As variáveis do painel valem para os ${VAR} do " +
        "compose (--env-file); um `env_file: .env` continua lendo o arquivo do repositório.",
    };
  }
  const file = path.join(src, ".env");
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  await excludeFromGit(src);
  return { envFileArgs: [], note: null };
}

export interface ComposeVariable {
  name: string;
  /** `${VAR:?…}` / `${VAR?…}`: o compose recusa subir sem ela. */
  required: boolean;
  /** `${VAR:-padrão}` / `${VAR-padrão}`. */
  defaultValue: string | null;
}

/** Variáveis que o compose interpola (`${VAR}`, `$VAR`) e se ele usa `env_file: .env`. */
export function composeVariables(content: string): { variables: ComposeVariable[]; usesEnvFile: boolean } {
  const found = new Map<string, ComposeVariable>();
  // $$ é "$" literal no compose: tira antes de procurar
  const text = content.replace(/\$\$/g, "");
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}/g)) {
    const [, name, op, arg] = m;
    const prev = found.get(name!);
    const required = Boolean(op?.includes("?")) || (prev?.required ?? false);
    const defaultValue = op?.includes("-") ? (arg ?? "") : (prev?.defaultValue ?? null);
    found.set(name!, { name: name!, required, defaultValue });
  }
  for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!found.has(m[1]!)) found.set(m[1]!, { name: m[1]!, required: false, defaultValue: null });
  }
  const usesEnvFile = /env_file:\s*(?:\n\s*-\s*)?['"]?\.env['"]?/m.test(content);
  return { variables: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), usesEnvFile };
}
