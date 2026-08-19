import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  DnsChecklistResponse,
  DnsCheckStatus,
  DnsRecordCheck,
  DnsVerifyResponse,
  Mailbox,
  MailboxCredentials,
  MailboxCredentialsResponse,
  MailboxListResponse,
  MailboxResponse,
  PtrCheck,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  Inbox,
  Loader2,
  MailPlus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback para contextos sem clipboard API (http)
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }
  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()} title={label ?? "Copiar"}>
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}

function StatusIcon({ status }: { status: DnsCheckStatus }) {
  switch (status) {
    case "found":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
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

// ---------------------------------------------------------------------------
// Modal de credenciais
// ---------------------------------------------------------------------------

function CredentialRow({ label, value, mono = true }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <code className={cn("rounded bg-secondary px-1.5 py-0.5 text-xs", !mono && "font-sans")}>{value}</code>
        <CopyButton text={String(value)} />
      </span>
    </div>
  );
}

function CredentialsModal({
  credentials,
  onClose,
}: {
  credentials: MailboxCredentials;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credenciais — {credentials.email}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conta</p>
            <CredentialRow label="Usuário" value={credentials.username} />
            <CredentialRow label="Senha" value={credentials.password} />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recebimento (IMAP)
            </p>
            <CredentialRow label="Servidor" value={credentials.imap.host} />
            <CredentialRow label="Porta" value={credentials.imap.port} />
            <CredentialRow label="Segurança" value="SSL/TLS" mono={false} />
            <p className="text-xs text-muted-foreground">
              Alternativa: porta {credentials.imapAlt.port} com STARTTLS.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Envio (SMTP)
            </p>
            <CredentialRow label="Servidor" value={credentials.smtp.host} />
            <CredentialRow label="Porta" value={credentials.smtp.port} />
            <CredentialRow label="Segurança" value="STARTTLS" mono={false} />
            <p className="text-xs text-muted-foreground">
              Alternativa: porta {credentials.smtpAlt.port} com SSL/TLS.
            </p>
          </div>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {credentials.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export function MailDomainPage() {
  const { domain } = useParams<{ domain: string }>();
  const name = domain ?? "";

  const [checklist, setChecklist] = useState<DnsChecklistResponse | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [lastVerify, setLastVerify] = useState<DnsVerifyResponse | null>(null);
  const [tab, setTab] = useState<"dns" | "mailboxes">("dns");

  const [newMailbox, setNewMailbox] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<{ email: string; password: string } | null>(null);
  const [credentials, setCredentials] = useState<MailboxCredentials | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!name) return;
    try {
      const [dns, boxes] = await Promise.all([
        apiFetch<DnsChecklistResponse>(`/api/mail/domains/${encodeURIComponent(name)}/dns`),
        apiFetch<MailboxListResponse>(`/api/mail/domains/${encodeURIComponent(name)}/mailboxes`),
      ]);
      setChecklist(dns);
      setMailboxes(boxes.mailboxes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o domínio.");
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
      setChecklist((prev) =>
        prev ? { ...prev, records: res.records, ptr: res.ptr, suggestion: res.suggestion } : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao verificar o DNS.");
    } finally {
      setVerifying(false);
    }
  }

  async function addMailbox() {
    const local = newMailbox.trim();
    if (!local) return;
    setBusy("add");
    setError(null);
    try {
      const res = await apiFetch<MailboxResponse>(
        `/api/mail/domains/${encodeURIComponent(name)}/mailboxes`,
        { method: "POST", body: JSON.stringify({ localPart: local }) },
      );
      setNewMailbox("");
      setCreatedPassword({ email: res.mailbox.id, password: res.password });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar a caixa.");
    } finally {
      setBusy(null);
    }
  }

  async function showCredentials(email: string) {
    setBusy(`cred-${email}`);
    try {
      const res = await apiFetch<MailboxCredentialsResponse>(
        `/api/mail/mailboxes/${encodeURIComponent(email)}/credentials`,
      );
      setCredentials(res.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao obter as credenciais.");
    } finally {
      setBusy(null);
    }
  }

  async function removeMailbox(email: string) {
    setBusy(`rm-${email}`);
    setError(null);
    try {
      await apiFetch(
        `/api/mail/domains/${encodeURIComponent(name)}/mailboxes/${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
      setConfirmRemove(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover a caixa.");
    } finally {
      setBusy(null);
    }
  }

  if (!checklist) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? "Carregando…"}
      </p>
    );
  }

  const records: DnsRecordCheck[] = checklist.records;
  const ptr: PtrCheck = checklist.ptr;
  const okCount = records.filter((r) => r.status === "found").length + (ptr.status === "found" ? 1 : 0);
  const total = records.length + 1;

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

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-1 border-b">
        {(
          [
            ["dns", "Checklist DNS"],
            ["mailboxes", `Caixas (${mailboxes.length})`],
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

      {tab === "dns" && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
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
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Tipo</th>
                    <th className="px-4 py-2 font-medium">Nome</th>
                    <th className="px-4 py-2 font-medium">Valor esperado</th>
                    <th className="px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-1.5 text-xs">
                          <StatusIcon status={record.status} />
                          {statusLabel(record.status)}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{record.type}</td>
                      <td className="px-4 py-2 font-mono text-xs">{record.name}</td>
                      <td className="max-w-md px-4 py-2">
                        <p className="break-all font-mono text-xs">{record.expected}</p>
                        <p className="text-xs text-muted-foreground">{record.purpose}</p>
                        {record.note && <p className="text-xs text-amber-400">{record.note}</p>}
                        {record.found.length > 0 && record.status !== "found" && (
                          <p className="break-all text-xs text-muted-foreground">
                            encontrado: {record.found.join(" | ")}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <CopyButton text={`${record.name}  ${record.type}  ${record.expected}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card className={cn(ptr.status === "found" ? "" : "border-amber-500/40")}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <StatusIcon status={ptr.status} /> Reverse DNS (PTR) — {ptr.ip}
              </CardTitle>
              <CardDescription>
                Esperado: <code className="text-xs">{ptr.expected}</code>. O PTR só pode ser
                configurado pelo provedor da VPS — não é um registro do DNS do domínio.
                {ptr.found.length > 0 && ` Encontrado: ${ptr.found.join(", ")}.`}
              </CardDescription>
            </CardHeader>
            {ptr.ticketText && (
              <CardContent className="flex flex-col gap-2">
                <p className="text-sm text-amber-400">
                  Sem PTR válido o Gmail, Yahoo e Microsoft podem rejeitar suas mensagens (FCrDNS
                  obrigatório). Abra um chamado no provedor da VPS com o texto abaixo:
                </p>
                <pre className="whitespace-pre-wrap rounded-lg border bg-black/40 p-3 font-mono text-xs">
                  {ptr.ticketText}
                </pre>
                <div>
                  <CopyButton text={ptr.ticketText} label="Copiar texto do chamado" />
                </div>
              </CardContent>
            )}
          </Card>

          {checklist.suggestion && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Evolução da política (DMARC progressivo)</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{checklist.suggestion}</CardContent>
            </Card>
          )}
        </>
      )}

      {tab === "mailboxes" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox className="h-4 w-4" /> Caixas de e-mail
            </CardTitle>
            <CardDescription>
              Credenciais prontas para Outlook, Gmail e Thunderbird (botão "ver credenciais").
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-2">
              <div className="flex max-w-xs flex-1 items-center">
                <Input
                  placeholder="contato"
                  value={newMailbox}
                  onChange={(e) => setNewMailbox(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addMailbox()}
                  className="rounded-r-none"
                />
                <span className="flex h-9 items-center rounded-r-md border border-l-0 bg-secondary px-3 text-sm text-muted-foreground">
                  @{checklist.domain}
                </span>
              </div>
              <Button size="sm" disabled={busy !== null || !newMailbox.trim()} onClick={() => void addMailbox()}>
                {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
                Criar caixa
              </Button>
            </div>

            {createdPassword && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
                <span>
                  Caixa <strong>{createdPassword.email}</strong> criada. Senha gerada:{" "}
                  <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{createdPassword.password}</code>
                </span>
                <div className="flex items-center gap-1">
                  <CopyButton text={createdPassword.password} />
                  <Button variant="ghost" size="icon" onClick={() => setCreatedPassword(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {mailboxes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma caixa neste domínio ainda.</p>
            ) : (
              <div className="flex flex-col divide-y rounded-lg border">
                {mailboxes.map((mailbox) => (
                  <div key={mailbox.id} className="flex items-center gap-3 px-4 py-3">
                    <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{mailbox.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {mailbox.kind === "system"
                          ? "sistema (postmaster/abuse)"
                          : mailbox.kind === "project"
                            ? "caixa técnica de projeto"
                            : `criada em ${new Date(mailbox.createdAt).toLocaleString("pt-BR")}`}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void showCredentials(mailbox.id)}
                    >
                      {busy === `cred-${mailbox.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                      Ver credenciais
                    </Button>
                    {mailbox.kind === "user" &&
                      (confirmRemove === mailbox.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void removeMailbox(mailbox.id)}
                          >
                            {busy === `rm-${mailbox.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                            Cancelar
                          </Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="icon" onClick={() => setConfirmRemove(mailbox.id)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {credentials && <CredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />}
    </div>
  );
}
