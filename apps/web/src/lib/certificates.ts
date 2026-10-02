/**
 * certificates.ts — rótulos da página Certificados, compartilhados com o
 * resumo no card do e-mail e nos domínios do projeto.
 */
import type { CertificateItem, CertificateState } from "@paas/core";

export const STATE_LABELS: Record<CertificateState, string> = {
  valid: "Válido",
  issuing: "Emitindo",
  failed: "Falhou",
  expiring: "Vence em breve",
  expired: "Vencido",
  unknown: "Não conferido",
};

export function stateVariant(state: CertificateState): "success" | "warning" | "destructive" | "secondary" {
  if (state === "valid") return "success";
  if (state === "issuing" || state === "expiring") return "warning";
  if (state === "failed" || state === "expired") return "destructive";
  return "secondary";
}

export function ownerLabel(item: CertificateItem): string {
  if (item.owner.kind === "panel") return "Painel";
  if (item.owner.kind === "mail") return "E-mail";
  return `Projeto ${item.owner.projectName ?? ""}`.trim();
}

export function modeLabel(item: CertificateItem): string {
  return item.mode === "manual" ? "Manual" : "Automático";
}

/** Data em pt-BR (UTC, como o Caddy e o Let's Encrypt contam a validade). */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}
