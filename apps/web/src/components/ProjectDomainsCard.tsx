import { IpInAddressHint } from "@/components/IpInAddress";
import { useEffect, useRef, useState } from "react";
import type { AutoDomainSuggestion, DomainCheckResponse, Project, ProjectResponse } from "@paas/core";
import { isProvisionalDomain } from "@paas/core";
import { ProvisionalAddressNotice, useProvisionalHere } from "@/components/project/ProvisionalAddressNotice";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DnsGuide } from "@/components/DnsGuide";
import { CertificateSummary } from "@/components/certificates/CertificateSummary";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ExternalLink, Globe, Loader2, Plus, Star, Trash2 } from "lucide-react";

function urlOf(domain: string): string {
  return domain.endsWith(".localhost") || domain === "localhost" ? `http://${domain}` : `https://${domain}`;
}

function DomainRow({
  project,
  domain,
  primary,
  onChanged,
}: {
  project: Project;
  domain: string;
  primary: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPort = project.detection?.type === "compose" || project.detection?.type === "dockerfile";
  const defaultPort = project.proxyPort ?? project.detection?.proxyPort ?? null;
  const currentPort = project.domainPorts?.[domain] ?? null;
  const [port, setPort] = useState(currentPort ? String(currentPort) : "");
  const provisionalHere = useProvisionalHere(domain);

  async function call(path: string, method: "POST" | "DELETE" | "PUT", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<ProjectResponse>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(apiErrorText(err, "projects.domains.changeError"));
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/projects/${project.id}/domains/${encodeURIComponent(domain)}`;
  return (
    <li data-testid={`domain-${domain}`} className="flex flex-col gap-2 border-b py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        {provisionalHere ? (
          <span className="break-all font-mono text-sm">{domain}</span>
        ) : (
          <a
            href={urlOf(domain)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 break-all font-mono text-sm hover:underline"
          >
            {domain} <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {primary && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
            <Star className="h-3 w-3" /> {t("projects.domains.primary")}
          </span>
        )}
        {domain.endsWith(".sslip.io") && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{t("projects.domains.automatic")}</span>
        )}
        <IpInAddressHint domain={domain} />
        <div className="ml-auto flex gap-2">
          {!primary && !confirming && (
            <>
              <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void call(`${base}/primary`, "POST")}>
                {t("projects.domains.makePrimary")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-red-400" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 className="h-3.5 w-3.5" /> {t("projects.domains.remove")}
              </Button>
            </>
          )}
          {confirming && (
            <>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirming(false)}>
                {t("projects.domains.cancel")}
              </Button>
              <Button size="sm" variant="destructive" className="h-7" disabled={busy} onClick={() => void call(base, "DELETE")}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {t("projects.domains.confirmRemove")}
              </Button>
            </>
          )}
        </div>
      </div>
      {provisionalHere && <ProvisionalAddressNotice projectId={project.id} compact inDomains />}
      {hasPort && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor={`port-${domain}`}>{t("projects.domains.port")}</label>
          <input
            id={`port-${domain}`}
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            placeholder={defaultPort ? String(defaultPort) : t("projects.domains.portPlaceholder")}
            className="h-7 w-20 rounded-md border bg-transparent px-2 font-mono text-foreground"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={busy || port === (currentPort ? String(currentPort) : "")}
            onClick={() => void call(`${base}/port`, "PUT", { port: port ? Number(port) : null })}
          >
            {t("projects.domains.savePort")}
          </Button>
          <span>{port ? t("projects.domains.ownPort") : t("projects.domains.blankPort", { port: defaultPort ?? "?" })}</span>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </li>
  );
}

/**
 * Projeto que ficou com o endereço provisório: oferece o caminho real para sair dele.
 * Com domínio de aplicações, um botão adiciona o endereço sob a base, o torna principal
 * e remove o provisório (conferindo a base de novo antes, e retomando de onde parou se
 * algo falhar). Sem ele, explica as duas saídas: configurar a base ou conectar um domínio.
 */
function ProvisionalSwitch({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { t } = useI18n();
  const [sug, setSug] = useState<AutoDomainSuggestion | "error" | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseChanged, setBaseChanged] = useState(false);
  // passos já feitos para o endereço mostrado: a nova tentativa não repete nenhum
  const done = useRef({ added: false, primary: false });
  const name = encodeURIComponent(project.name);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${name}`)
      .then((r) => !cancelled && setSug(r))
      .catch(() => !cancelled && setSug("error"));
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);

  if (sug === undefined) return null;
  if (sug === "error") {
    return (
      <div data-testid="provisional-suggest-error" role="alert" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
        <p className="text-destructive">{t("projects.provisional.suggestError")}</p>
        <Button size="sm" variant="outline" className="self-start" onClick={() => { setSug(undefined); setAttempt((n) => n + 1); }}>
          {t("projects.provisional.retry")}
        </Button>
      </div>
    );
  }
  if (sug.kind !== "apps") {
    return (
      <div data-testid="provisional-no-base" className="rounded-md border p-3 text-sm">
        <p>{t("projects.provisional.noBase")}</p>
        <a href="/settings/apps-domain" className="text-sky-400 underline underline-offset-2 hover:no-underline">
          {t("projects.provisional.configureBase")}
        </a>
      </div>
    );
  }
  // Já existe um endereço sob a base neste projeto (adição anterior que não terminou, ou página
  // recarregada)? Retoma a partir dele em vez de gerar e adicionar um segundo.
  const underBase = (project.aliases ?? []).concat(project.domain).find((d) => !isProvisionalDomain(d) && sug.appsBase && d.endsWith(`.${sug.appsBase}`));
  const target = underBase ?? sug.auto;
  const sugBase = sug.appsBase;

  async function switchNow() {
    setBusy(true);
    setError(null);
    try {
      if (!done.current.added && !underBase) {
        // a base pode ter mudado em outra aba: confere antes de gravar qualquer coisa
        const now = await apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${name}`);
        if (now.kind !== "apps" || now.appsBase !== sugBase) {
          setSug(now);
          setBaseChanged(true);
          return;
        }
        try {
          await apiFetch<ProjectResponse>(`/api/projects/${project.id}/domains`, { method: "POST", body: JSON.stringify({ domain: target }) });
        } catch (err) {
          // resposta perdida na tentativa anterior: se o servidor já gravou este endereço NESTE projeto, segue
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          const cur = await apiFetch<ProjectResponse>(`/api/projects/${project.id}`);
          if (![cur.project.domain, ...(cur.project.aliases ?? [])].includes(target)) throw err;
        }
        done.current.added = true;
      }
      if (!done.current.primary) {
        await apiFetch<ProjectResponse>(`/api/projects/${project.id}/domains/${encodeURIComponent(target)}/primary`, { method: "POST" });
        done.current.primary = true;
      }
      await apiFetch<ProjectResponse>(`/api/projects/${project.id}/domains/${encodeURIComponent(project.domain)}`, { method: "DELETE" });
      setBaseChanged(false);
      onChanged();
    } catch {
      setError(t("projects.provisional.switchError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      {baseChanged && (
        <p data-testid="provisional-base-changed" role="note" className="text-amber-400">
          {t("projects.provisional.baseChanged")}
        </p>
      )}
      <Button className="h-auto min-h-9 max-w-full self-start whitespace-normal py-2 text-left" disabled={busy} onClick={() => void switchNow()}>
        {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
        <span className="min-w-0 break-all">{t("projects.provisional.useAuto", { address: target })}</span>
      </Button>
      {error && (
        <p data-testid="provisional-switch-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Seção Domínios do projeto: o principal (o do "Abrir site" e do health check)
 * e quantos adicionais o operador quiser, todos servidos ao mesmo tempo, cada
 * um com o seu certificado. Com o projeto no ar, cada mudança vale na hora.
 */
export function ProjectDomainsCard({
  project,
  publicIp,
  onChanged,
}: {
  project: Project;
  publicIp: string | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [check, setCheck] = useState<DomainCheckResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = [project.domain, ...(project.aliases ?? [])];
  const provisionalHere = useProvisionalHere(project.domain) && isProvisionalDomain(project.domain);

  async function verify() {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await apiFetch<DomainCheckResponse>(`/api/domains/check?domain=${encodeURIComponent(domain.trim())}`));
    } catch (err) {
      setError(apiErrorText(err, "projects.domains.verifyError"));
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("add");
    setError(null);
    try {
      await apiFetch<ProjectResponse>(`/api/projects/${project.id}/domains`, {
        method: "POST",
        body: JSON.stringify({ domain: domain.trim().toLowerCase() }),
      });
      setAdding(false);
      setDomain("");
      setCheck(null);
      onChanged();
    } catch (err) {
      setError(apiErrorText(err, "projects.domains.connectError"));
    } finally {
      setBusy(null);
    }
  }

  // já esteve no ar (mesma regra do proxy: último deploy ok ou algo já publicado)
  const live = project.lastDeployStatus === "success" || (project.deployedSource ?? null) !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" /> {t("projects.domains.title")}
        </CardTitle>
        <CardDescription>
          {t("projects.domains.description")}
          {!live && <> {t("projects.domains.descriptionNotLive")}</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul>
          {all.map((d) => (
            <DomainRow key={d} project={project} domain={d} primary={d === project.domain} onChanged={onChanged} />
          ))}
        </ul>

        {provisionalHere && <ProvisionalSwitch key={project.domain} project={project} onChanged={onChanged} />}

        <CertificateSummary query={`project=${encodeURIComponent(project.id)}`} />

        {!adding && (
          <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> {t("projects.domains.connectNew")}
          </Button>
        )}

        {adding && (
          <div className="flex flex-col gap-3 rounded-md border p-4">
            <label htmlFor="pd-new" className="flex flex-col gap-1.5 text-sm font-medium">
              {t("projects.domains.newDomain")}
              <div className="flex gap-2">
                <Input
                  id="pd-new"
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    setCheck(null);
                  }}
                  placeholder={t("projects.domains.newPlaceholder")}
                />
                <Button variant="outline" disabled={busy !== null || !domain.trim()} onClick={() => void verify()}>
                  {busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} {t("projects.domains.verify")}
                </Button>
              </div>
            </label>
            <DnsGuide domain={domain} publicIp={publicIp} />
            {check && (
              <p className={cn("flex items-start gap-2 text-sm", check.ok ? "text-emerald-400" : "text-amber-400")}>
                {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                {check.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("projects.domains.propagationHint")}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                {t("projects.domains.cancel")}
              </Button>
              <Button disabled={busy !== null || !domain.trim()} onClick={() => void connect()}>
                {busy === "add" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("projects.domains.connect")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
