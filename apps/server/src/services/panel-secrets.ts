/**
 * panel-secrets.ts — todo segredo que o PAINEL guarda (fora os dos projetos), para a página "Logs do servidor"
 * mascarar nas linhas dos logs do painel, do proxy, do e-mail, do Docker e do SSH.
 *
 * Duas famílias:
 *  - arquivos de chave da pasta de dados (session-secret, credentials-key, two-factor-key, project-env-key,
 *    notifications-key, backups-key): o texto hexadecimal do arquivo é o próprio segredo;
 *  - segredos cifrados que o painel sabe abrir: token da Cloudflare, token do GitHub, senha e chave S3 dos backups,
 *    token do Telegram, setup token e a credencial derivada que o /mcp aceita na instalação.
 *
 * FALHA FECHADA: qualquer fonte que dê erro (exceto "arquivo de chave ainda não existe") faz a coleta lançar, e a
 * página de logs responde 503 em vez de mostrar linhas que poderiam ter um segredo sem máscara.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deriveMcpSetupCredential } from "./setup-token.js";

export const KEY_FILES = ["session-secret", "credentials-key", "two-factor-key", "project-env-key", "notifications-key", "backups-key"] as const;

export interface PanelSecretSources {
  dataDir: string;
  /** Setup token em memória (vazio depois da instalação). */
  setupToken?: string | null;
  /** Fontes de segredos cifrados; cada uma devolve a lista (vazia se não há). Se lançar, a coleta lança. */
  providers: Array<() => Promise<readonly string[]>>;
}

async function keyFileText(dataDir: string, name: string): Promise<string[]> {
  try {
    const text = (await readFile(path.join(dataDir, name), "utf8")).trim();
    return text ? [text] : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function collectPanelSecrets(src: PanelSecretSources): Promise<string[]> {
  const parts = await Promise.all([
    ...KEY_FILES.map((name) => keyFileText(src.dataDir, name)),
    ...src.providers.map(async (p) => [...(await p())]),
  ]);
  const out = parts.flat();
  if (src.setupToken) out.push(src.setupToken, deriveMcpSetupCredential(src.setupToken));
  return out.filter((v) => v.length > 0);
}
