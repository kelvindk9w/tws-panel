import { readFile, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

/**
 * Carrega o setup token. O ARQUIVO (/data/setup-token) vale mais que a
 * variável SETUP_TOKEN: "Recomeçar do zero" grava um token novo no arquivo, e
 * a variável do contêiner continua com o da instalação — se ela ganhasse, o
 * token antigo voltaria a valer no próximo reinício (achado M3).
 *
 * Com o setup concluído não há token a carregar: ele só serve ao assistente.
 * A variável de ambiente é a da INSTALAÇÃO: com administrador já criado ela
 * nunca revalida (um reset do estado, ou o setup-state.json ausente, não a
 * traz de volta). Quem reabre o assistente tem um token novo no arquivo
 * (scripts/reset-setup.sh e "Recomeçar do zero" gravam um).
 */
export async function loadSetupToken(
  tokenFile: string,
  opts: { setupCompleted?: boolean; hasAdmin?: boolean } = {},
): Promise<string | null> {
  if (opts.setupCompleted) return null;

  try {
    const fromFile = (await readFile(tokenFile, "utf8")).trim();
    if (fromFile) return fromFile;
  } catch {
    // arquivo inexistente ou ilegível — cai para a variável de ambiente
  }
  if (opts.hasAdmin) return null;
  return process.env.SETUP_TOKEN?.trim() || null;
}

/** Apaga o arquivo do setup token (ausente não é erro; outro erro é lançado). */
export async function removeSetupTokenFile(tokenFile: string): Promise<void> {
  try {
    await unlink(tokenFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Comparação em tempo constante para não vazar o token via timing. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
