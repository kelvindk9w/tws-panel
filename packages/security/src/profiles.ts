/**
 * profiles.ts — perfil do alvo do scan: "host" (VPS real) vs "container"
 * (alvo descartável de dev/teste).
 *
 * Motivo honesto: rodar checks de host (ufw, sshd, fail2ban, snapd,
 * unattended-upgrades…) dentro de um container gera FALSOS-POSITIVOS DE
 * CONTEXTO — o check avalia o namespace do container, não a máquina real.
 * No perfil "container" esses checks são PULADOS e documentados no relatório
 * (skippedChecks) em vez de poluírem o resultado.
 */
import type { SecuritySkippedCheck, SecurityTargetProfile } from "@paas/core";
import type { CheckDefinition } from "./checks.js";

/** Motivo padrão (pt-BR) exibido no relatório para checks pulados. */
export const CONTAINER_SKIP_REASON =
  "check aplicável apenas ao host (VPS real) — em container seria falso-positivo de contexto";

export interface ProfilePartition {
  run: CheckDefinition[];
  skipped: SecuritySkippedCheck[];
}

/**
 * Separa os checks que rodam no perfil do alvo dos que são pulados.
 * Perfil "host": tudo roda. Perfil "container": checks `hostOnly` são pulados.
 */
export function partitionChecksForProfile(
  checks: readonly CheckDefinition[],
  profile: SecurityTargetProfile,
): ProfilePartition {
  if (profile === "host") return { run: [...checks], skipped: [] };
  const run: CheckDefinition[] = [];
  const skipped: SecuritySkippedCheck[] = [];
  for (const def of checks) {
    if (def.hostOnly) {
      skipped.push({ id: def.id, title: def.title, reason: CONTAINER_SKIP_REASON });
    } else {
      run.push(def);
    }
  }
  return { run, skipped };
}

/** Nota de contexto do perfil exibida no relatório do scan. */
export function profileNote(profile: SecurityTargetProfile): string | null {
  return profile === "container"
    ? "Perfil container (dev/teste): checks de host (ufw, sshd, fail2ban, snapd, unattended-upgrades etc.) foram pulados — nesse contexto seriam falsos-positivos. Para o resultado real da VPS, use PAAS_TARGET=host (host bridge)."
    : null;
}
