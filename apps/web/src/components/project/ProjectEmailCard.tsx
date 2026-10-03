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
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  MailboxResponse,
  MailDomainListResponse,
  MailDomainSummary,
  ProjectEmailConfig,
  ProjectEmailResponse,
} from "@paas/core";
import type { ExistingMailInfo } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { EmailLinksModal } from "@/components/project/EmailLinksModal";
import { MailboxAppSettings } from "@/components/project/MailboxAppSettings";
import {
  EMPTY_PASSWORD_CHOICE,
  GeneratedPasswordNotice,
  PasswordChoice,
  passwordChoiceProblem,
  type PasswordChoiceState,
} from "@/components/project/MailboxPasswordChoice";
import { ExistingMailWarning } from "@/components/mail/ExistingMailWarning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TestEmailModal } from "@/components/mail/TestEmailCard";
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

function dnsReady(domain: MailDomainSummary | undefined): boolean {
  return Boolean(domain?.lastVerify && domain.lastVerify.ok >= domain.lastVerify.total);
}

function dnsLabel(domain: MailDomainSummary): string {
  if (!domain.lastVerify) return "DNS não verificado";
  return dnsReady(domain) ? `DNS ${domain.lastVerify.ok}/${domain.lastVerify.total} OK` : "DNS com pendências";
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

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`);
      setEmail(res.email);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o e-mail do projeto.");
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
      else setError(err instanceof Error ? err.message : "Falha ao cadastrar o domínio.");
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
      setError(err instanceof Error ? err.message : "Falha ao verificar o DNS.");
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
    setChangingPassword(false);
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
      setError(err instanceof Error ? err.message : "Falha ao salvar o e-mail do projeto.");
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
      setError(err instanceof Error ? err.message : "Falha ao trocar a senha.");
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
      setError(err instanceof Error ? err.message : "Falha ao desativar o e-mail do projeto.");
    } finally {
      setBusy(false);
    }
  }

  if (!email) return null;

  const domain = domains.find((d) => d.name === selectedDomain);
  const previewAddress = `${fromLocal.trim().toLowerCase() || projectSlug}@${selectedDomain}`;
  const previewName = fromName.trim() || projectName;
  const showForm = !email.enabled || editing;
  // Caixa nova (ativação, endereço trocado ou registro antigo com alias) pede a senha.
  const needsPassword = !email.enabled || previewAddress !== email.mailbox;
  const passwordProblem = needsPassword ? passwordChoiceProblem(passwordChoice) : null;
  const links = Object.entries(email.envLinks ?? {});

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" /> E-mail do projeto
          </CardTitle>
          <Badge variant={email.enabled ? "success" : "secondary"}>{email.enabled ? "ativado" : "desativado"}</Badge>
        </div>
        <CardDescription>
          O painel cria a caixa de e-mail do projeto no endereço que você escolher e entrega os dados de envio (SMTP_* e
          MAIL_FROM) no próximo deploy. Você também pode abrir essa caixa num app de e-mail para ler as respostas.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {generated && <GeneratedPasswordNotice password={generated} onDone={() => setGenerated(null)} />}

        {showForm && domains.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nenhum domínio de e-mail cadastrado ainda. Cadastre abaixo o domínio do projeto (o servidor de e-mail
            precisa estar iniciado, na página{" "}
            <Link to="/mail" className="text-foreground underline">
              E-mail
            </Link>
            ).
          </p>
        )}

        {showForm && (adding || domains.length === 0) && (
          <div className="flex flex-col gap-2 rounded-lg border border-sky-500/30 p-3 sm:p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4" /> Usar um domínio seu (ex.: contato@seudominio.com.br)
            </p>
            <p className="text-xs text-muted-foreground">
              O painel cadastra o domínio no servidor de e-mail, gera a assinatura (DKIM) e mostra os registros DNS para
              você criar. Se o domínio já recebe e-mail em outro lugar, o painel avisa e sugere um subdomínio só para
              envio.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Seu domínio"
                placeholder="seudominio.com.br"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addDomain()}
                className="min-w-0 flex-1 sm:max-w-xs"
              />
              <Button variant="info" size="sm" disabled={busy || !newDomain.trim()} onClick={() => void addDomain()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Cadastrar domínio
              </Button>
              {domains.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancelar
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
              <span>Domínio de e-mail</span>
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
                  <Plus className="h-4 w-4" /> Usar um domínio meu
                </Button>
              </div>
            )}
            {domain && justAdded === domain.name && !dnsReady(domain) && (
              <div className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
                <p className="font-medium">Domínio {domain.name} cadastrado. Próximo passo: o DNS.</p>
                <p className="text-muted-foreground">
                  Crie no provedor de DNS os registros que o painel mostra (o A de mail.{domain.name} com a nuvem cinza,
                  no Cloudflare). Depois clique em Verificar agora até ficar 6/6.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="info" size="sm" asChild>
                    <Link to={`/mail/${encodeURIComponent(domain.name)}?aba=dns`}>
                      <ExternalLink className="h-4 w-4" /> Ver os registros DNS
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" disabled={verifying} onClick={() => void verifyDomain(domain.name)}>
                    {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Verificar agora
                  </Button>
                </div>
              </div>
            )}
            {domain && justAdded !== domain.name && !dnsReady(domain) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  O DNS deste domínio ainda tem pendências: o envio pode falhar ou cair no spam.{" "}
                  <Link to={`/mail/${encodeURIComponent(domain.name)}`} className="underline">
                    Ver o checklist do domínio
                  </Link>
                </span>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span>Endereço de envio</span>
                <div className="flex min-w-0 items-center">
                  <Input
                    aria-label="Endereço de envio"
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
              <label className="flex flex-col gap-1 text-sm">
                <span>Nome de exibição</span>
                <Input
                  aria-label="Nome de exibição"
                  placeholder={projectName}
                  maxLength={80}
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              Quem receber vai ver: <span className="text-foreground">{`${previewName} <${previewAddress}>`}</span>. Em
              branco, o painel usa o nome do projeto e {projectSlug}@.
            </p>
            <p data-testid="mailbox-explain" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              A caixa do projeto será <span className="text-foreground">{previewAddress}</span>: o app do projeto envia
              por ela e você pode abri-la num app de e-mail (Outlook, Gmail, celular) para ler as respostas.
            </p>
            {email.enabled && email.mailbox && previewAddress !== email.mailbox && (
              <p
                data-testid="old-mailbox-note"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 [overflow-wrap:anywhere]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Endereço novo: o painel cria a caixa {previewAddress} e a caixa {email.mailbox} será removida (com as
                  mensagens dela), se nenhum outro projeto a usar.
                </span>
              </p>
            )}
            {needsPassword && <PasswordChoice value={passwordChoice} onChange={setPasswordChoice} />}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="success"
                size="sm"
                disabled={busy || !selectedDomain || passwordProblem !== null}
                onClick={() => void save()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {email.enabled ? "Salvar" : "Ativar e-mail"}
              </Button>
              {editing && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancelar
                </Button>
              )}
            </div>
          </div>
        )}

        {email.enabled && !editing && (
          <>
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">Remetente</p>
              <p className="font-medium [overflow-wrap:anywhere]">{`${email.fromName ?? projectName} <${email.mailFrom}>`}</p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Caixa do projeto: {email.mailbox}. O projeto entra no servidor de e-mail com ela.
              </p>
            </div>
            {email.legacyAlias && (
              <p
                data-testid="legacy-alias"
                className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Este projeto ainda usa o modelo antigo: {email.mailFrom} é só um apelido da caixa técnica{" "}
                  {email.mailbox}, sem senha para você abrir. O envio continua funcionando. Para {email.mailFrom} virar
                  uma caixa que você abre num app de e-mail, clique em Alterar remetente e salve com uma senha.
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
                        aria-label={`Copiar ${key}`}
                        title="Copiar valor"
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
                <p className="text-muted-foreground">Também entregues com os nomes do seu app:</p>
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
                O projeto recebe estes valores no próximo deploy: depois de ativar ou alterar, faça um novo deploy. A
                senha (SMTP_PASS) nunca aparece aqui.
              </span>
            </p>
            <p data-testid="display-name-note" className="text-xs text-muted-foreground">
              O nome de exibição aparece para quem recebe quando o app do projeto usa MAIL_FROM_NAME (ou monta 'Nome
              &lt;endereço&gt;'). O e-mail de teste já sai com ele.
            </p>
            <p data-testid="email-other-names" className="text-xs text-muted-foreground">
              Seu app usa outros nomes (ex.: <code>SMTP_SENHA</code>, <code>EMAIL_DE</code>)? Use{" "}
              <strong>Ligar às variáveis do projeto</strong>: o painel entrega os mesmos valores com os nomes do seu app,
              sem copiar a senha para as Variáveis.
            </p>
            {passwordChanged && (
              <p className="flex items-start gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm">
                <Rocket className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Senha trocada. O projeto só recebe a senha nova no próximo deploy.</span>
              </p>
            )}
            {changingPassword && email.mailbox && (
              <div className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
                <p className="text-sm font-medium [overflow-wrap:anywhere]">Trocar a senha de {email.mailbox}</p>
                <PasswordChoice value={passwordChoice} onChange={setPasswordChoice} passwordLabel="Nova senha" />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="success"
                    size="sm"
                    disabled={busy || passwordChoiceProblem(passwordChoice) !== null}
                    onClick={() => void changePassword(email.mailbox!)}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    Salvar a senha nova
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setChangingPassword(false)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {showAppSettings && email.mailbox && <MailboxAppSettings mailbox={email.mailbox} />}
            <div className="flex flex-wrap gap-2">
              <Button variant="deploy" size="sm" onClick={() => setTesting(true)}>
                <Send className="h-4 w-4" /> Enviar e-mail de teste
              </Button>
              <Button variant="info" size="sm" onClick={() => setLinking(true)}>
                <Link2 className="h-4 w-4" /> Ligar às variáveis do projeto
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowAppSettings((v) => !v)}>
                <Smartphone className="h-4 w-4" /> Configurar no app
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
                Trocar senha
              </Button>
              <Button variant="outline" size="sm" onClick={() => startEditing(email)}>
                <Pencil className="h-4 w-4" /> Alterar remetente
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void disable()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Desativar e-mail
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
