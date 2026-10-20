/**
 * certificates.ts — rótulos da página Certificados, compartilhados com o
 * resumo no card do e-mail e nos domínios do projeto.
 */
import type { CertificateItem, CertificateState } from "@paas/core";
import { formatDate, t, type Key } from "@/i18n";

/** Chaves dos rótulos de estado (o texto sai por `t(...)` na renderização). */
export const STATE_KEYS: Record<CertificateState, Key> = {
  valid: "certificates.state.valid",
  issuing: "certificates.state.issuing",
  failed: "certificates.state.failed",
  expiring: "certificates.state.expiring",
  expired: "certificates.state.expired",
  unknown: "certificates.state.unknown",
};

export function stateVariant(state: CertificateState): "success" | "warning" | "destructive" | "secondary" {
  if (state === "valid") return "success";
  if (state === "issuing" || state === "expiring") return "warning";
  if (state === "failed" || state === "expired") return "destructive";
  return "secondary";
}

export function ownerLabel(item: CertificateItem): string {
  if (item.owner.kind === "panel") return t("certificates.owner.panel");
  if (item.owner.kind === "mail") return t("certificates.owner.mail");
  return t("certificates.owner.project", { name: item.owner.projectName ?? "" }).trim();
}

export function modeLabel(item: CertificateItem): string {
  return item.mode === "manual" ? t("certificates.mode.manual") : t("certificates.mode.automatic");
}

/** Data no idioma da interface (UTC, como o Caddy e o Let's Encrypt contam a validade). */
export function formatDay(iso: string): string {
  return formatDate(iso, { timeZone: "UTC" });
}
