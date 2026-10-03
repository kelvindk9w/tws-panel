/**
 * env-example.ts — nomes das variáveis que o repositório documenta num
 * arquivo de exemplo (`.env.example`, `.env.sample`, `.env.dist`,
 * `.env.template`).
 *
 * Validação real (cassino, 03/10/2026): o app lê SMTP_USUARIO e SMTP_SENHA
 * por `env_file: .env`, sem `${...}` no compose; só o `.env.example` as cita.
 * A tela usa estes nomes como sugestões (ex.: "Ligar às variáveis do
 * projeto"). Só os NOMES saem daqui — o valor de exemplo pode ser um
 * segredo esquecido no repositório.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { EnvExampleVariable } from "@paas/core";

export type { EnvExampleVariable };

/** Arquivos de exemplo procurados, nesta ordem. */
export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.dist", ".env.template"] as const;

/** Um arquivo de exemplo de verdade tem poucos KB. */
const MAX_EXAMPLE_BYTES = 256 * 1024;

/**
 * Nomes citados no texto, sem repetir, na ordem em que aparecem. Vale
 * `NOME=`, `export NOME=` e a linha comentada `# NOME=` (variável opcional
 * documentada); o resto (comentário comum, linha inválida) é ignorado.
 */
export function envExampleNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Lê os arquivos de exemplo de cada pasta (relativa a `srcDir`; "" = raiz),
 * ignorando pasta repetida, caminho ou link que sai do código e arquivo
 * grande demais. Cada nome fica com o primeiro arquivo onde aparece.
 * `null` quando não há nenhum arquivo de exemplo.
 */
export async function readEnvExamples(
  srcDir: string,
  dirs: string[],
): Promise<{ files: string[]; variables: EnvExampleVariable[] } | null> {
  const root = await realpath(srcDir);
  const files: string[] = [];
  const byName = new Map<string, EnvExampleVariable>();
  for (const dir of [...new Set(dirs)]) {
    for (const name of ENV_EXAMPLE_FILES) {
      const rel = path.posix.join(dir.split(path.sep).join("/"), name);
      const text = await readInside(root, path.join(root, rel));
      if (text === null) continue;
      files.push(rel);
      for (const v of envExampleNames(text)) if (!byName.has(v)) byName.set(v, { name: v, file: rel });
    }
  }
  return files.length === 0 ? null : { files, variables: [...byName.values()] };
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
