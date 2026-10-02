/**
 * E-mail do projeto (seção E-mail da página do projeto).
 *
 * O painel cria a caixa técnica <slug>@<domínio> e entrega ao projeto, no
 * próximo deploy, SMTP_HOST/PORT/USER/PASS, MAIL_FROM e MAIL_FROM_NAME.
 * A pessoa escolhe (pedido do dono do produto, 02/10/2026):
 *  - o domínio de e-mail (com o estado do DNS dele);
 *  - o endereço de envio (ex.: nao-responda@) — vira endereço extra da caixa
 *    técnica no servidor de e-mail; em branco, envia como a própria caixa;
 *  - o nome que aparece para quem recebe (padrão: o nome do projeto).
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { MailDomainListResponse, MailDomainSummary, ProjectEmailConfig, ProjectEmailResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TestEmailModal } from "@/components/mail/TestEmailCard";
import { AlertTriangle, Loader2, Mail, Pencil, Rocket, Send } from "lucide-react";

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
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
}) {
  const [email, setEmail] = useState<ProjectEmailConfig | null>(null);
  const [domains, setDomains] = useState<MailDomainSummary[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [fromName, setFromName] = useState("");
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`);
      setEmail(res.email);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o e-mail do projeto.");
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    apiFetch<MailDomainListResponse>("/api/mail/domains")
      .then((res) => {
        setDomains(res.domains);
        setSelectedDomain((prev) => prev || res.domains[0]?.name || "");
      })
      .catch(() => undefined);
  }, [refresh]);

  function startEditing(current: ProjectEmailConfig) {
    setSelectedDomain(current.domain ?? selectedDomain);
    const local = current.mailFrom?.split("@")[0] ?? "";
    setFromLocal(current.mailFrom && current.mailFrom !== current.mailbox ? local : "");
    setFromName(current.fromName ?? "");
    setEditing(true);
    setSaved(false);
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
        body: JSON.stringify(body),
      });
      setEmail(res.email);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar o e-mail do projeto.");
    } finally {
      setBusy(false);
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
          O painel cria uma caixa técnica para o projeto e entrega os dados de envio (SMTP_* e MAIL_FROM) no próximo
          deploy. Você escolhe o domínio, o endereço que aparece como remetente e o nome.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {showForm && domains.length === 0 && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">Nenhum domínio de e-mail cadastrado ainda. Para o projeto enviar e-mail:</p>
            <ol className="ml-5 list-decimal space-y-1 text-muted-foreground">
              <li>
                Abra{" "}
                <Link to="/mail" className="text-foreground underline">
                  E-mail
                </Link>
                , inicie o servidor e cadastre o domínio (se ele já recebe e-mail em outro lugar, use um subdomínio,
                como envio.seudominio.com.br).
              </li>
              <li>Crie no DNS os registros que o painel mostrar e verifique até ficar tudo verde.</li>
              <li>Volte aqui, escolha o domínio e ative.</li>
            </ol>
          </div>
        )}

        {showForm && domains.length > 0 && (
          <div className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span>Domínio de e-mail</span>
              <select
                value={selectedDomain}
                onChange={(e) => setSelectedDomain(e.target.value)}
                className="h-9 max-w-md rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {domains.map((d) => (
                  <option key={d.name} value={d.name} className="bg-background">
                    {d.name} — {dnsLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            {domain && !dnsReady(domain) && (
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
              branco, o painel usa o nome do projeto e a caixa técnica.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="success" size="sm" disabled={busy || !selectedDomain} onClick={() => void save()}>
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
                O projeto entra no servidor de e-mail com a caixa técnica {email.mailbox}.
              </p>
            </div>
            <div className="rounded-lg border bg-black/40 p-3 font-mono text-xs">
              {Object.entries(email.env).map(([key, value]) => (
                <div key={key} className="flex flex-wrap justify-between gap-x-4">
                  <span className="text-emerald-300">{key}</span>
                  <span className="break-all text-muted-foreground">{value}</span>
                </div>
              ))}
            </div>
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
                senha (SMTP_PASS) fica mascarada aqui.
              </span>
            </p>
            <p data-testid="email-other-names" className="text-xs text-muted-foreground">
              Seu app usa outros nomes (ex.: <code>SMTP_PORTA</code>, <code>SMTP_SENHA</code>, <code>EMAIL_DE</code>)?
              Num projeto com docker-compose, estas variáveis também valem no compose: escreva, por exemplo,{" "}
              <code>SMTP_PORTA: {"${SMTP_PORT}"}</code> e <code>SMTP_SENHA: {"${SMTP_PASS}"}</code> no serviço que
              envia e-mail.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="deploy" size="sm" onClick={() => setTesting(true)}>
                <Send className="h-4 w-4" /> Enviar e-mail de teste
              </Button>
              <Button variant="outline" size="sm" onClick={() => startEditing(email)}>
                <Pencil className="h-4 w-4" /> Alterar remetente
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void disable()}>
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
    </Card>
  );
}
