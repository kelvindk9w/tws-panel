/**
 * Caixas de um domínio de e-mail: lista, criar caixa (a pessoa define a
 * senha e repete; mínimo de MAILBOX_PASSWORD_MIN), "Configurar no app",
 * "Testar envio", "Trocar senha", "Abrir webmail" (com o webmail ativado) e
 * remover.
 *
 * Usado na aba Caixas da página do domínio (/mail/:domain) e na aba Caixas
 * da seção E-mail do projeto, que passa `highlight` com a caixa do projeto
 * (pedido do dono do produto, 03/10/2026). Carrega os próprios dados a
 * partir de `domain`.
 *
 * Com `projectId` (seção E-mail do projeto), mostra só as caixas daquele
 * projeto — a de envio e as criadas por ali — e a caixa criada fica sendo
 * dele. Sem `projectId` (página do domínio), mostra todas, com o projeto
 * dono de cada uma.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MAILBOX_PASSWORD_MIN, webmailUrl } from "@paas/core";
import type {
  Mailbox,
  MailboxCredentials,
  MailboxCredentialsResponse,
  MailboxListResponse,
  MailboxResponse,
  SetMailboxDisplayNameResponse,
  WebmailStatus,
} from "@paas/core";
import { apiErrorText, formatDateTime, useI18n } from "@/i18n";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DisplayNameField, displayNameProblem } from "@/components/mail/DisplayNameField";
import { CopyButton } from "@/components/mail/CopyButton";
import { TestEmailModal } from "@/components/mail/TestEmailCard";
import {
  EMPTY_PASSWORD_CHOICE,
  GeneratedPasswordNotice,
  PasswordChoice,
  passwordChoiceProblem,
  type PasswordChoiceState,
} from "@/components/mail/MailboxPasswordChoice";
import { ExternalLink, Inbox, KeyRound, Loader2, MailPlus, Pencil, Send, Settings2, Trash2, X } from "lucide-react";

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

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Lido na renderização, antes de qualquer autoFocus do conteúdo: é o botão que abriu o modal.
  const openerRef = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  // Esc fecha; Tab fica dentro do modal; ao fechar, o foco volta ao botão que o abriu.
  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label={t("mail.common.close")} onClick={onClose}>
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
  const { t } = useI18n();
  const [choice, setChoice] = useState<PasswordChoiceState>(EMPTY_PASSWORD_CHOICE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Senha gerada pelo painel: mostrada uma única vez, até "Já guardei". */
  const [generated, setGenerated] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<MailboxResponse>(`/api/mail/mailboxes/${encodeURIComponent(email)}/password`, {
        method: "PUT",
        body: JSON.stringify(choice.mode === "generate" ? { generate: true } : { password: choice.password }),
      });
      if (res.generatedPassword) setGenerated(res.generatedPassword);
      else onDone(email);
    } catch (err) {
      setError(apiErrorText(err, "mail.boxes.changePassword.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={t("mail.boxes.changePassword.title", { email })} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {t("mail.boxes.changePassword.intro")}
          {projectMailbox && t("mail.boxes.changePassword.projectNote")}
        </p>
        {generated ? (
          <GeneratedPasswordNotice password={generated} onDone={() => onDone(email)} />
        ) : (
          <>
            <PasswordChoice value={choice} onChange={setChoice} passwordLabel={t("mail.boxes.changePassword.newLabel")} />
            {error && <p className="text-destructive">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("mail.common.cancel")}
              </Button>
              <Button
                variant="success"
                disabled={saving || passwordChoiceProblem(choice) !== null}
                onClick={() => void save()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t("mail.boxes.changePassword.save")}
              </Button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}

/** "Alterar nome de exibição": só o nome muda (senha, 2FA, senhas de app, apelidos e mensagens ficam). */
function DisplayNameModal({
  mailbox,
  projectId,
  onClose,
  onDone,
}: {
  mailbox: Mailbox;
  /** Aba do projeto: o servidor só aceita caixa daquele projeto. */
  projectId?: string;
  onClose: () => void;
  onDone: (result: SetMailboxDisplayNameResponse) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(mailbox.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = displayNameProblem(value) !== null;
  const unchanged = value.trim() === (mailbox.displayName ?? "");

  async function save() {
    if (invalid || unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<SetMailboxDisplayNameResponse>(
        `/api/mail/mailboxes/${encodeURIComponent(mailbox.id)}/display-name`,
        { method: "PUT", body: JSON.stringify({ displayName: value.trim(), ...(projectId ? { projectId } : {}) }) },
      );
      onDone(res);
    } catch (err) {
      setError(apiErrorText(err, "mail.boxes.editName.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={t("mail.boxes.editName.title", { email: mailbox.id })} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {t("mail.boxes.editName.intro")}
          {mailbox.kind === "project" && ` ${t("mail.boxes.editName.projectNote")}`}
        </p>
        <DisplayNameField
          value={value}
          onChange={setValue}
          disabled={saving}
          onEnter={() => void save()}
          autoFocus
          hintKey={mailbox.kind === "project" ? "mail.displayName.hintProject" : "mail.displayName.hint"}
        />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("mail.common.cancel")}
          </Button>
          <Button variant="success" disabled={saving || invalid || unchanged} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            {t("mail.boxes.editName.save")}
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
  const { t } = useI18n();
  return (
    <ModalShell title={t("mail.boxes.credentials.title", { email: credentials.email })} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("mail.boxes.credentials.account")}</p>
            <CredentialRow label={t("mail.boxes.credentials.user")} value={credentials.username} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{t("mail.boxes.credentials.password")}</span>
              <span className="text-right text-xs text-muted-foreground">
                {t("mail.boxes.credentials.passwordNote")}
              </span>
            </div>
            {canChangePassword && (
              <div>
                <Button variant="outline" size="sm" onClick={onChangePassword}>
                  <KeyRound className="h-4 w-4" /> {t("mail.boxes.changePassword.button")}
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("mail.boxes.credentials.incoming")}
            </p>
            <CredentialRow label={t("mail.boxes.credentials.server")} value={credentials.imap.host} />
            <CredentialRow label={t("mail.boxes.credentials.port")} value={credentials.imap.port} />
            <CredentialRow label={t("mail.boxes.credentials.security")} value="SSL/TLS" mono={false} />
            <p className="text-xs text-muted-foreground">
              {t("mail.boxes.credentials.altStarttls", { port: credentials.imapAlt.port })}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("mail.boxes.credentials.outgoing")}
            </p>
            <CredentialRow label={t("mail.boxes.credentials.server")} value={credentials.smtp.host} />
            <CredentialRow label={t("mail.boxes.credentials.port")} value={credentials.smtp.port} />
            <CredentialRow label={t("mail.boxes.credentials.security")} value="STARTTLS" mono={false} />
            <p className="text-xs text-muted-foreground">
              {t("mail.boxes.credentials.altSsl", { port: credentials.smtpAlt.port })}
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
  projectId,
  highlight,
  onMailboxesChange,
}: {
  /** Domínio de e-mail cujas caixas o painel mostra. */
  domain: string;
  /** Só as caixas deste projeto; a caixa criada aqui fica sendo dele. */
  projectId?: string;
  /** Endereço a destacar (a caixa do projeto, na seção E-mail do projeto). */
  highlight?: string | null;
  /** Avisa quem usa o painel a cada carga (a página mostra "Caixas (n)"). */
  onMailboxesChange?: (mailboxes: Mailbox[]) => void;
}) {
  const { t } = useI18n();
  const name = domain;
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newMailbox, setNewMailbox] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  /** Caixa cujo nome de exibição está sendo alterado (modal). */
  const [editingName, setEditingName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newChoice, setNewChoice] = useState<PasswordChoiceState>(EMPTY_PASSWORD_CHOICE);
  /** Senha gerada na criação: mostrada uma única vez, até "Já guardei". */
  const [generated, setGenerated] = useState<{ email: string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<MailboxCredentials | null>(null);
  const [changingPassword, setChangingPassword] = useState<string | null>(null);
  /** Caixa cujo envio está sendo testado (modal). */
  const [testingFrom, setTestingFrom] = useState<string | null>(null);
  /** Caixa da senha recém-trocada: o aviso oferece testar o envio dela. */
  const [changedMailbox, setChangedMailbox] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** mail.<domínio> do webmail, quando ativado e no ar (botão "Abrir webmail" de cada caixa). */
  const [webmailHost, setWebmailHost] = useState<string | null>(null);


  const refresh = useCallback(async () => {
    if (!name) return;
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const res = await apiFetch<MailboxListResponse>(`/api/mail/domains/${encodeURIComponent(name)}/mailboxes${query}`);
      setMailboxes(res.mailboxes);
      onMailboxesChange?.(res.mailboxes);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "mail.boxes.loadError"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    apiFetch<WebmailStatus>("/api/mail/webmail")
      .then((webmail) => {
        const link = webmail.enabled && webmail.running ? webmail.links?.find((l) => l.domain === name) : undefined;
        if (alive) setWebmailHost(link?.host ?? null);
      })
      .catch(() => {
        if (alive) setWebmailHost(null);
      });
    return () => {
      alive = false;
    };
  }, [name]);

  async function addMailbox() {
    const local = newMailbox.trim();
    if (!local || passwordChoiceProblem(newChoice) !== null || displayNameProblem(newDisplayName) !== null) return;
    setBusy("add");
    setError(null);
    try {
      const res = await apiFetch<MailboxResponse>(
        `/api/mail/domains/${encodeURIComponent(name)}/mailboxes`,
        {
          method: "POST",
          body: JSON.stringify({
            localPart: local,
            ...(newChoice.mode === "generate" ? { generatePassword: true } : { password: newChoice.password }),
            ...(projectId ? { projectId } : {}),
            ...(newDisplayName.trim() ? { displayName: newDisplayName.trim() } : {}),
          }),
        },
      );
      setNewMailbox("");
      setNewDisplayName("");
      setNewChoice(EMPTY_PASSWORD_CHOICE);
      setChangedMailbox(null);
      if (res.generatedPassword) {
        setGenerated({ email: res.mailbox.id, password: res.generatedPassword });
        setNotice(t("mail.boxes.created", { email: res.mailbox.id }));
      } else {
        setNotice(t("mail.boxes.createdWithPassword", { email: res.mailbox.id }));
      }
      await refresh();
    } catch (err) {
      setError(apiErrorText(err, "mail.boxes.createError"));
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
      setError(apiErrorText(err, "mail.boxes.credentialsError"));
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
      setError(apiErrorText(err, "mail.boxes.removeError"));
    } finally {
      setBusy(null);
    }
  }

  if (!mailboxes) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? t("mail.common.loading")}
      </p>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="px-4 pb-2 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base">
            <Inbox className="h-4 w-4" /> {t("mail.boxes.title")}
          </CardTitle>
          <CardDescription>
            {projectId && t("mail.boxes.descriptionProject")}
            {t("mail.boxes.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4 sm:px-6">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col gap-2 rounded-lg border p-3 sm:p-4">
            <p className="text-sm font-medium">{t("mail.boxes.new")}</p>
            <div className="flex min-w-0 max-w-md items-center">
              <Input
                placeholder={t("mail.boxes.newPlaceholder")}
                value={newMailbox}
                onChange={(e) => setNewMailbox(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addMailbox()}
                className="min-w-[4.5rem] flex-1 rounded-r-none"
              />
              <span className="flex h-9 min-w-0 max-w-[75%] shrink-0 items-center overflow-hidden whitespace-nowrap rounded-r-md border border-l-0 bg-secondary px-3 text-sm text-muted-foreground" title={`@${domain}`}>
                @{domain}
              </span>
            </div>
            <div className="max-w-md">
              <DisplayNameField value={newDisplayName} onChange={setNewDisplayName} disabled={busy !== null} />
            </div>
            <div className="max-w-md">
              <PasswordChoice value={newChoice} onChange={setNewChoice} />
            </div>
            {newChoice.mode === "type" && (
              <p className="text-xs text-muted-foreground">
                {t("mail.boxes.passwordHint", { min: MAILBOX_PASSWORD_MIN })}
              </p>
            )}
            <div>
              <Button
                size="sm"
                disabled={
                  busy !== null ||
                  !newMailbox.trim() ||
                  passwordChoiceProblem(newChoice) !== null ||
                  displayNameProblem(newDisplayName) !== null
                }
                onClick={() => void addMailbox()}
              >
                {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
                {t("mail.boxes.create")}
              </Button>
            </div>
          </div>

          {generated && (
            <GeneratedPasswordNotice password={generated.password} onDone={() => setGenerated(null)} />
          )}

          {notice && (
            <div className="flex items-start justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
              <div className="flex min-w-0 flex-col items-start gap-2">
                <span className="break-words">{notice}</span>
                {changedMailbox && (
                  <Button variant="deploy" size="sm" onClick={() => setTestingFrom(changedMailbox)}>
                    <Send className="h-4 w-4" /> {t("mail.boxes.sendTest")}
                  </Button>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("mail.boxes.closeNotice")}
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
            <p className="text-sm text-muted-foreground">
              {projectId ? t("mail.boxes.emptyProject") : t("mail.boxes.emptyDomain")}
            </p>
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
                  {/* no celular (ou num espaço estreito, como no card do projeto) o endereço
                      ocupa a linha e os botões descem */}
                  <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:min-w-[16rem] sm:basis-0">
                    <p className="break-all font-medium">{mailbox.id}</p>
                    <p
                      data-testid={`display-name-${mailbox.id}`}
                      className={cn("break-words text-sm", mailbox.displayName ? "" : "text-xs text-muted-foreground")}
                    >
                      {mailbox.displayName
                        ? t("mail.boxes.displayNameLine", { name: mailbox.displayName })
                        : t("mail.boxes.noDisplayName")}
                    </p>
                    {mailbox.id === highlight && (
                      <Badge variant="outline" className="mt-0.5 border-sky-500/40 text-sky-300">
                        {t("mail.boxes.thisProject")}
                      </Badge>
                    )}
                    {/* página do domínio: de qual projeto a caixa é */}
                    {!projectId && mailbox.projectId && (
                      <Badge variant="outline" className="mt-0.5 max-w-full whitespace-normal break-words">
                        {mailbox.projectName ? t("mail.boxes.ofProject", { name: mailbox.projectName }) : t("mail.boxes.ofRemovedProject")}
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {mailbox.kind === "system"
                        ? t("mail.boxes.kindSystem")
                        : mailbox.kind === "project"
                          ? t("mail.boxes.kindProject")
                          : t("mail.boxes.createdAt", { date: formatDateTime(mailbox.createdAt) })}
                    </p>
                    {mailbox.passwordUnknown && (
                      <p className="text-xs text-amber-400">{t("mail.boxes.passwordUnknown")}</p>
                    )}
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
                    {t("mail.boxes.configure")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setTestingFrom(mailbox.id)}
                  >
                    <Send className="h-4 w-4" /> {t("mail.boxes.testSend")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    aria-label={t("mail.boxes.editName.aria", { email: mailbox.id })}
                    onClick={() => setEditingName(mailbox.id)}
                  >
                    <Pencil className="h-4 w-4" /> {t("mail.boxes.editName.button")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setChangingPassword(mailbox.id)}
                  >
                    <KeyRound className="h-4 w-4" /> {t("mail.boxes.changePassword.button")}
                  </Button>
                  {webmailHost && (
                    // usuário preenchido pela URL; a senha a pessoa digita (nunca vai na URL)
                    <Button variant="info" size="sm" asChild>
                      <a href={webmailUrl(webmailHost, mailbox.id)} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" /> {t("mail.webmail.open")}
                      </a>
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
                          {busy === `rm-${mailbox.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : t("mail.common.confirm")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                          {t("mail.common.cancel")}
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
            setNotice(t("mail.boxes.passwordChanged", { email }));
          }}
        />
      )}
      {editingName && mailboxes.find((m) => m.id === editingName) && (
        <DisplayNameModal
          mailbox={mailboxes.find((m) => m.id === editingName)!}
          {...(projectId ? { projectId } : {})}
          onClose={() => setEditingName(null)}
          onDone={(res) => {
            setEditingName(null);
            setChangedMailbox(null);
            setGenerated(null);
            setNotice(
              t(res.mailbox.displayName ? "mail.boxes.editName.done" : "mail.boxes.editName.removed", { email: res.mailbox.id }) +
                (res.projectEmail ? t("mail.boxes.editName.deployNote") : ""),
            );
            void refresh();
          }}
        />
      )}
      {testingFrom && <TestEmailModal domain={domain} from={testingFrom} onClose={() => setTestingFrom(null)} />}
    </>
  );
}
