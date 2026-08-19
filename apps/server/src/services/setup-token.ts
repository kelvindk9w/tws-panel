import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

/**
 * Carrega o setup token: variável de ambiente SETUP_TOKEN tem prioridade;
 * fallback para o arquivo gerado pelo install.sh (/etc/paas/setup-token).
 */
export async function loadSetupToken(tokenFile: string): Promise<string | null> {
  const fromEnv = process.env.SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  try {
    const fromFile = (await readFile(tokenFile, "utf8")).trim();
    if (fromFile) return fromFile;
  } catch {
    // arquivo inexistente ou ilegível — tratado pelo chamador
  }
  return null;
}

/** Comparação em tempo constante para não vazar o token via timing. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
