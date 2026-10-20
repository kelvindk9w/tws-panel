/**
 * Como abrir a caixa do projeto num app de e-mail (Outlook, Gmail, celular):
 * servidor, portas e usuário — sem a senha, que nunca volta pela API.
 * (A página do domínio tem um modal parecido; este fica no card do projeto
 * para não depender dela.)
 */
import { useEffect, useState } from "react";
import type { MailboxCredentials, MailboxCredentialsResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Loader2 } from "lucide-react";
import { apiErrorText, useI18n } from "@/i18n";

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all font-mono">{value}</span>
    </div>
  );
}

export function MailboxAppSettings({ mailbox }: { mailbox: string }) {
  const { t } = useI18n();
  const [credentials, setCredentials] = useState<MailboxCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MailboxCredentialsResponse>(`/api/mail/mailboxes/${encodeURIComponent(mailbox)}/credentials`)
      .then((r) => setCredentials(r.credentials))
      .catch((err: unknown) => setError(apiErrorText(err, "projects.mailboxApp.loadError")));
  }, [mailbox]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!credentials) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  return (
    <div data-testid="mailbox-app-settings" className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground">
        {t("projects.mailboxApp.intro")}
      </p>
      <div className="flex flex-col gap-1">
        <Row label={t("projects.mailboxApp.user")} value={credentials.username} />
        <Row label={t("projects.mailboxApp.password")} value={t("projects.mailboxApp.passwordValue")} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t("projects.mailboxApp.receive")}</p>
        <Row label={t("projects.mailboxApp.server")} value={credentials.imap.host} />
        <Row label={t("projects.mailboxApp.port")} value={`${credentials.imap.port} (SSL/TLS)`} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t("projects.mailboxApp.send")}</p>
        <Row label={t("projects.mailboxApp.server")} value={credentials.smtp.host} />
        <Row label={t("projects.mailboxApp.port")} value={t("projects.mailboxApp.smtpPorts", { port: credentials.smtp.port, altPort: credentials.smtpAlt.port })} />
      </div>
    </div>
  );
}
