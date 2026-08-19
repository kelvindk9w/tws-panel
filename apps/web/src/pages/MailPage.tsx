import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  MailDomainListResponse,
  MailDomainSummary,
  MailServerActionResponse,
  MailServerStatus,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2,
  ChevronRight,
  Globe,
  Loader2,
  Mail,
  MailPlus,
  Play,
  Server,
  Square,
  Trash2,
} from "lucide-react";

function DnsAggregateBadge({ domain }: { domain: MailDomainSummary }) {
  if (!domain.lastVerify) {
    return <Badge variant="secondary">DNS não verificado</Badge>;
  }
  if (domain.lastVerify.ok === domain.lastVerify.total) {
    return (
      <Badge variant="success">
        {domain.lastVerify.ok}/{domain.lastVerify.total} registros OK
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      {domain.lastVerify.ok}/{domain.lastVerify.total} registros OK — pendências
    </Badge>
  );
}

export function MailPage() {
  const [status, setStatus] = useState<MailServerStatus | null>(null);
  const [domains, setDomains] = useState<MailDomainSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [serverStatus, domainList] = await Promise.all([
        apiFetch<MailServerStatus>("/api/mail/status"),
        apiFetch<MailDomainListResponse>("/api/mail/domains"),
      ]);
      setStatus(serverStatus);
      setDomains(domainList.domains);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o módulo de e-mail.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function serverAction(action: "start" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const res = await apiFetch<MailServerActionResponse>(`/api/mail/server/${action}`, {
        method: "POST",
      });
      setStatus(res.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Falha ao ${action === "start" ? "iniciar" : "parar"} o servidor.`);
    } finally {
      setBusy(null);
    }
  }

  async function addDomain() {
    const name = newDomain.trim();
    if (!name) return;
    setBusy("add");
    setError(null);
    try {
      await apiFetch("/api/mail/domains", {
        method: "POST",
        body: JSON.stringify({ domain: name }),
      });
      setNewDomain("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao adicionar o domínio.");
    } finally {
      setBusy(null);
    }
  }

  async function removeDomain(name: string) {
    setBusy(`rm-${name}`);
    setError(null);
    try {
      await apiFetch(`/api/mail/domains/${encodeURIComponent(name)}`, { method: "DELETE" });
      setConfirmRemove(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover o domínio.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Mail className="h-6 w-6" /> E-mail
        </h1>
        <p className="text-sm text-muted-foreground">
          Servidor Stalwart Mail (SMTP + IMAP + DKIM) gerenciado pelo painel.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" /> Servidor de e-mail
            </CardTitle>
            {status &&
              (status.running ? (
                <Badge variant="success">rodando{status.version ? ` · v${status.version}` : ""}</Badge>
              ) : (
                <Badge variant="secondary">parado</Badge>
              ))}
          </div>
          <CardDescription>
            {status
              ? `${status.containerName} · ${status.image} · hostname ${status.hostname}`
              : "carregando…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
          {status && (
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>SMTP: {status.ports.smtp}</span>
              <span>Submission: {status.ports.submission}</span>
              <span>SMTPS: {status.ports.submissions}</span>
              <span>IMAP: {status.ports.imap}</span>
              <span>IMAPS: {status.ports.imaps}</span>
            </div>
          )}
          <div className="flex gap-2">
            {status?.running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void serverAction("stop")}
              >
                {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                Parar
              </Button>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => void serverAction("start")}>
                {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Iniciar servidor
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {domains.length === 0 && status?.running ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">Configure seu primeiro domínio de e-mail</CardTitle>
            <CardDescription>Em 4 passos você tem e-mail profissional no seu próprio servidor:</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">1</span>
                Adicione o domínio abaixo — o painel provisiona no Stalwart e gera a chave DKIM (RSA 2048).
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">2</span>
                Copie os registros DNS do checklist (A, MX, SPF, DKIM, DMARC) para o provedor de DNS do domínio.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">3</span>
                Clique em "Verificar agora" até todos os registros ficarem verdes — o PTR (reverse DNS) é configurado no provedor da VPS.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">4</span>
                Crie caixas de e-mail e conecte no Outlook/Gmail/Thunderbird com as credenciais geradas.
              </li>
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Domínios de e-mail</CardTitle>
          <CardDescription>
            Cada domínio provisiona DKIM próprio e as caixas postmaster@/abuse@ exigidas pelas boas práticas.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Input
              placeholder="exemplo.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addDomain()}
              disabled={!status?.running}
              className="max-w-xs"
            />
            <Button size="sm" disabled={busy !== null || !status?.running || !newDomain.trim()} onClick={() => void addDomain()}>
              {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
              Adicionar domínio
            </Button>
          </div>
          {!status?.running && (
            <p className="text-xs text-muted-foreground">Inicie o servidor de e-mail para adicionar domínios.</p>
          )}

          {domains.length > 0 && (
            <div className="flex flex-col divide-y rounded-lg border">
              {domains.map((domain) => (
                <div key={domain.name} className="flex items-center gap-3 px-4 py-3">
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/mail/${encodeURIComponent(domain.name)}`}
                      className="font-medium hover:underline"
                    >
                      {domain.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {domain.mailboxCount} caixa(s) · DKIM {domain.dkimKeyBits} bits · DMARC p={domain.dmarcStage}
                    </p>
                  </div>
                  <DnsAggregateBadge domain={domain} />
                  {confirmRemove === domain.name ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void removeDomain(domain.name)}
                      >
                        {busy === `rm-${domain.name}` ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => setConfirmRemove(domain.name)}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" asChild>
                    <Link to={`/mail/${encodeURIComponent(domain.name)}`}>
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          )}

          {domains.length > 0 && domains.every((d) => d.lastVerify?.ok === d.lastVerify?.total) && (
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Todos os domínios com DNS verificado.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
