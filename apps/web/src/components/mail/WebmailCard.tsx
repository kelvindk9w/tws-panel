/**
 * Card "Webmail" da página E-mail (pedido do dono do produto, 04/10/2026):
 * ler, responder e enviar e-mail das caixas pelo navegador, em
 * https://mail.<domínio>/, sem configurar Outlook ou Gmail. Ativa/desativa
 * o webmail, mostra o estado e um "Abrir webmail" por domínio.
 */
import { useCallback, useEffect, useState } from "react";
import type { WebmailActionResponse, WebmailStatus } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, Loader2, MailOpen, Play, ShieldAlert, Square } from "lucide-react";

function StateBadge({ status }: { status: WebmailStatus }) {
  const { t } = useI18n();
  if (!status.enabled) return <Badge variant="secondary">{t("mail.webmail.state.disabled")}</Badge>;
  if (!status.running) return <Badge variant="warning">{t("mail.webmail.state.stopped")}</Badge>;
  return <Badge variant="success">{t("mail.webmail.state.active")}</Badge>;
}

export function WebmailCard({ refreshKey }: { refreshKey?: string } = {}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WebmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<WebmailStatus>("/api/mail/webmail"));
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "mail.webmail.loadError"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function act(kind: "enable" | "disable") {
    setBusy(kind);
    setError(null);
    setWarning(null);
    try {
      const res = await apiFetch<WebmailActionResponse & { proxyError?: string }>(`/api/mail/webmail/${kind}`, {
        method: "POST",
      });
      setStatus(res.status);
      setConfirmDisable(false);
      if (res.proxyError) {
        setWarning(
          t(kind === "enable" ? "mail.webmail.proxyWarningEnabled" : "mail.webmail.proxyWarningDisabled", {
            error: res.proxyError,
          }),
        );
      }
    } catch (err) {
      setError(apiErrorText(err, "mail.webmail.actionError"));
    } finally {
      setBusy(null);
    }
  }

  const canEnable = Boolean(status?.mailServerRunning) && (status?.links.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailOpen className="h-4 w-4" /> {t("mail.webmail.title")}
          </CardTitle>
          {status && <StateBadge status={status} />}
        </div>
        <CardDescription>
          {t("mail.webmail.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!status && !error && <p className="text-sm text-muted-foreground">{t("mail.common.loadingLower")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {warning && <p className="text-sm text-amber-400">{warning}</p>}
        {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}

        {status?.enabled && status.running && status.links.length > 0 && (
          <div className="flex flex-col divide-y rounded-lg border">
            {status.links.map((link) => (
              <div key={link.host} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="min-w-0 flex-1 break-all font-mono text-sm">{link.host}</span>
                <Button variant="info" size="sm" asChild>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" /> {t("mail.webmail.open")}
                  </a>
                </Button>
              </div>
            ))}
          </div>
        )}

        {status?.enabled && !status.tlsVerified && (
          <p className="text-xs text-amber-400">
            {t("mail.webmail.tlsPending")}
          </p>
        )}
        {status && status.blockedIps > 0 && (
          <p className="flex items-center gap-2 text-xs text-amber-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {t("mail.webmail.blocked", { count: status.blockedIps })}
          </p>
        )}

        {status && (
          <div className="flex flex-wrap gap-2">
            {(!status.enabled || !status.running) && (
              <Button
                variant="success"
                size="sm"
                disabled={busy !== null || !canEnable}
                onClick={() => void act("enable")}
              >
                {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {t("mail.webmail.enable")}
              </Button>
            )}
            {status.enabled &&
              (confirmDisable ? (
                <>
                  <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("disable")}>
                    {busy === "disable" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("mail.common.confirm")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDisable(false)}>
                    {t("mail.common.cancel")}
                  </Button>
                </>
              ) : (
                <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
                  <Square className="h-4 w-4" /> {t("mail.webmail.disable")}
                </Button>
              ))}
          </div>
        )}

        {status?.enabled && (
          <p className="text-xs text-muted-foreground">
            {t("mail.webmail.loginHint")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
