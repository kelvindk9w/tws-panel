/**
 * planner.ts — gera o plano de correção a partir de um relatório de scan.
 * Uma ação por fase de hardening, ordenada na ordem segura da spec (§4):
 * atualizar → usuário → SSH → firewall → intrusão → minimização → auditoria.
 */
import { randomUUID } from "node:crypto";
import {
  RISKY_PHASES,
  SECURITY_PHASES,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityPlanAction,
  type SecurityScanReport,
} from "@paas/core";
import { SECURITY_CHECKS } from "./checks.js";

const PHASE_DESCRIPTIONS: Record<SecurityPhaseId, string> = {
  "00": "apt full-upgrade, instala e ativa unattended-upgrades (security updates automáticos).",
  "01": "cria usuário não-root com sudo, instala chave SSH e trava a senha do root (somente após chave presente).",
  "02": "drop-in de hardening do sshd (somente chave, root bloqueado, crypto moderna) com validação e rollback agendado.",
  "03": "UFW default-deny liberando SSH/80/443 (+e-mail com profile mail) e hardening de kernel via sysctl.",
  "04": "fail2ban com jails (sshd, nginx, recidive; e-mail com profile mail) e AppArmor em enforce.",
  "05": "remove snapd, serviços e clientes legados desnecessários; impede reinstalação de Recommends.",
  "06": "auditd com regras essenciais, baseline AIDE, rkhunter/chkrootkit, Lynis e cron de varreduras recorrentes.",
};

const PHASE_IMPACTS: Partial<Record<SecurityPhaseId, string>> = {
  "01": "Trava a senha do root após instalar sua chave SSH no novo usuário. Teste o login em outra janela antes de confirmar — rollback automático em 5 min.",
  "02": "Pode afetar seu acesso SSH: senha e root são desabilitados. Rollback automático em 5 min se você não confirmar.",
  "03": "Pode afetar sua conectividade: firewall default-deny é ativado. Rollback automático em 5 min se você não confirmar.",
};

export function buildSecurityPlan(report: SecurityScanReport): SecurityPlan {
  const failingByPhase = new Map<SecurityPhaseId, string[]>();
  const allByPhase = new Map<SecurityPhaseId, string[]>();

  for (const check of report.checks) {
    const def = SECURITY_CHECKS.find((d) => d.id === check.id);
    if (!def?.fixable) continue;
    const list = allByPhase.get(check.phase) ?? [];
    list.push(check.id);
    allByPhase.set(check.phase, list);
    if (check.status === "fail") {
      const failing = failingByPhase.get(check.phase) ?? [];
      failing.push(check.id);
      failingByPhase.set(check.phase, failing);
    }
  }

  const actions: SecurityPlanAction[] = SECURITY_PHASES.map((phase) => {
    const fixes = failingByPhase.get(phase.id) ?? [];
    const phaseChecks = allByPhase.get(phase.id) ?? [];
    const hasCriticalFail = fixes.some((id) => {
      const check = report.checks.find((c) => c.id === id);
      return check?.severity === "critical";
    });
    return {
      id: `apply-${phase.id}-${phase.key}`,
      phase: phase.id,
      phaseKey: phase.key,
      title: phase.title,
      script: phase.script,
      description: PHASE_DESCRIPTIONS[phase.id],
      fixesCheckIds: fixes,
      // Fases 02/03 SEMPRE exigem confirmação. A fase 01 exige em runtime
      // (executor.ts) somente quando o operador fornece uma chave SSH — mas
      // o plano não sabe disso de antemão (é gerado a partir do scan, não do
      // apply). Marcar aqui como true evita que o plano prometa um fluxo
      // sem confirmação e o operador seja surpreendido pelo awaiting_confirmation
      // que o executor pode disparar de qualquer forma.
      requiresConfirmation: RISKY_PHASES.includes(phase.id) || phase.id === "01",
      hasRollback: true,
      impact: PHASE_IMPACTS[phase.id] ?? null,
      preselected: hasCriticalFail,
      alreadySatisfied: phaseChecks.length > 0 && fixes.length === 0,
    };
  });

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    basedOnScanId: report.id,
    hardeningIndex: report.hardeningIndex,
    actions,
  };
}
