import { useState } from "react";
import type { DomainCheckResponse, Project, ProjectResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DnsGuide } from "@/components/DnsGuide";
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
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, method: "POST" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<ProjectResponse>(path, { method });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível alterar o domínio.");
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/projects/${project.id}/domains/${encodeURIComponent(domain)}`;
  return (
    <li data-testid={`domain-${domain}`} className="flex flex-col gap-2 border-b py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={urlOf(domain)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 break-all font-mono text-sm hover:underline"
        >
          {domain} <ExternalLink className="h-3 w-3" />
        </a>
        {primary && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
            <Star className="h-3 w-3" /> principal
          </span>
        )}
        {domain.endsWith(".sslip.io") && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">automático</span>
        )}
        <div className="ml-auto flex gap-2">
          {!primary && !confirming && (
            <>
              <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void call(`${base}/primary`, "POST")}>
                Tornar principal
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-red-400" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Remover
              </Button>
            </>
          )}
          {confirming && (
            <>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
              <Button size="sm" variant="destructive" className="h-7" disabled={busy} onClick={() => void call(base, "DELETE")}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Confirmar remoção
              </Button>
            </>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </li>
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
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [check, setCheck] = useState<DomainCheckResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = [project.domain, ...(project.aliases ?? [])];

  async function verify() {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await apiFetch<DomainCheckResponse>(`/api/domains/check?domain=${encodeURIComponent(domain.trim())}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível verificar o DNS.");
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
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível conectar o domínio.");
    } finally {
      setBusy(null);
    }
  }

  const live = project.lastDeployStatus === "success";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" /> Domínios
        </CardTitle>
        <CardDescription>
          Todos abrem o mesmo site, cada um com o seu certificado HTTPS.{" "}
          {live ? "As mudanças valem na hora." : "As mudanças valem a partir do primeiro deploy."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul>
          {all.map((d) => (
            <DomainRow key={d} project={project} domain={d} primary={d === project.domain} onChanged={onChanged} />
          ))}
        </ul>

        {!adding && (
          <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Conectar novo domínio
          </Button>
        )}

        {adding && (
          <div className="flex flex-col gap-3 rounded-md border p-4">
            <label htmlFor="pd-new" className="flex flex-col gap-1.5 text-sm font-medium">
              Novo domínio
              <div className="flex gap-2">
                <Input
                  id="pd-new"
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    setCheck(null);
                  }}
                  placeholder="loja.meusite.com.br"
                />
                <Button variant="outline" disabled={busy !== null || !domain.trim()} onClick={() => void verify()}>
                  {busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} Verificar DNS
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
              Dá para conectar antes de o DNS propagar: o domínio passa a abrir (com HTTPS) assim que o registro apontar
              para a VPS.
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
                Cancelar
              </Button>
              <Button disabled={busy !== null || !domain.trim()} onClick={() => void connect()}>
                {busy === "add" && <Loader2 className="h-4 w-4 animate-spin" />}
                Conectar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
