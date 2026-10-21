import { Link } from "react-router";
import { showsProvisionalNotice } from "@paas/core";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/i18n";

/** O endereço do projeto é o provisório e o painel é público? Então o link não abriria o site. */
export function isProvisionalHere(domain: string): boolean {
  return showsProvisionalNotice(domain, window.location.hostname);
}

/**
 * Aviso âmbar (ícone + texto, não só cor): o projeto ainda tem o endereço provisório
 * (nome-xxxxx.localhost), que só abre no computador de quem acessa. Leva a Domínios.
 */
export function ProvisionalAddressNotice({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="note"
      data-testid="provisional-notice"
      className={`flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-400 ${compact ? "text-xs" : "text-sm"}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p>{t("projects.provisional.notice")}</p>
        <Link to={`/projects/${projectId}/domains`} className="underline underline-offset-2 hover:no-underline">
          {t("projects.provisional.action")}
        </Link>
      </div>
    </div>
  );
}
