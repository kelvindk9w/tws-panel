import { useCallback, useEffect, useState } from "react";
import { Link, useInRouterContext } from "react-router";
import type { CertificateItem, CertificateListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { formatDay, modeLabel, STATE_LABELS, stateVariant } from "@/lib/certificates";
import { certificatePending, useAutoRefresh } from "@/lib/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ShieldCheck } from "lucide-react";

/**
 * Resumo dos certificados de um grupo de nomes (o e-mail, os domínios de um
 * projeto), com o link para a página Certificados — onde ficam as ações.
 * Usa o mesmo endpoint da página. Falha ao carregar não quebra o card que o
 * contém: fica só o link.
 *
 * `query`: filtro do GET /api/certificates (ex.: "kind=mail", "project=<id>").
 * Enquanto algum nome estiver sem certificado válido (emitindo, falhou), o
 * resumo consulta sozinho até ele ficar válido (lib/auto-refresh.ts).
 */
export function CertificateSummary({ query }: { query: string }) {
  const [items, setItems] = useState<CertificateItem[] | null>(null);
  // Fora de um roteador (card renderizado sozinho), um link comum.
  const inRouter = useInRouterContext();
  const linkClass = "inline-flex items-center gap-1 self-start text-xs text-sky-400 hover:underline";

  useEffect(() => {
    let cancelled = false;
    // Promise.resolve: um apiFetch dublê que não devolve promessa não derruba o card.
    Promise.resolve()
      .then(() => apiFetch<CertificateListResponse>(`/api/certificates?${query}`))
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Consulta automática em silêncio: uma falha mantém o que já está na tela.
  const quietLoad = useCallback(async () => {
    const r = await apiFetch<CertificateListResponse>(`/api/certificates?${query}`).catch(() => null);
    if (r) setItems(r.items);
  }, [query]);
  useAutoRefresh(items?.some(certificatePending) ?? false, quietLoad);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed px-4 py-3" data-testid="certificate-summary">
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4" /> Certificados HTTPS
      </p>
      {items === null && <p className="text-xs text-muted-foreground">conferindo…</p>}
      {items?.map((i) => (
        <div key={i.host} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="break-all font-mono">{i.host}</span>
          <Badge variant={stateVariant(i.state)}>{STATE_LABELS[i.state]}</Badge>
          <span className="text-muted-foreground">
            {modeLabel(i)}
            {i.validTo ? ` · até ${formatDay(i.validTo)}` : ""}
          </span>
        </div>
      ))}
      {inRouter ? (
        <Link to="/certificates" className={linkClass}>
          Ver em Certificados <ChevronRight className="h-3 w-3" />
        </Link>
      ) : (
        <a href="/certificates" className={linkClass}>
          Ver em Certificados <ChevronRight className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
