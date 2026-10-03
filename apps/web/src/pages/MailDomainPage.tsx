import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { MAILBOX_PASSWORD_MIN } from "@paas/core";
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
  PtrCheckStatus,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TestEmailCard, TestEmailModal } from "@/components/mail/TestEmailCard";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Inbox,
  KeyRound,
  Send,
  Settings2,
  Info,
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

/**
 * Botão de copiar. Copia exatamente `text`; o ícone vira um "copiado" (✓)
 * por 1,5 s. `ariaLabel` diz o que é copiado para quem usa leitor de tela.
 */
function CopyButton({ text, label, ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    await copyText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_500);
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(!label && "h-7 w-7 shrink-0 p-0")}
      onClick={() => void copy()}
      title={copied ? "Copiado" : (ariaLabel ?? label ?? "Copiar")}
      aria-label={ariaLabel}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}

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
      <CardHeader className="pb-2">
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
        <CardContent>
          <p className="text-sm text-emerald-400">Tudo certo: o nome reverso do IP é {ptr.expected}.</p>
        </CardContent>
      )}

      {ptr.status === "generic" && (
        <CardContent className="flex flex-col gap-2">
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
        <CardContent>
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
        <CardContent className="flex flex-col gap-2">
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

/**
 * Senha nova (criar caixa ou trocar): a pessoa define e repete. Os campos
 * são de senha (nunca mostram o texto) e o painel nunca devolve a senha.
 */
function passwordProblem(password: string, confirm: string): string | null {
  if (password.length > 0 && password.trim().length < MAILBOX_PASSWORD_MIN) {
    return `A senha deve ter pelo menos ${MAILBOX_PASSWORD_MIN} caracteres.`;
  }
  if (confirm.length > 0 && confirm !== password) return "As senhas não conferem.";
  return null;
}

function passwordReady(password: string, confirm: string): boolean {
  return password.trim().length >= MAILBOX_PASSWORD_MIN && password === confirm;
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ChangePasswordModal({
  email,
  onClose,
  onDone,
}: {
  email: string;
  onClose: () => void;
  onDone: (email: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(password, confirm);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch<MailboxResponse>(`/api/mail/mailboxes/${encodeURIComponent(email)}/password`, {
        method: "PUT",
        body: JSON.stringify({ password }),
      });
      onDone(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar a senha.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={`Trocar senha — ${email}`} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Defina uma senha nova. Por segurança o painel nunca mostra a senha: guarde-a no seu gerenciador de senhas.
          Depois, atualize a senha no app de e-mail onde a caixa estiver configurada.
        </p>
        <label className="flex flex-col gap-1">
          <span>Nova senha</span>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span>Repita a nova senha</span>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {(problem || error) && <p className="text-destructive">{problem ?? error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="success" disabled={saving || !passwordReady(password, confirm)} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Salvar nova senha
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function CredentialsModal({
  credentials,
  canChangePassword,
  onChangePassword,
  onClose,
}: {
  credentials: MailboxCredentials;
  canChangePassword: boolean;
  onChangePassword: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell title={`Configurar no app de e-mail — ${credentials.email}`} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conta</p>
            <CredentialRow label="Usuário" value={credentials.username} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Senha</span>
              <span className="text-right text-xs text-muted-foreground">
                a que você definiu ao criar a caixa (o painel não mostra senhas)
              </span>
            </div>
            {canChangePassword && (
              <div>
                <Button variant="outline" size="sm" onClick={onChangePassword}>
                  <KeyRound className="h-4 w-4" /> Trocar senha
                </Button>
              </div>
            )}
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
    </ModalShell>
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
  // abre em Caixas (pedido do dono do produto, 02/10/2026); ?aba=dns abre no
  // checklist (link do e-mail do projeto, logo depois de cadastrar o domínio)
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<"dns" | "mailboxes">(searchParams.get("aba") === "dns" ? "dns" : "mailboxes");

  const [newMailbox, setNewMailbox] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<MailboxCredentials | null>(null);
  const [changingPassword, setChangingPassword] = useState<string | null>(null);
  /** Caixa cujo envio está sendo testado (modal). */
  const [testingFrom, setTestingFrom] = useState<string | null>(null);
  /** Caixa da senha recém-trocada: o aviso oferece testar o envio dela. */
  const [changedMailbox, setChangedMailbox] = useState<string | null>(null);
  const autoVerified = useRef(false);
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

  // Ao abrir, confere o DNS de verdade: a lista de domínios mostra o resultado
  // da última verificação, e o detalhe não pode dizer "não verificado".
  useEffect(() => {
    if (!checklist || autoVerified.current) return;
    autoVerified.current = true;
    void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklist]);

  async function addMailbox() {
    const local = newMailbox.trim();
    if (!local || !passwordReady(newPassword, newPasswordConfirm)) return;
    setBusy("add");
    setError(null);
    try {
      const res = await apiFetch<MailboxResponse>(
        `/api/mail/domains/${encodeURIComponent(name)}/mailboxes`,
        { method: "POST", body: JSON.stringify({ localPart: local, password: newPassword }) },
      );
      setNewMailbox("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setChangedMailbox(null);
      setNotice(`Caixa ${res.mailbox.id} criada. Use a senha que você definiu (o painel não mostra senhas).`);
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
  const okCount = records.filter((r) => r.status === "found").length + (ptrIsOk(ptr.status) ? 1 : 0);
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

      {/* O registro A de mail.<domínio> ficou certo e o certificado ainda não
          era válido: a verificação pediu a emissão sozinha. */}
      {lastVerify?.certificateRetry && (
        <p className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
          <span className="min-w-0 break-words">
            Certificado de {lastVerify.certificateRetry.host}: emissão pedida — confira em{" "}
            <Link to="/certificates" className="underline underline-offset-2">
              Certificados
            </Link>
            .
          </span>
        </p>
      )}

      <div className="flex gap-1 border-b">
        {(
          [
            ["mailboxes", `Caixas (${mailboxes.length})`],
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
              Você define a senha de cada caixa; o painel nunca a mostra. Esqueceu? Use "Trocar senha". Para Outlook,
              Gmail ou Thunderbird, veja "Configurar no app".
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-lg border p-3 sm:p-4">
              <p className="text-sm font-medium">Nova caixa</p>
              <div className="flex min-w-0 max-w-md items-center">
                <Input
                  placeholder="contato"
                  value={newMailbox}
                  onChange={(e) => setNewMailbox(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addMailbox()}
                  className="w-28 shrink-0 rounded-r-none sm:w-auto sm:flex-1"
                />
                <span className="flex h-9 min-w-0 items-center truncate rounded-r-md border border-l-0 bg-secondary px-3 text-sm text-muted-foreground">
                  @{checklist.domain}
                </span>
              </div>
              <div className="grid max-w-md gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span>Senha da caixa</span>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>Repita a senha</span>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newPasswordConfirm}
                    onChange={(e) => setNewPasswordConfirm(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void addMailbox()}
                  />
                </label>
              </div>
              <p className={cn("text-xs", passwordProblem(newPassword, newPasswordConfirm) ? "text-destructive" : "text-muted-foreground")}>
                {passwordProblem(newPassword, newPasswordConfirm) ??
                  `Mínimo de ${MAILBOX_PASSWORD_MIN} caracteres. Guarde a senha no seu gerenciador: o painel não a mostra depois.`}
              </p>
              <div>
                <Button
                  size="sm"
                  disabled={busy !== null || !newMailbox.trim() || !passwordReady(newPassword, newPasswordConfirm)}
                  onClick={() => void addMailbox()}
                >
                  {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
                  Criar caixa
                </Button>
              </div>
            </div>

            {notice && (
              <div className="flex items-start justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
                <div className="flex min-w-0 flex-col items-start gap-2">
                  <span className="break-words">{notice}</span>
                  {changedMailbox && (
                    <Button variant="deploy" size="sm" onClick={() => setTestingFrom(changedMailbox)}>
                      <Send className="h-4 w-4" /> Enviar e-mail de teste
                    </Button>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Fechar aviso"
                  onClick={() => {
                    setNotice(null);
                    setChangedMailbox(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}

            {mailboxes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma caixa neste domínio ainda.</p>
            ) : (
              <div className="flex flex-col divide-y rounded-lg border">
                {mailboxes.map((mailbox) => (
                  <div key={mailbox.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {/* no celular o endereço ocupa a linha e os botões descem */}
                    <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                      <p className="break-all font-medium">{mailbox.id}</p>
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
                        <Settings2 className="h-4 w-4" />
                      )}
                      Configurar no app
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setTestingFrom(mailbox.id)}
                    >
                      <Send className="h-4 w-4" /> Testar envio
                    </Button>
                    {mailbox.kind !== "project" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setChangingPassword(mailbox.id)}
                      >
                        <KeyRound className="h-4 w-4" /> Trocar senha
                      </Button>
                    )}
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

      {credentials && (
        <CredentialsModal
          credentials={credentials}
          canChangePassword={mailboxes.find((m) => m.id === credentials.email)?.kind !== "project"}
          onChangePassword={() => {
            setChangingPassword(credentials.email);
            setCredentials(null);
          }}
          onClose={() => setCredentials(null)}
        />
      )}
      {changingPassword && (
        <ChangePasswordModal
          email={changingPassword}
          onClose={() => setChangingPassword(null)}
          onDone={(email) => {
            setChangingPassword(null);
            setChangedMailbox(email);
            setNotice(
              `Senha de ${email} trocada. Atualize a senha no app de e-mail onde a caixa estiver configurada. Para confirmar, envie um e-mail de teste a partir dela.`,
            );
          }}
        />
      )}
      {testingFrom && <TestEmailModal domain={checklist.domain} from={testingFrom} onClose={() => setTestingFrom(null)} />}
    </div>
  );
}
