/**
 * E-mail do projeto (seção E-mail da página do projeto).
 *
 * O endereço de envio escolhido (padrão <slug>@<domínio>) É a caixa do
 * projeto: o painel a cria com a senha que a pessoa digita (ou gera uma
 * forte e mostra uma vez) e entrega ao projeto, no próximo deploy,
 * SMTP_HOST/PORT/USER/PASS, MAIL_FROM e MAIL_FROM_NAME. A pessoa pode abrir
 * a caixa num app de e-mail ("Configurar no app") e trocar a senha.
 * Validação real (02/10/2026): antes o endereço era só um alias de uma
 * caixa técnica sem senha visível — ninguém conseguia ler as respostas.
 *
 * Também: cadastrar ali mesmo o domínio do projeto ("Usar um domínio meu",
 * já preenchido), copiar cada valor e ligar os valores a outras variáveis
 * do app ("Ligar às variáveis do projeto").
 *
 * Com o e-mail ativado, o card tem abas (pedido do dono do produto,
 * 03/10/2026): Remetente (o conteúdo acima), Caixas e DNS do domínio do
 * projeto — os mesmos painéis da página do domínio, para conferir,
 * configurar e criar caixas (ex.: suporte@) sem sair do projeto. Cada aba
 * tem endereço próprio: ?email=caixas e ?email=dns.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  ExistingMailboxMode,
  MailboxResponse,
  MailDomainListResponse,
  MailDomainSummary,
  ProjectEmailConfig,
  ProjectEmailMailboxesResponse,
  ProjectEmailResponse,
  ProjectEmailUsableMailbox,
} from "@paas/core";
import type { ExistingMailInfo } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { apiErrorText, t as tGlobal, Trans, useI18n, type Key } from "@/i18n";
import { EmailLinksModal } from "@/components/project/EmailLinksModal";
import { MailboxAppSettings } from "@/components/project/MailboxAppSettings";
import {
  EMPTY_PASSWORD_CHOICE,
  GeneratedPasswordNotice,
  PasswordChoice,
  passwordChoiceProblem,
  type PasswordChoiceState,
} from "@/components/mail/MailboxPasswordChoice";
import { ExistingMailWarning } from "@/components/mail/ExistingMailWarning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { TestEmailModal } from "@/components/mail/TestEmailCard";
import { MailboxesPanel } from "@/components/mail/MailboxesPanel";
import { DisplayNameField, displayNameProblem } from "@/components/mail/DisplayNameField";
import { DnsChecklistPanel } from "@/components/mail/DnsChecklistPanel";
import { ProjectEmailHealth } from "@/components/project/ProjectEmailHealth";
import { cn } from "@/lib/utils";
import { MAILBOX_PASSWORD_MIN, sanitizeDisplayName } from "@paas/core";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Smartphone,
} from "lucide-react";

/** Abas do e-mail ativado; o valor vai na URL (?email=caixas, ?email=dns). */
type EmailTab = "remetente" | "caixas" | "dns";
const EMAIL_TABS: ReadonlyArray<readonly [EmailTab, Key]> = [
  ["remetente", "mail.project.tab.sender"],
  ["caixas", "mail.project.tab.mailboxes"],
  ["dns", "mail.project.tab.dns"],
];

function tabFromParam(value: string | null): EmailTab {
  return value === "caixas" || value === "dns" ? value : "remetente";
}

function dnsReady(domain: MailDomainSummary | undefined): boolean {
  return Boolean(domain?.lastVerify && domain.lastVerify.ok >= domain.lastVerify.total);
}

function dnsLabel(domain: MailDomainSummary): string {
  if (!domain.lastVerify) return tGlobal("mail.project.dns.notVerified");
  return dnsReady(domain)
    ? tGlobal("mail.project.dns.ok", { ok: domain.lastVerify.ok, total: domain.lastVerify.total })
    : tGlobal("mail.project.dns.pending");
}

/** Erro da API: ao aparecer, recebe o foco e entra na tela (o cartão é longo e o botão fica longe do topo). */
function FocusedAlert({ children }: { children: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: "center" });
  }, [children]);
  return (
    <p ref={ref} role="alert" tabIndex={-1} className="text-sm text-destructive outline-none [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}

/** Como o projeto passa a ter a senha da caixa que já existia: informa a atual, mantém a guardada ou troca. */
function ExistingMailboxPasswordSection({
  help,
  empty,
  box,
  mode,
  onMode,
  password,
  onPassword,
}: {
  help: string;
  empty: boolean;
  box: ProjectEmailUsableMailbox | undefined;
  mode: ExistingMailboxMode;
  onMode: (mode: ExistingMailboxMode) => void;
  password: string;
  onPassword: (value: string) => void;
}) {
  const { t } = useI18n();
  const group = useId();
  const short = password !== "" && password.trim().length < MAILBOX_PASSWORD_MIN;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{help}</p>
      {empty && (
        <p role="status" data-testid="existing-empty" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {t("mail.project.existing.empty")}
        </p>
      )}
      {box && (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 shrink-0" /> {t("mail.project.existing.passwordLegend", { address: box.address })}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={group} checked={mode === "current_password"} onChange={() => onMode("current_password")} />
            {t("mail.project.existing.mode.current")}
          </label>
          {box.passwordKnown && (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={group} checked={mode === "keep_password"} onChange={() => onMode("keep_password")} />
              {t("mail.project.existing.mode.keep")}
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={group} checked={mode === "replace_password"} onChange={() => onMode("replace_password")} />
            {t("mail.project.existing.mode.replace")}
          </label>
          {mode === "current_password" && (
            <div className="flex flex-col gap-1">
              <PasswordInput
                aria-label={t("mail.project.existing.currentLabel")}
                placeholder={t("mail.project.existing.currentLabel")}
                autoComplete="off"
                value={password}
                onChange={(e) => onPassword(e.target.value)}
              />
              {short && <p className="text-xs text-red-300">{t("mail.password.tooShort", { min: MAILBOX_PASSWORD_MIN })}</p>}
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("mail.project.existing.currentHint")}</p>
            </div>
          )}
          {mode === "keep_password" && (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("mail.project.existing.keepHint")}</p>
          )}
          {mode === "replace_password" && (
            <p
              data-testid="replace-warning"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 [overflow-wrap:anywhere]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("mail.project.existing.replaceWarning")}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("mail.project.existing.managedNote")}</p>
        </fieldset>
      )}
    </div>
  );
}

export function ProjectEmailCard({
  projectId,
  projectName,
  projectSlug,
  projectDomain,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  /** Domínio do site do projeto: sugestão para o domínio de e-mail. */
  projectDomain?: string;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState<ProjectEmailConfig | null>(null);
  const [domains, setDomains] = useState<MailDomainSummary[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [fromName, setFromName] = useState("");
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [passwordChoice, setPasswordChoice] = useState<PasswordChoiceState>(EMPTY_PASSWORD_CHOICE);
  /** Senha gerada pelo painel: aparece uma vez, até a pessoa dizer que guardou. */
  const [generated, setGenerated] = useState<string | null>(null);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [linking, setLinking] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // cadastro do domínio do próprio projeto
  const [adding, setAdding] = useState(false);
  // já vem com o domínio do projeto (editável)
  const [newDomain, setNewDomain] = useState(projectDomain ?? "");
  const [existingMail, setExistingMail] = useState<{ domain: string; info: ExistingMailInfo } | null>(null);
  /** Domínio recém-cadastrado aqui: mostra o próximo passo (DNS e verificar). */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  // "Usar uma caixa que já existe" em vez de criar uma
  const [source, setSource] = useState<"new" | "existing">("new");
  /** Caixas usáveis do domínio escolhido; null = carregando. */
  const [usable, setUsable] = useState<ProjectEmailUsableMailbox[] | null>(null);
  const [usableError, setUsableError] = useState<string | null>(null);
  const [pickedBox, setPickedBox] = useState("");
  const [existingMode, setExistingMode] = useState<ExistingMailboxMode>("current_password");
  const [currentPassword, setCurrentPassword] = useState("");
  /** A senha da caixa existente foi aceita sem o servidor de e-mail conseguir conferi-la. */
  const [unverified, setUnverified] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParam(searchParams.get("email"));

  function openTab(next: EmailTab) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "remetente") params.delete("email");
        else params.set("email", next);
        return params;
      },
      { replace: true },
    );
  }

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`);
      setEmail(res.email);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.loadError"));
    }
  }, [projectId]);

  const loadDomains = useCallback(async (select?: string) => {
    try {
      const res = await apiFetch<MailDomainListResponse>("/api/mail/domains");
      setDomains(res.domains);
      setSelectedDomain((prev) => select ?? (prev || res.domains[0]?.name || ""));
    } catch {
      // sem a lista, o card mostra só o cadastro
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadDomains();
  }, [refresh, loadDomains]);

  // lista as caixas do domínio escolhido que o projeto pode usar
  useEffect(() => {
    if (source !== "existing" || !selectedDomain) return;
    let cancelled = false;
    setUsable(null);
    setUsableError(null);
    setPickedBox("");
    apiFetch<ProjectEmailMailboxesResponse>(
      `/api/projects/${projectId}/email/mailboxes?domain=${encodeURIComponent(selectedDomain)}`,
    )
      .then((res) => {
        if (!cancelled) setUsable(res.mailboxes);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUsable([]);
        setUsableError(apiErrorText(err, "mail.project.existing.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [source, selectedDomain, projectId]);

  function pickMailbox(address: string) {
    setPickedBox(address);
    setCurrentPassword("");
    // o painel já sabe a senha: o caminho mais curto é mantê-la
    const box = usable?.find((m) => m.address === address);
    setExistingMode(box?.passwordKnown ? "keep_password" : "current_password");
  }

  async function addDomain(name = newDomain.trim().toLowerCase(), confirmExistingMail = false) {
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/mail/domains", {
        method: "POST",
        body: JSON.stringify(confirmExistingMail ? { domain: name, confirmExistingMail: true } : { domain: name }),
      });
      setExistingMail(null);
      setAdding(false);
      setNewDomain(projectDomain ?? "");
      setJustAdded(name);
      await loadDomains(name);
    } catch (err) {
      const info =
        err instanceof ApiRequestError && err.code === "domain_receives_mail"
          ? (err.data?.existingMail as ExistingMailInfo | undefined)
          : undefined;
      if (info) setExistingMail({ domain: name, info });
      else setError(apiErrorText(err, "mail.project.addDomainError"));
    } finally {
      setBusy(false);
    }
  }

  async function verifyDomain(name: string) {
    setVerifying(true);
    setError(null);
    try {
      await apiFetch(`/api/mail/domains/${encodeURIComponent(name)}/verify`, { method: "POST" });
      await loadDomains(name);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.verifyError"));
    } finally {
      setVerifying(false);
    }
  }

  function startEditing(current: ProjectEmailConfig) {
    setSelectedDomain(current.domain ?? selectedDomain);
    const local = current.mailFrom?.split("@")[0] ?? "";
    // o padrão (<slug>@) fica em branco, como na ativação
    setFromLocal(local === projectSlug ? "" : local);
    setFromName(current.fromName ?? "");
    setPasswordChoice(EMPTY_PASSWORD_CHOICE);
    setEditing(true);
    setSaved(false);
    setUnverified(false);
    setSource("new");
    setChangingPassword(false);
  }

  async function saveExisting() {
    const box = usable?.find((m) => m.address === pickedBox);
    if (!box) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        domain: selectedDomain,
        fromLocalPart: box.localPart,
        useExistingMailbox: existingMode,
      };
      // Só o que a pessoa DIGITOU de novo: o nome já guardado (que o formulário traz preenchido) não conta, para
      // que o nome que a caixa escolhida já tem prevaleça (sem nenhum, vale o nome do projeto).
      if (fromName.trim() && fromName.trim() !== (email?.fromName ?? "")) body.fromName = fromName.trim();
      if (existingMode === "current_password") body.password = currentPassword;
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setEmail(res.email);
      setGenerated(res.generatedPassword ?? null);
      setUnverified(res.passwordVerified === false);
      setCurrentPassword("");
      setSource("new");
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.existing.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { domain: selectedDomain };
      if (fromLocal.trim()) body.fromLocalPart = fromLocal.trim();
      if (fromName.trim()) body.fromName = fromName.trim();
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`, {
        method: "POST",
        body: JSON.stringify(withPassword(body)),
      });
      setEmail(res.email);
      setGenerated(res.generatedPassword ?? null);
      setPasswordChoice(EMPTY_PASSWORD_CHOICE);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.saveError"));
    } finally {
      setBusy(false);
    }
  }

  /** A senha vai junto só quando a caixa é nova (ou a pessoa pediu para trocar). */
  function withPassword(body: Record<string, string>): Record<string, string | boolean> {
    if (!needsPassword) return body;
    return passwordChoice.mode === "generate"
      ? { ...body, generatePassword: true }
      : { ...body, password: passwordChoice.password };
  }

  async function changePassword(mailbox: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<MailboxResponse>(`/api/mail/mailboxes/${encodeURIComponent(mailbox)}/password`, {
        method: "PUT",
        body: JSON.stringify(
          passwordChoice.mode === "generate" ? { generate: true } : { password: passwordChoice.password },
        ),
      });
      setGenerated(res.generatedPassword ?? null);
      setPasswordChoice(EMPTY_PASSWORD_CHOICE);
      setChangingPassword(false);
      setPasswordChanged(true);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.passwordError"));
    } finally {
      setBusy(false);
    }
  }

  async function copyValue(key: string, value: string) {
    if (await copyText(value)) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1500);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`, { method: "DELETE" });
      setEmail(res.email);
      setSaved(false);
    } catch (err) {
      setError(apiErrorText(err, "mail.project.disableError"));
    } finally {
      setBusy(false);
    }
  }

  if (!email) return null;

  const domain = domains.find((d) => d.name === selectedDomain);
  const previewAddress = `${fromLocal.trim().toLowerCase() || projectSlug}@${selectedDomain}`;
  // a mesma limpeza do servidor: é isto que será gravado e entregue
  const defaultName = sanitizeDisplayName(projectName);
  const previewName = sanitizeDisplayName(fromName) || defaultName;
  // e-mail ativado: abas Remetente, Caixas e DNS do domínio do projeto
  const tabbed = email.enabled && Boolean(email.domain);
  const activeTab: EmailTab = tabbed ? tab : "remetente";
  const onSender = activeTab === "remetente";
  const showForm = onSender && (!email.enabled || editing);
  // Caixa nova (ativação, endereço trocado ou registro antigo com alias) pede a senha.
  const needsPassword = !email.enabled || previewAddress !== email.mailbox;
  const passwordProblem = needsPassword ? passwordChoiceProblem(passwordChoice) : null;
  const links = Object.entries(email.envLinks ?? {});
  const existingReady =
    pickedBox !== "" && (existingMode !== "current_password" || currentPassword.trim().length >= MAILBOX_PASSWORD_MIN);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" /> {t("mail.project.title")}
          </CardTitle>
          <Badge variant={email.enabled ? "success" : "secondary"}>{email.enabled ? t("mail.project.enabled") : t("mail.project.disabled")}</Badge>
        </div>
        <CardDescription>
          {t("mail.project.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <FocusedAlert>{error}</FocusedAlert>}

        {generated && <GeneratedPasswordNotice password={generated} onDone={() => setGenerated(null)} />}

        {unverified && (
          <p
            role="status"
            data-testid="password-unverified"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 [overflow-wrap:anywhere]"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("mail.project.existing.unverified")}</span>
          </p>
        )}

        {tabbed && email.domain && (
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b">
            <div role="tablist" aria-label={t("mail.project.tablistAria")} className="flex gap-1">
              {EMAIL_TABS.map(([key, labelKey]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`email-tab-${key}`}
                  aria-selected={activeTab === key}
                  onClick={() => openTab(key)}
                  className={cn(
                    "-mb-px border-b-2 px-3 py-2 text-sm transition-colors sm:px-4",
                    activeTab === key
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <Link
              to={`/mail/${encodeURIComponent(email.domain)}${activeTab === "dns" ? "?aba=dns" : ""}`}
              className="mb-2 flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {t("mail.project.openMailPage")}
            </Link>
          </div>
        )}

        {tabbed && email.domain && activeTab === "remetente" && <ProjectEmailHealth domain={email.domain} />}

        {tabbed && email.domain && activeTab === "caixas" && (
          <div role="tabpanel" aria-labelledby="email-tab-caixas" className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t("mail.project.mailboxesIntro", { domain: email.domain })}
            </p>
            <MailboxesPanel domain={email.domain} projectId={projectId} highlight={email.mailbox} />
          </div>
        )}

        {tabbed && email.domain && activeTab === "dns" && (
          <div role="tabpanel" aria-labelledby="email-tab-dns" className="flex flex-col gap-4">
            <DnsChecklistPanel domain={email.domain} />
          </div>
        )}

        {showForm && domains.length === 0 && (
          <p className="text-sm text-muted-foreground">
            <Trans
              k="mail.project.noDomains"
              components={{
                link: (children) => (
                  <Link to="/mail" className="text-foreground underline">
                    {children}
                  </Link>
                ),
              }}
            />
          </p>
        )}

        {showForm && (adding || domains.length === 0) && (
          <div className="flex flex-col gap-2 rounded-lg border border-sky-500/30 p-3 sm:p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4" /> {t("mail.project.ownDomain.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("mail.project.ownDomain.description")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={t("mail.project.ownDomain.aria")}
                placeholder={t("mail.project.ownDomain.placeholder")}
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addDomain()}
                className="min-w-0 flex-1 sm:max-w-xs"
              />
              <Button variant="info" size="sm" disabled={busy || !newDomain.trim()} onClick={() => void addDomain()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t("mail.project.ownDomain.register")}
              </Button>
              {domains.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  {t("mail.common.cancel")}
                </Button>
              )}
            </div>
            {existingMail && (
              <ExistingMailWarning
                domain={existingMail.domain}
                info={existingMail.info}
                busy={busy}
                onUseSuggested={() => void addDomain(existingMail.info.suggestedDomain)}
                onConfirm={() => void addDomain(existingMail.domain, true)}
                onCancel={() => setExistingMail(null)}
              />
            )}
          </div>
        )}

        {showForm && domains.length > 0 && (
          <div className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("mail.project.domainLabel")}</span>
              <select
                value={selectedDomain}
                onChange={(e) => setSelectedDomain(e.target.value)}
                className="h-9 w-full max-w-md rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {domains.map((d) => (
                  <option key={d.name} value={d.name} className="bg-background">
                    {d.name} — {dnsLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            {!adding && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4" /> {t("mail.project.useMyDomain")}
                </Button>
              </div>
            )}
            {domain && justAdded === domain.name && !dnsReady(domain) && (
              <div className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
                <p className="font-medium">{t("mail.project.added.title", { domain: domain.name })}</p>
                <p className="text-muted-foreground">
                  {t("mail.project.added.description", { domain: domain.name })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="info" size="sm" asChild>
                    <Link to={`/mail/${encodeURIComponent(domain.name)}?aba=dns`}>
                      <ExternalLink className="h-4 w-4" /> {t("mail.project.added.viewRecords")}
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" disabled={verifying} onClick={() => void verifyDomain(domain.name)}>
                    {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t("mail.dns.verifyNow")}
                  </Button>
                </div>
              </div>
            )}
            {domain && justAdded !== domain.name && !dnsReady(domain) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <Trans
                    k="mail.project.dnsWarning"
                    components={{
                      link: (children) => (
                        <Link to={`/mail/${encodeURIComponent(domain.name)}`} className="underline">
                          {children}
                        </Link>
                      ),
                    }}
                  />
                </span>
              </div>
            )}
            <fieldset className="flex min-w-0 flex-col gap-1.5 text-sm">
              <legend className="mb-1">{t("mail.project.source.legend")}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="email-source" checked={source === "new"} onChange={() => setSource("new")} />
                {t("mail.project.source.new")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="email-source" checked={source === "existing"} onChange={() => setSource("existing")} />
                {t("mail.project.source.existing")}
              </label>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              {source === "existing" ? (
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                  <label htmlFor="existing-mailbox">{t("mail.project.existing.mailboxLabel")}</label>
                  <select
                    id="existing-mailbox"
                    value={pickedBox}
                    disabled={usable === null || usable.length === 0}
                    onChange={(e) => pickMailbox(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="" className="bg-background">
                      {usable === null ? t("mail.project.existing.loading") : t("mail.project.existing.choose")}
                    </option>
                    {(usable ?? []).map((m) => (
                      <option key={m.address} value={m.address} className="bg-background">
                        {m.address}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
              <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span>{t("mail.project.fromLabel")}</span>
                <div className="flex min-w-0 items-center">
                  <Input
                    aria-label={t("mail.project.fromLabel")}
                    placeholder={projectSlug}
                    value={fromLocal}
                    onChange={(e) => setFromLocal(e.target.value)}
                    className="w-32 shrink-0 rounded-r-none sm:w-auto sm:min-w-0 sm:flex-1"
                  />
                  <span className="flex h-9 min-w-0 items-center truncate rounded-r-md border border-l-0 bg-secondary px-2 text-xs text-muted-foreground">
                    @{selectedDomain}
                  </span>
                </div>
              </label>
              )}
              <DisplayNameField
                label={t("mail.project.nameLabel")}
                placeholder={defaultName}
                hintKey="mail.displayName.hintProject"
                value={fromName}
                onChange={setFromName}
              />
            </div>
            {source === "existing" && usableError && <FocusedAlert>{usableError}</FocusedAlert>}
            {source === "existing" && (
              <ExistingMailboxPasswordSection
                help={t("mail.project.existing.help")}
                empty={usable !== null && usable.length === 0 && !usableError}
                box={usable?.find((m) => m.address === pickedBox)}
                mode={existingMode}
                onMode={setExistingMode}
                password={currentPassword}
                onPassword={setCurrentPassword}
              />
            )}
            {source === "new" && (
            <>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <Trans
                k="mail.project.preview"
                params={{ preview: `${previewName} <${previewAddress}>`, slug: projectSlug }}
                components={{ span: <span className="text-foreground" /> }}
              />
            </p>
            <p data-testid="mailbox-explain" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <Trans
                k="mail.project.mailboxExplain"
                params={{ address: previewAddress }}
                components={{ span: <span className="text-foreground" /> }}
              />
            </p>
            {email.enabled && email.mailbox && previewAddress !== email.mailbox && (
              <p
                data-testid="old-mailbox-note"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 [overflow-wrap:anywhere]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("mail.project.oldMailboxNote", { address: previewAddress, old: email.mailbox })}
                </span>
              </p>
            )}
            {needsPassword && <PasswordChoice value={passwordChoice} onChange={setPasswordChoice} />}
            </>
            )}
            <div className="flex flex-wrap gap-2">
              {source === "existing" ? (
                <Button
                  variant="success"
                  size="sm"
                  disabled={busy || !selectedDomain || !existingReady || displayNameProblem(fromName) !== null}
                  onClick={() => void saveExisting()}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  {t("mail.project.existing.submit")}
                </Button>
              ) : (
              <Button
                variant="success"
                size="sm"
                disabled={busy || !selectedDomain || passwordProblem !== null || displayNameProblem(fromName) !== null}
                onClick={() => void save()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {email.enabled ? t("mail.project.save") : t("mail.project.activate")}
              </Button>
              )}
              {editing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setSource("new");
                  }}
                >
                  {t("mail.common.cancel")}
                </Button>
              )}
            </div>
          </div>
        )}

        {onSender && email.enabled && !editing && (
          <>
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">{t("mail.project.tab.sender")}</p>
              <p className="font-medium [overflow-wrap:anywhere]">{(email.fromName ?? sanitizeDisplayName(projectName)) ? `${email.fromName ?? sanitizeDisplayName(projectName)} <${email.mailFrom}>` : (email.mailFrom ?? "")}</p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t("mail.project.mailboxLine", { mailbox: email.mailbox ?? "" })}
              </p>
              <p data-testid="from-source" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t("mail.project.fromSource", { address: email.mailFrom ?? "" })}
              </p>
            </div>
            {email.legacyAlias && (
              <p
                data-testid="legacy-alias"
                className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("mail.project.legacyAlias", { from: email.mailFrom ?? "", mailbox: email.mailbox ?? "" })}
                </span>
              </p>
            )}
            <div className="rounded-lg border bg-black/40 p-3 font-mono text-xs">
              {Object.entries(email.env).map(([key, value]) => (
                <div key={key} className="flex min-h-7 items-center justify-between gap-x-2">
                  <span className="shrink-0 text-emerald-300">{key}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="break-all text-right text-muted-foreground">{value}</span>
                    {key === "SMTP_PASS" ? (
                      <span className="w-7 shrink-0" />
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        aria-label={t("mail.project.copyAria", { key })}
                        title={t("mail.project.copyValue")}
                        onClick={() => void copyValue(key, value)}
                      >
                        {copiedKey === key ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {links.length > 0 && (
              <div data-testid="email-links" className="flex flex-col gap-1 text-xs">
                <p className="text-muted-foreground">{t("mail.project.alsoDelivered")}</p>
                <ul className="flex flex-wrap gap-1.5 font-mono">
                  {links.map(([target, source]) => (
                    <li key={target} className="rounded border border-sky-500/30 px-2 py-0.5 text-sky-200">
                      {`${target} ← ${source}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p
              className={
                saved
                  ? "flex items-start gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm"
                  : "flex items-start gap-2 text-xs text-muted-foreground"
              }
            >
              <Rocket className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t("mail.project.deployNote")}
              </span>
            </p>
            <p data-testid="display-name-note" className="text-xs text-muted-foreground">
              {t("mail.project.displayNameNote")}
            </p>
            <p data-testid="email-other-names" className="text-xs text-muted-foreground">
              <Trans k="mail.project.otherNames" components={{ code: <code />, b: <strong /> }} />
            </p>
            {passwordChanged && (
              <p className="flex items-start gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm">
                <Rocket className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("mail.project.passwordChanged")}</span>
              </p>
            )}
            {changingPassword && email.mailbox && (
              <div className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
                <p className="text-sm font-medium [overflow-wrap:anywhere]">{t("mail.project.changePasswordOf", { mailbox: email.mailbox })}</p>
                <PasswordChoice value={passwordChoice} onChange={setPasswordChoice} passwordLabel={t("mail.boxes.changePassword.newLabel")} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="success"
                    size="sm"
                    disabled={busy || passwordChoiceProblem(passwordChoice) !== null}
                    onClick={() => void changePassword(email.mailbox!)}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    {t("mail.project.saveNewPassword")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setChangingPassword(false)}>
                    {t("mail.common.cancel")}
                  </Button>
                </div>
              </div>
            )}
            {showAppSettings && email.mailbox && <MailboxAppSettings mailbox={email.mailbox} />}
            <div className="flex flex-wrap gap-2">
              <Button variant="deploy" size="sm" onClick={() => setTesting(true)}>
                <Send className="h-4 w-4" /> {t("mail.test.title")}
              </Button>
              <Button variant="info" size="sm" onClick={() => setLinking(true)}>
                <Link2 className="h-4 w-4" /> {t("mail.links.title")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowAppSettings((v) => !v)}>
                <Smartphone className="h-4 w-4" /> {t("mail.boxes.configure")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPasswordChoice(EMPTY_PASSWORD_CHOICE);
                  setPasswordChanged(false);
                  setChangingPassword(true);
                }}
              >
                <KeyRound className="h-4 w-4" />
                {t("mail.boxes.changePassword.button")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => startEditing(email)}>
                <Pencil className="h-4 w-4" /> {t("mail.project.editSender")}
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void disable()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("mail.project.disable")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
      {testing && email.domain && email.mailbox && (
        <TestEmailModal domain={email.domain} from={email.mailbox} onClose={() => setTesting(false)} />
      )}
      {linking && (
        <EmailLinksModal projectId={projectId} email={email} onClose={() => setLinking(false)} onSaved={setEmail} />
      )}
    </Card>
  );
}
