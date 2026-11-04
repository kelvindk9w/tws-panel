import { useEffect, useState } from "react";
import { Link } from "react-router";
import { isProvisionalDomain, showsProvisionalNotice, type AutoDomainSuggestion } from "@paas/core";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/i18n";

let panelPublicCache: Promise<boolean> | null = null;

/** Só para testes: esquece a resposta guardada do servidor. */
export function resetPanelPublicCache() {
  panelPublicCache = null;
}

/** O servidor informa se o painel é público (uma consulta só, compartilhada por todos os cartões). */
function fetchPanelPublic(): Promise<boolean> {
  panelPublicCache ??= apiFetch<AutoDomainSuggestion>("/api/domains/suggest?name=x")
    .then((r) => r.panelPublic === true)
    .catch(() => {
      panelPublicCache = null; // falha de rede não fica guardada: a próxima consulta tenta de novo
      return false;
    });
  return panelPublicCache;
}

/** O servidor diz que o painel é público? `enabled` evita a consulta quando nenhum endereço é provisório. */
export function usePanelPublic(enabled: boolean): boolean {
  const [panelPublic, setPanelPublic] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchPanelPublic().then((v) => !cancelled && setPanelPublic(v));
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return panelPublic;
}

/**
 * O endereço é o provisório (nome-xxxxx.localhost) E o servidor diz que o painel é público?
 * Então o link não abriria o site. A decisão vem do servidor: pelo túnel SSH o navegador
 * está em localhost, mas o painel (e o projeto) estão na VPS.
 */
export function useProvisionalHere(domain: string): boolean {
  return showsProvisionalNotice(domain, usePanelPublic(isProvisionalDomain(domain)));
}

/**
 * Aviso âmbar (ícone + texto, não só cor): o projeto ainda tem o endereço provisório
 * (nome-xxxxx.localhost), que só abre no computador de quem acessa. Fora da tela de
 * Domínios leva até lá; dentro dela (`inDomains`) o botão logo abaixo faz a troca.
 */
export function ProvisionalAddressNotice({ projectId, compact = false, inDomains = false }: { projectId: string; compact?: boolean; inDomains?: boolean }) {
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
        {!inDomains && (
          <Link to={`/projects/${projectId}/domains`} className="underline underline-offset-2 hover:no-underline">
            {t("projects.provisional.action")}
          </Link>
        )}
      </div>
    </div>
  );
}
