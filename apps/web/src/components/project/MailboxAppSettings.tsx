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

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all font-mono">{value}</span>
    </div>
  );
}

export function MailboxAppSettings({ mailbox }: { mailbox: string }) {
  const [credentials, setCredentials] = useState<MailboxCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MailboxCredentialsResponse>(`/api/mail/mailboxes/${encodeURIComponent(mailbox)}/credentials`)
      .then((r) => setCredentials(r.credentials))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Falha ao carregar a configuração."));
  }, [mailbox]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!credentials) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  return (
    <div data-testid="mailbox-app-settings" className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground">
        Para ler as respostas, adicione esta caixa num app de e-mail (Outlook, Thunderbird, app do celular ou o Gmail em
        "Verificar e-mails de outras contas"):
      </p>
      <div className="flex flex-col gap-1">
        <Row label="Usuário" value={credentials.username} />
        <Row label="Senha" value="a da caixa (esqueceu? Trocar senha)" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Receber (IMAP)</p>
        <Row label="Servidor" value={credentials.imap.host} />
        <Row label="Porta" value={`${credentials.imap.port} (SSL/TLS)`} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Enviar (SMTP)</p>
        <Row label="Servidor" value={credentials.smtp.host} />
        <Row label="Porta" value={`${credentials.smtp.port} (STARTTLS) ou ${credentials.smtpAlt.port} (SSL/TLS)`} />
      </div>
    </div>
  );
}
