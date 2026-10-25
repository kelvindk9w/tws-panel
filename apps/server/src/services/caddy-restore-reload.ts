/**
 * caddy-restore-reload.ts — recarrega o Caddy depois que a restauração
 * devolveu os certificados dele.
 *
 * O Caddy (certmagic) só lê o armazenamento ao carregar a configuração.
 * Depois de restaurar `paas_caddy_data` (backup-service.ts → restoreCaddy, ou
 * scripts/restaurar-painel.sh), um marcador em data/backups pede um
 * recarregamento FORÇADO assim que o painel sobe: o Caddy relê o
 * armazenamento, usa os certificados que ainda valem e renova/reemite os que
 * venceram. O marcador só some depois de o recarregamento dar certo (se o
 * proxy ainda não subiu, a tentativa seguinte repete).
 */
import { rm, stat } from "node:fs/promises";
import path from "node:path";

export const CADDY_RELOAD_MARKER_FILE = ".caddy-reload-pending";

export interface CaddyReloadOptions {
  /** Pasta data/backups. */
  backupsDir: string;
  /** Recarrega o proxy central com --force. */
  reload: () => Promise<void>;
  log?: (message: string) => void;
}

/** Há recarregamento pendente? */
export async function caddyReloadPending(backupsDir: string): Promise<boolean> {
  return stat(path.join(backupsDir, CADDY_RELOAD_MARKER_FILE)).then(
    () => true,
    () => false,
  );
}

/**
 * Faz o recarregamento pendente, se houver. Devolve true quando recarregou e
 * apagou o marcador, false quando não havia nada ou a tentativa falhou (o
 * marcador fica para a próxima).
 */
export async function consumeCaddyReload(opts: CaddyReloadOptions): Promise<boolean> {
  if (!(await caddyReloadPending(opts.backupsDir))) return false;
  try {
    await opts.reload();
  } catch (err) {
    opts.log?.(
      `Caddy: o recarregamento depois da restauração dos certificados falhou (${err instanceof Error ? err.message : String(err)}); tento de novo mais tarde.`,
    );
    return false;
  }
  await rm(path.join(opts.backupsDir, CADDY_RELOAD_MARKER_FILE), { force: true });
  return true;
}
