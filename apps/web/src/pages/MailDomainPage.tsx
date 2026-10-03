/**
 * Página de um domínio de e-mail (/mail/:domain): abas Caixas e Checklist
 * DNS. Cada aba é um painel reutilizável (components/mail/MailboxesPanel e
 * DnsChecklistPanel), que também aparece na seção E-mail do projeto.
 *
 * Os dois painéis ficam montados (o inativo escondido): ao abrir, o DNS é
 * conferido de verdade e a aba Caixas mostra a contagem, qualquer que seja a
 * aba aberta.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { DnsChecklistResponse, DnsVerifyResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MailboxesPanel } from "@/components/mail/MailboxesPanel";
import { CertificateRetryNotice, DnsChecklistPanel } from "@/components/mail/DnsChecklistPanel";
import { ArrowLeft, Loader2 } from "lucide-react";

export function MailDomainPage() {
  const { domain } = useParams<{ domain: string }>();
  const name = domain ?? "";

  // só para o cabeçalho (servidor e IP); o painel do DNS carrega o seu
  const [checklist, setChecklist] = useState<DnsChecklistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailboxCount, setMailboxCount] = useState(0);
  const [lastVerify, setLastVerify] = useState<DnsVerifyResponse | null>(null);
  // abre em Caixas (pedido do dono do produto, 02/10/2026); ?aba=dns abre no
  // checklist (link do e-mail do projeto, logo depois de cadastrar o domínio)
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<"dns" | "mailboxes">(searchParams.get("aba") === "dns" ? "dns" : "mailboxes");

  const refresh = useCallback(async () => {
    if (!name) return;
    try {
      setChecklist(await apiFetch<DnsChecklistResponse>(`/api/mail/domains/${encodeURIComponent(name)}/dns`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o domínio.");
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!checklist) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? "Carregando…"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/mail">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{checklist.domain}</h1>
          <p className="text-sm text-muted-foreground">
            Servidor: {checklist.mailHostname} · IP {checklist.serverIp}
          </p>
        </div>
      </div>

      <CertificateRetryNotice verify={lastVerify} />

      <div className="flex gap-1 border-b">
        {(
          [
            ["mailboxes", `Caixas (${mailboxCount})`],
            ["dns", "Checklist DNS"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "border-b-2 px-4 py-2 text-sm transition-colors",
              tab === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div hidden={tab !== "dns"} className={tab === "dns" ? "flex flex-col gap-6" : "hidden"}>
        <DnsChecklistPanel domain={name} onVerified={setLastVerify} showCertificateNotice={false} />
      </div>

      <div hidden={tab !== "mailboxes"} className={tab === "mailboxes" ? "flex flex-col gap-6" : "hidden"}>
        <MailboxesPanel domain={name} onMailboxesChange={(boxes) => setMailboxCount(boxes.length)} />
      </div>
    </div>
  );
}
