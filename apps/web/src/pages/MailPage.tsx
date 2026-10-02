import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  ExistingMailInfo,
  MailDomainListResponse,
  MailDomainSummary,
  MailServerActionResponse,
  MailServerStatus,
  MailTlsStatusResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CertificateSummary } from "@/components/certificates/CertificateSummary";
import { ExistingMailWarning } from "@/components/mail/ExistingMailWarning";
import {
  CheckCircle2,
  ChevronRight,
  Globe,
  Loader2,
  Lock,
  Mail,
  MailPlus,
  Play,
  RefreshCw,
  Server,
  Square,
  Trash2,
} from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

/**
 * Certificado do servidor de e-mail (mail.<domínio>). Validação real
 * (01/10/2026): com o autoassinado, o app do projeto (nodemailer com
 * verificação padrão) recusaria a conexão. O painel instala o certificado
 * que o proxy emite; aqui o operador vê se já vale ou o que falta.
 */
function MailTlsCard({ tls, busy, onRecheck }: { tls: MailTlsStatusResponse | null; busy: boolean; onRecheck: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" /> Certificado do servidor de e-mail
          </CardTitle>
          <Button variant="outline" size="sm" disabled={busy} onClick={onRecheck}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Conferir de novo
          </Button>
        </div>
        <CardDescription>
          Os projetos enviam e-mail por mail.&lt;domínio&gt;, porta 587. Apps que conferem o certificado (o padrão
          do nodemailer, por exemplo) só conectam com ele válido. O painel emite e renova sozinho.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!tls && <p className="text-sm text-muted-foreground">conferindo…</p>}
        {tls?.syncError && (
          <p className="text-sm text-destructive">Falha ao instalar o certificado no servidor de e-mail: {tls.syncError}</p>
        )}
        {tls?.hosts.map((h) => (
          <div key={h.host} className="flex flex-col gap-1 rounded-lg border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{h.host}</span>
              {h.ok ? <Badge variant="success">válido</Badge> : <Badge variant="warning">pendente</Badge>}
            </div>
            {h.ok ? (
              <p className="text-xs text-muted-foreground">
                Emitido por {h.issuer ?? "—"}
                {h.validTo ? ` · válido até ${formatDate(h.validTo)} (renovado automaticamente)` : ""}
              </p>
            ) : (
              <>
                {h.hint && <p className="text-sm text-amber-400">{h.hint}</p>}
                {h.error && <p className="text-xs text-muted-foreground">Resposta do servidor: {h.error}</p>}
              </>
            )}
          </div>
        ))}
        {/* Modo (automático/manual), ações e histórico ficam na página Certificados. */}
        <CertificateSummary query="kind=mail" />
      </CardContent>
    </Card>
  );
}

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
  const [tls, setTls] = useState<MailTlsStatusResponse | null>(null);
  const [tlsBusy, setTlsBusy] = useState(false);
  const [existingMail, setExistingMail] = useState<{ domain: string; info: ExistingMailInfo } | null>(null);

  const loadTls = useCallback(async () => {
    setTlsBusy(true);
    try {
      setTls(await apiFetch<MailTlsStatusResponse>("/api/mail/tls"));
    } catch {
      setTls(null);
    } finally {
      setTlsBusy(false);
    }
  }, []);

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

  const showTls = Boolean(status?.running) && domains.length > 0;
  useEffect(() => {
    if (showTls) void loadTls();
  }, [showTls, loadTls]);

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

  async function addDomain(name = newDomain.trim(), confirmExistingMail = false) {
    if (!name) return;
    setBusy("add");
    setError(null);
    try {
      await apiFetch("/api/mail/domains", {
        method: "POST",
        body: JSON.stringify(confirmExistingMail ? { domain: name, confirmExistingMail: true } : { domain: name }),
      });
      setNewDomain("");
      setExistingMail(null);
      await refresh();
    } catch (err) {
      const info = err instanceof ApiRequestError && err.code === "domain_receives_mail"
        ? (err.data?.existingMail as ExistingMailInfo | undefined)
        : undefined;
      if (info) {
        setExistingMail({ domain: name, info });
      } else {
        setError(err instanceof Error ? err.message : "Falha ao adicionar o domínio.");
      }
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
                Adicione o domínio abaixo — o painel provisiona no Stalwart e gera a chave DKIM (RSA 2048). Se o
                domínio já tem e-mail funcionando em outro provedor, use um subdomínio só para o envio (ex.:
                envio.seudominio.com.br): apontar o MX do domínio principal para cá desviaria o e-mail da empresa.
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

      {showTls && <MailTlsCard tls={tls} busy={tlsBusy} onRecheck={() => void loadTls()} />}

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
          {existingMail && (
            <ExistingMailWarning
              key={existingMail.domain}
              domain={existingMail.domain}
              info={existingMail.info}
              busy={busy !== null}
              onUseSuggested={() => void addDomain(existingMail.info.suggestedDomain)}
              onConfirm={() => void addDomain(existingMail.domain, true)}
              onCancel={() => setExistingMail(null)}
            />
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
