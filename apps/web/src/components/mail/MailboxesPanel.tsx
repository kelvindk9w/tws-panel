/**
 * Caixas de um domínio de e-mail: lista, criar caixa (a pessoa define a
 * senha e repete; mínimo de MAILBOX_PASSWORD_MIN), "Configurar no app",
 * "Testar envio", "Trocar senha" e remover.
 *
 * Usado na aba Caixas da página do domínio (/mail/:domain) e na aba Caixas
 * da seção E-mail do projeto, que passa `highlight` com a caixa do projeto
 * (pedido do dono do produto, 03/10/2026). Carrega os próprios dados a
 * partir de `domain`.
 */
import { useCallback, useEffect, useState } from "react";
import { MAILBOX_PASSWORD_MIN } from "@paas/core";
import type {
  Mailbox,
  MailboxCredentials,
  MailboxCredentialsResponse,
  MailboxListResponse,
  MailboxResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/mail/CopyButton";
import { TestEmailModal } from "@/components/mail/TestEmailCard";
import { Inbox, KeyRound, Loader2, MailPlus, Send, Settings2, Trash2, X } from "lucide-react";

// ---------------------------------------------------------------------------
// Modais (credenciais e troca de senha)
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
  projectMailbox = false,
  onClose,
  onDone,
}: {
  email: string;
  /** Caixa usada por um projeto: a senha nova só chega a ele no próximo deploy. */
  projectMailbox?: boolean;
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
          {projectMailbox && " O projeto que envia por esta caixa só recebe a senha nova no próximo deploy."}
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
// Painel
// ---------------------------------------------------------------------------

export function MailboxesPanel({
  domain,
  highlight,
  onMailboxesChange,
}: {
  /** Domínio de e-mail cujas caixas o painel mostra. */
  domain: string;
  /** Endereço a destacar (a caixa do projeto, na seção E-mail do projeto). */
  highlight?: string | null;
  /** Avisa quem usa o painel a cada carga (a página mostra "Caixas (n)"). */
  onMailboxesChange?: (mailboxes: Mailbox[]) => void;
}) {
  const name = domain;
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!name) return;
    try {
      const res = await apiFetch<MailboxListResponse>(`/api/mail/domains/${encodeURIComponent(name)}/mailboxes`);
      setMailboxes(res.mailboxes);
      onMailboxesChange?.(res.mailboxes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar as caixas.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  if (!mailboxes) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? "Carregando…"}
      </p>
    );
  }

  return (
    <>
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
          {error && <p className="text-sm text-destructive">{error}</p>}
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
                @{domain}
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
                <div
                  key={mailbox.id}
                  data-mailbox={mailbox.id}
                  data-highlight={mailbox.id === highlight ? "true" : undefined}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3",
                    mailbox.id === highlight && "bg-sky-500/10",
                  )}
                >
                  <Inbox
                    className={cn("h-4 w-4 shrink-0", mailbox.id === highlight ? "text-sky-400" : "text-muted-foreground")}
                  />
                  {/* no celular o endereço ocupa a linha e os botões descem */}
                  <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                    <p className="break-all font-medium">{mailbox.id}</p>
                    {mailbox.id === highlight && (
                      <Badge variant="outline" className="mt-0.5 border-sky-500/40 text-sky-300">
                        deste projeto
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {mailbox.kind === "system"
                        ? "sistema (postmaster/abuse)"
                        : mailbox.kind === "project"
                          ? "caixa do projeto (o projeto envia por ela)"
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setChangingPassword(mailbox.id)}
                  >
                    <KeyRound className="h-4 w-4" /> Trocar senha
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
      {credentials && (
        <CredentialsModal
          credentials={credentials}
          canChangePassword
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
          projectMailbox={mailboxes.find((m) => m.id === changingPassword)?.kind === "project"}
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
      {testingFrom && <TestEmailModal domain={domain} from={testingFrom} onClose={() => setTestingFrom(null)} />}
    </>
  );
}
