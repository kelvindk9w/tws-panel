import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  ExistingMailInfo,
  MailDomainListResponse,
  MailDomainSummary,
  MailServerActionResponse,
  MailServerStatus,
  MailSyncResponse,
  MailTlsStatusResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { apiErrorText, formatDate as formatDateI18n, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CertificateSummary } from "@/components/certificates/CertificateSummary";
import { ExistingMailWarning } from "@/components/mail/ExistingMailWarning";
import { WebmailCard } from "@/components/mail/WebmailCard";
import {
  CheckCircle2,
  ChartColumn,
  ChevronRight,
  Globe,
  Loader2,
  Lock,
  Mail,
  MailPlus,
  Play,
  RefreshCw,
  RefreshCcw,
  Server,
  Square,
  Trash2,
} from "lucide-react";

function formatDate(iso: string): string {
  return formatDateI18n(iso, { timeZone: "UTC" });
}

/**
 * Certificado do servidor de e-mail (mail.<domínio>). Validação real
 * (01/10/2026): com o autoassinado, o app do projeto (nodemailer com
 * verificação padrão) recusaria a conexão. O painel instala o certificado
 * que o proxy emite; aqui o operador vê se já vale ou o que falta.
 */
function MailTlsCard({ tls, busy, onRecheck }: { tls: MailTlsStatusResponse | null; busy: boolean; onRecheck: () => void }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" /> {t("mail.page.tls.title")}
          </CardTitle>
          <Button variant="outline" size="sm" disabled={busy} onClick={onRecheck}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("mail.common.recheck")}
          </Button>
        </div>
        <CardDescription>
          {t("mail.page.tls.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!tls && <p className="text-sm text-muted-foreground">{t("mail.page.tls.checking")}</p>}
        {tls?.syncError && (
          <p className="text-sm text-destructive">{t("mail.page.tls.syncError", { error: tls.syncError })}</p>
        )}
        {tls?.hosts.map((h) => (
          <div key={h.host} className="flex flex-col gap-1 rounded-lg border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{h.host}</span>
              {h.ok ? <Badge variant="success">{t("mail.page.tls.valid")}</Badge> : <Badge variant="warning">{t("mail.page.tls.pending")}</Badge>}
            </div>
            {h.ok ? (
              <p className="text-xs text-muted-foreground">
                {t("mail.page.tls.issuedBy", { issuer: h.issuer ?? "—" })}
                {h.validTo ? t("mail.page.tls.validUntil", { date: formatDate(h.validTo) }) : ""}
              </p>
            ) : (
              <>
                {h.hint && <p className="text-sm text-amber-400">{h.hint}</p>}
                {h.error && <p className="text-xs text-muted-foreground">{t("mail.page.tls.serverReply", { error: h.error })}</p>}
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
  const { t } = useI18n();
  if (!domain.lastVerify) {
    return <Badge variant="secondary">{t("mail.page.dns.notVerified")}</Badge>;
  }
  if (domain.lastVerify.ok === domain.lastVerify.total) {
    return (
      <Badge variant="success">
        {t("mail.page.dns.recordsOk", { ok: domain.lastVerify.ok, total: domain.lastVerify.total })}
      </Badge>
    );
  }
  return (
    <Badge variant="warning">
      {t("mail.page.dns.recordsPending", { ok: domain.lastVerify.ok, total: domain.lastVerify.total })}
    </Badge>
  );
}

/** Resultado da sincronização: contagens e endereços (nunca senhas). */
function SyncResult({ result }: { result: MailSyncResponse }) {
  const { t } = useI18n();
  const parts = [
    ...(result.domainCount > 0 ? [t("mail.page.sync.domains", { count: result.domainCount })] : []),
    ...(result.mailboxCount > 0 ? [t("mail.page.sync.mailboxes", { count: result.mailboxCount })] : []),
  ];
  const added = parts.length > 0;
  return (
    <div data-testid="mail-sync-result" role="status" className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
      <p className={added ? "font-medium text-emerald-400" : "text-muted-foreground"}>
        {added ? t("mail.page.sync.done", { what: parts.join(t("mail.page.sync.and")) }) : t("mail.page.sync.nothing")}
      </p>
      {result.domains.length > 0 && (
        <p className="break-all text-xs text-muted-foreground">{t("mail.page.sync.domainsList", { list: result.domains.join(", ") })}</p>
      )}
      {result.mailboxes.length > 0 && (
        <p className="break-all text-xs text-muted-foreground">{t("mail.page.sync.mailboxesList", { list: result.mailboxes.join(", ") })}</p>
      )}
      {(result.passwordsRealigned ?? 0) > 0 && (
        <>
          <p className="font-medium text-emerald-400">{t("mail.page.sync.realigned", { count: result.passwordsRealigned ?? 0 })}</p>
          <p className="text-xs text-muted-foreground">{t("mail.page.sync.realignedNote")}</p>
        </>
      )}
      {(result.passwordsFailed?.length ?? 0) > 0 && (
        <p className="break-all text-xs text-amber-400">{t("mail.page.sync.realignFailed", { list: (result.passwordsFailed ?? []).join(", ") })}</p>
      )}
      {result.mailboxCount > 0 && <p className="text-xs text-muted-foreground">{t("mail.page.sync.passwordNote")}</p>}
      {result.domainCount > 0 && <p className="text-xs text-muted-foreground">{t("mail.page.sync.dnsNote")}</p>}
      {result.domainCount > 0 && <p className="text-xs text-muted-foreground">{t("mail.page.sync.restartNote")}</p>}
      {result.skipped.length > 0 && (
        <p className="break-all text-xs text-amber-400">
          {t("mail.page.sync.skipped", { list: result.skipped.join(", ") })}
          {(result.skippedTotal ?? 0) > result.skipped.length &&
            ` ${t("mail.page.sync.skippedMore", { count: (result.skippedTotal ?? 0) - result.skipped.length })}`}
        </p>
      )}
      {result.truncated && <p className="text-xs text-amber-400">{t("mail.page.sync.truncated")}</p>}
    </div>
  );
}

const ONBOARDING_STEPS: Key[] = [
  "mail.page.onboarding.step1",
  "mail.page.onboarding.step2",
  "mail.page.onboarding.step3",
  "mail.page.onboarding.step4",
];

const AUTH_ERROR_CODES = ["mail_auth_failed", "mail_auth_repair_failed", "mail_auth_repair_incomplete"];

function isAuthError(err: unknown): boolean {
  return err instanceof ApiRequestError && AUTH_ERROR_CODES.includes(err.code);
}

export function MailPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MailServerStatus | null>(null);
  const [domains, setDomains] = useState<MailDomainSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [tls, setTls] = useState<MailTlsStatusResponse | null>(null);
  const [tlsBusy, setTlsBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<MailSyncResponse | null>(null);
  // Erro de senha de administração: o botão Reparar agora aparece junto da mensagem.
  const [authError, setAuthError] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
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
      setError(apiErrorText(err, "mail.page.loadError"));
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
      setError(apiErrorText(err, action === "start" ? "mail.page.startError" : "mail.page.stopError"));
    } finally {
      setBusy(null);
    }
  }

  // Cadastra no painel o que o servidor de e-mail já tem (depois de restaurar). O servidor junta chamadas simultâneas.
  async function syncWithServer() {
    setBusy("sync");
    setError(null);
    setAuthError(false);
    setConfirmRepair(false);
    setSyncResult(null);
    try {
      setSyncResult(await apiFetch<MailSyncResponse>("/api/mail/sync", { method: "POST" }));
      await refresh();
    } catch (err) {
      setError(apiErrorText(err, "mail.page.sync.error"));
      setAuthError(isAuthError(err));
    } finally {
      setBusy(null);
    }
  }

  // Mesmo reparo do aviso do Dashboard (regrava a configuração e reinicia, sem apagar dados); dando certo, sincroniza de novo.
  async function repairAuth() {
    setBusy("repair");
    setError(null);
    try {
      await apiFetch("/api/mail/server/repair-auth", { method: "POST" });
      setConfirmRepair(false);
      setAuthError(false);
    } catch (err) {
      setError(apiErrorText(err, "mail.page.repair.error"));
      setAuthError(isAuthError(err));
      setConfirmRepair(false);
      setBusy(null);
      return;
    }
    setBusy(null);
    await syncWithServer();
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
        setError(apiErrorText(err, "mail.page.addError"));
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
      setError(apiErrorText(err, "mail.page.removeError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Mail className="h-6 w-6" /> {t("mail.page.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("mail.page.subtitle")}
          </p>
        </div>
        {/* fila, histórico, volume, reputação e nota de entregabilidade */}
        <Button variant="info" size="sm" asChild>
          <Link to="/mail/envios">
            <ChartColumn className="h-4 w-4" /> {t("mail.page.viewSending")}
          </Link>
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {error && authError && (
        <div data-testid="mail-auth-repair" className="flex flex-wrap items-center gap-2 text-sm">
          {confirmRepair ? (
            <>
              <span>{t("mail.page.repair.confirmText")}</span>
              <Button size="sm" disabled={busy !== null} onClick={() => void repairAuth()}>
                {busy === "repair" && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy === "repair" ? t("mail.page.repair.working") : t("mail.page.repair.confirm")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRepair(false)}>
                {t("mail.page.repair.cancel")}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy !== null} onClick={() => setConfirmRepair(true)}>
              {t("mail.page.repair.cta")}
            </Button>
          )}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" /> {t("mail.page.server.title")}
            </CardTitle>
            {status &&
              (status.running ? (
                <Badge variant="success">
                  {status.version ? t("mail.page.server.runningVersion", { version: status.version }) : t("mail.page.server.running")}
                </Badge>
              ) : (
                <Badge variant="secondary">{t("mail.page.server.stopped")}</Badge>
              ))}
          </div>
          <CardDescription>
            {status
              ? t("mail.page.server.info", {
                  container: status.containerName,
                  image: status.image,
                  hostname: status.hostname,
                })
              : t("mail.common.loadingLower")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}
          {status && (
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>{t("mail.page.server.portSmtp", { port: status.ports.smtp })}</span>
              <span>{t("mail.page.server.portSubmission", { port: status.ports.submission })}</span>
              <span>{t("mail.page.server.portSmtps", { port: status.ports.submissions })}</span>
              <span>{t("mail.page.server.portImap", { port: status.ports.imap })}</span>
              <span>{t("mail.page.server.portImaps", { port: status.ports.imaps })}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {status?.running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void serverAction("stop")}
              >
                {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                {t("mail.page.server.stop")}
              </Button>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => void serverAction("start")}>
                {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {t("mail.page.server.start")}
              </Button>
            )}
            {status?.running && (
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void syncWithServer()}>
                {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                {t("mail.page.sync.button")}
              </Button>
            )}
          </div>
          {status?.running && <p className="text-xs text-muted-foreground">{t("mail.page.sync.hint")}</p>}
          {syncResult && <SyncResult result={syncResult} />}
        </CardContent>
      </Card>

      {domains.length === 0 && status?.running ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">{t("mail.page.onboarding.title")}</CardTitle>
            <CardDescription>{t("mail.page.onboarding.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
              {ONBOARDING_STEPS.map((stepKey, i) => (
                <li key={stepKey} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">
                    {i + 1}
                  </span>
                  {t(stepKey)}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      {showTls && <MailTlsCard tls={tls} busy={tlsBusy} onRecheck={() => void loadTls()} />}

      {/* Webmail: com pelo menos um domínio (é ele que dá o endereço mail.<domínio>). */}
      {domains.length > 0 && <WebmailCard refreshKey={`${status?.running ?? false}-${domains.length}`} />}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("mail.page.domains.title")}</CardTitle>
          <CardDescription>
            {t("mail.page.domains.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Input
              placeholder={t("mail.page.domains.placeholder")}
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addDomain()}
              disabled={!status?.running}
              className="max-w-xs"
            />
            <Button size="sm" disabled={busy !== null || !status?.running || !newDomain.trim()} onClick={() => void addDomain()}>
              {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
              {t("mail.page.domains.add")}
            </Button>
          </div>
          {!status?.running && (
            <p className="text-xs text-muted-foreground">{t("mail.page.domains.startFirst")}</p>
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
                      {t("mail.page.domains.meta", {
                        count: domain.mailboxCount,
                        bits: domain.dkimKeyBits,
                        stage: domain.dmarcStage,
                      })}
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
                        {busy === `rm-${domain.name}` ? <Loader2 className="h-4 w-4 animate-spin" /> : t("mail.common.confirm")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                        {t("mail.common.cancel")}
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
              <CheckCircle2 className="h-4 w-4" /> {t("mail.page.domains.allVerified")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
