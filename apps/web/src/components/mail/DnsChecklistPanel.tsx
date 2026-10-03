/**
 * Checklist DNS de um domínio de e-mail: registros esperados numa tabela
 * copiável campo a campo (nome, valor; o MX em servidor e prioridade, como o
 * Cloudflare pede; a nota da nuvem cinza no A de mail.<domínio>), o resumo
 * "x/y OK", "Verificar agora" (e uma verificação sozinha ao abrir), o card do
 * PTR, o aviso de certificado pedido pela verificação, o card de e-mail de
 * teste e a evolução do DMARC.
 *
 * Usado na aba Checklist DNS da página do domínio (/mail/:domain) e na aba
 * DNS da seção E-mail do projeto (pedido do dono do produto, 03/10/2026).
 * Carrega os próprios dados a partir de `domain`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  DnsChecklistResponse,
  DnsCheckStatus,
  DnsRecordCheck,
  DnsVerifyResponse,
  PtrCheck,
  PtrCheckStatus,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/mail/CopyButton";
import { TestEmailCard } from "@/components/mail/TestEmailCard";
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, XCircle } from "lucide-react";

/** Um campo do registro DNS (nome, valor, servidor do MX…) com o seu botão de copiar. */
function CopyField({ value, ariaLabel, label }: { value: string; ariaLabel: string; label?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {label && <span className="shrink-0 text-xs text-muted-foreground">{label}</span>}
      <code className="min-w-0 break-all font-mono text-xs">{value}</code>
      <CopyButton text={value} ariaLabel={ariaLabel} />
    </span>
  );
}

/**
 * MX em dois campos, como o Cloudflare pede (Servidor de e-mail e
 * Prioridade). Servidor antigo sem os campos separados: tira do valor
 * "10 mail.exemplo.com.br".
 */
function mxParts(record: DnsRecordCheck): { priority: string; target: string } | null {
  if (record.priority !== undefined && record.target) {
    return { priority: String(record.priority), target: record.target };
  }
  const match = /^(\d+)\s+(\S+)$/.exec(record.expected.trim());
  return match ? { priority: match[1]!, target: match[2]! } : null;
}

/** Valor esperado do registro, pronto para copiar campo a campo. */
function RecordValue({ record, mailHostname }: { record: DnsRecordCheck; mailHostname: string }) {
  const mx = record.type === "MX" ? mxParts(record) : null;
  if (mx) {
    return (
      <div className="flex flex-col gap-0.5">
        <CopyField
          label="Servidor de e-mail:"
          value={mx.target}
          ariaLabel={`Copiar servidor de e-mail de ${record.name}`}
        />
        <CopyField label="Prioridade:" value={mx.priority} ariaLabel={`Copiar prioridade de ${record.name}`} />
        <p className="text-xs text-muted-foreground">
          No Cloudflare, o MX tem dois campos: Servidor de e-mail e Prioridade.
        </p>
      </div>
    );
  }
  const isMailHost = (record.type === "A" || record.type === "AAAA") && record.name === mailHostname;
  return (
    <div className="flex flex-col gap-0.5">
      <CopyField value={record.expected} ariaLabel={`Copiar valor de ${record.name}`} />
      {isMailHost && <p className="text-xs text-amber-400">No Cloudflare: Proxy desligado (nuvem cinza)</p>}
    </div>
  );
}

function StatusIcon({ status }: { status: DnsCheckStatus | PtrCheckStatus }) {
  switch (status) {
    case "found":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "generic":
      return <Info className="h-4 w-4 text-sky-400" />;
    case "missing":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "mismatch":
    case "action_required":
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    case "pending":
      return <span className="inline-block h-4 w-4 rounded-full border border-muted" />;
  }
}

function statusLabel(status: DnsCheckStatus): string {
  switch (status) {
    case "found":
      return "encontrado";
    case "missing":
      return "ausente";
    case "mismatch":
      return "divergente";
    case "action_required":
      return "ação necessária";
    case "pending":
      return "não verificado";
  }
}

/** PTR verde (mail.<domínio>) ou azul (genérico com FCrDNS válido) conta como OK. */
function ptrIsOk(status: PtrCheckStatus): boolean {
  return status === "found" || status === "generic";
}

// ---------------------------------------------------------------------------
// Card do DNS reverso (PTR) — verde, azul ou amarelo
// ---------------------------------------------------------------------------

/** Como trocar o nome reverso: o caminho no painel do provedor ou o texto de chamado. */
function PtrHowTo({ ptr }: { ptr: PtrCheck }) {
  if (ptr.provider) {
    return <p className="text-sm">{ptr.provider.instructions}</p>;
  }
  if (!ptr.ticketText) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Em vários provedores você mesmo troca o nome reverso no painel (procure por "Reverse DNS" ou
        "rDNS"). Na DigitalOcean o nome reverso segue o nome do droplet: renomeie o droplet para{" "}
        <code className="text-xs">{ptr.expected}</code>. Se não achar a opção, abra um chamado no
        provedor da VPS com o texto abaixo:
      </p>
      <pre className="whitespace-pre-wrap rounded-lg border bg-black/40 p-3 font-mono text-xs">
        {ptr.ticketText}
      </pre>
      <div>
        <CopyButton text={ptr.ticketText} label="Copiar texto do chamado" />
      </div>
    </div>
  );
}

function PtrCard({ ptr }: { ptr: PtrCheck }) {
  const current = ptr.found.join(", ");
  return (
    <Card
      className={cn(
        ptr.status === "generic" && "border-sky-500/40",
        ptr.status !== "found" && ptr.status !== "generic" && ptr.status !== "pending" && "border-amber-500/40",
      )}
    >
      <CardHeader className="px-4 pb-2 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <StatusIcon status={ptr.status} /> Reverse DNS (PTR) — {ptr.ip}
        </CardTitle>
        <CardDescription>
          O nome reverso é o "nome" que o IP da VPS informa a quem recebe o e-mail. Ideal:{" "}
          <code className="text-xs">{ptr.expected}</code>. Ele é configurado no provedor da VPS, não
          no DNS do domínio.
          {ptr.status !== "generic" && current && ` Encontrado: ${current}.`}
        </CardDescription>
      </CardHeader>

      {ptr.status === "found" && (
        <CardContent className="px-4 sm:px-6">
          <p className="text-sm text-emerald-400">Tudo certo: o nome reverso do IP é {ptr.expected}.</p>
        </CardContent>
      )}

      {ptr.status === "generic" && (
        <CardContent className="flex flex-col gap-2 px-4 sm:px-6">
          <p className="text-sm text-sky-400">
            Envio liberado. O IP tem o nome reverso <code className="text-xs">{current}</code>, e esse
            nome aponta de volta para o mesmo IP. Essa ida e volta (FCrDNS) é o que os grandes
            provedores conferem: Gmail, Yahoo e Microsoft aceitam suas mensagens.
          </p>
          <p className="text-sm text-muted-foreground">
            Trocar o nome reverso para {ptr.expected} melhora um pouco a entrega, mas é opcional.
          </p>
          {(ptr.provider || ptr.ticketText) && (
            <details className="rounded-lg border px-3 py-2">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Opcional: trocar o nome reverso para {ptr.expected}
                {ptr.provider ? ` (${ptr.provider.name})` : ""}
              </summary>
              <div className="pt-2">
                <PtrHowTo ptr={ptr} />
              </div>
            </details>
          )}
        </CardContent>
      )}

      {ptr.status === "pending" && (
        <CardContent className="px-4 sm:px-6">
          <p className="text-sm text-muted-foreground">
            Não deu para conferir agora: o DNS demorou a responder. Isso não indica problema no envio. Clique em
            "Verificar agora" daqui a pouco.
          </p>
          {ptr.diagnostic && (
            <p className="mt-2 break-words text-xs text-muted-foreground">Detalhe técnico: {ptr.diagnostic}</p>
          )}
        </CardContent>
      )}

      {(ptr.status === "mismatch" || ptr.status === "action_required" || ptr.status === "missing") && (
        <CardContent className="flex flex-col gap-2 px-4 sm:px-6">
          <p className="text-sm text-amber-400">
            {ptr.status === "mismatch"
              ? `O IP tem o nome reverso ${current}, mas esse nome não volta para o IP. `
              : "O IP da VPS não tem nome reverso. "}
            Sem um PTR válido (FCrDNS), o Gmail, o Yahoo e a Microsoft podem recusar suas mensagens.
          </p>
          <PtrHowTo ptr={ptr} />
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Aviso de certificado pedido pela verificação
// ---------------------------------------------------------------------------

/**
 * O registro A de mail.<domínio> ficou certo e o certificado ainda não era
 * válido: a verificação pediu a emissão sozinha.
 */
export function CertificateRetryNotice({ verify }: { verify: DnsVerifyResponse | null }) {
  if (!verify?.certificateRetry) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
      <span className="min-w-0 break-words">
        Certificado de {verify.certificateRetry.host}: emissão pedida — confira em{" "}
        <Link to="/certificates" className="underline underline-offset-2">
          Certificados
        </Link>
        .
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

export function DnsChecklistPanel({
  domain,
  onVerified,
  showCertificateNotice = true,
}: {
  /** Domínio de e-mail cujo checklist o painel mostra. */
  domain: string;
  /** Avisa quem usa o painel a cada verificação (a página mostra o aviso de certificado no topo). */
  onVerified?: (res: DnsVerifyResponse) => void;
  /** false: quem usa o painel mostra o aviso de certificado por conta própria. */
  showCertificateNotice?: boolean;
}) {
  const name = domain;
  const [checklist, setChecklist] = useState<DnsChecklistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [lastVerify, setLastVerify] = useState<DnsVerifyResponse | null>(null);
  const autoVerified = useRef(false);

  const refresh = useCallback(async () => {
    if (!name) return;
    try {
      setChecklist(await apiFetch<DnsChecklistResponse>(`/api/mail/domains/${encodeURIComponent(name)}/dns`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o checklist DNS.");
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function verify() {
    setVerifying(true);
    setError(null);
    try {
      const res = await apiFetch<DnsVerifyResponse>(
        `/api/mail/domains/${encodeURIComponent(name)}/verify`,
        { method: "POST" },
      );
      setLastVerify(res);
      onVerified?.(res);
      setChecklist((prev) =>
        prev ? { ...prev, records: res.records, ptr: res.ptr, suggestion: res.suggestion } : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao verificar o DNS.");
    } finally {
      setVerifying(false);
    }
  }

  // Ao abrir, confere o DNS de verdade: a lista de domínios mostra o resultado
  // da última verificação, e o detalhe não pode dizer "não verificado".
  useEffect(() => {
    if (!checklist || autoVerified.current) return;
    autoVerified.current = true;
    void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklist]);

  if (!checklist) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? "Carregando…"}
      </p>
    );
  }

  const records: DnsRecordCheck[] = checklist.records;
  const ptr: PtrCheck = checklist.ptr;
  const okCount = records.filter((r) => r.status === "found").length + (ptrIsOk(ptr.status) ? 1 : 0);
  const total = records.length + 1;

  return (
    <>
      {showCertificateNotice && <CertificateRetryNotice verify={lastVerify} />}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader className="px-4 pb-2 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Registros DNS esperados</CardTitle>
            <div className="flex items-center gap-2">
              {lastVerify && (
                <Badge variant={okCount === total ? "success" : "warning"}>
                  {okCount}/{total} OK
                </Badge>
              )}
              <Button size="sm" disabled={verifying} onClick={() => void verify()}>
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Verificar agora
              </Button>
            </div>
          </div>
          <CardDescription>
            Copie cada registro para o provedor de DNS do domínio e depois verifique.
            {lastVerify &&
              ` Última verificação: ${new Date(lastVerify.verifiedAt).toLocaleString("pt-BR")}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {/* No celular cada registro vira um bloco empilhado (status e tipo na
              primeira linha; nome e valor embaixo, cada um com o seu botão de
              copiar); a partir de sm, tabela. */}
          <table className="block w-full text-sm sm:table">
            <thead className="hidden sm:table-header-group">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">Nome</th>
                <th className="px-4 py-2 font-medium">Valor esperado</th>
              </tr>
            </thead>
            <tbody className="block sm:table-row-group">
              {records.map((record) => (
                <tr
                  key={record.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 last:border-0 sm:table-row sm:p-0"
                >
                  <td className="order-1 sm:table-cell sm:px-4 sm:py-2 sm:order-none sm:basis-auto">
                    <span className="flex items-center gap-1.5 text-xs">
                      <StatusIcon status={record.status} />
                      {statusLabel(record.status)}
                    </span>
                  </td>
                  <td className="order-2 font-mono text-xs sm:table-cell sm:px-4 sm:py-2 sm:order-none sm:basis-auto">{record.type}</td>
                  <td className="order-4 min-w-0 basis-full sm:table-cell sm:px-4 sm:py-2 sm:order-none sm:basis-auto">
                    <CopyField value={record.name} ariaLabel={`Copiar nome de ${record.name}`} />
                  </td>
                  <td className="order-5 min-w-0 basis-full sm:table-cell sm:px-4 sm:py-2 sm:order-none sm:basis-auto sm:max-w-md">
                    <RecordValue record={record} mailHostname={checklist.mailHostname} />
                    <p className="mt-1 text-xs text-muted-foreground">{record.purpose}</p>
                    {record.note && <p className="text-xs text-amber-400">{record.note}</p>}
                    {record.found.length > 0 && record.status !== "found" && (
                      <p className="break-all text-xs text-muted-foreground">
                        encontrado: {record.found.join(" | ")}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <PtrCard ptr={ptr} />

      <TestEmailCard domain={checklist.domain} />

      {checklist.suggestion && (
        <Card>
          <CardHeader className="px-4 pb-2 sm:px-6">
            <CardTitle className="text-base">Evolução da política (DMARC progressivo)</CardTitle>
          </CardHeader>
          <CardContent className="px-4 text-sm text-muted-foreground sm:px-6">{checklist.suggestion}</CardContent>
        </Card>
      )}
    </>
  );
}
