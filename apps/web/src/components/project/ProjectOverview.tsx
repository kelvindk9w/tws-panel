import { useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  DeployJob,
  DockerContainerInfo,
  DomainHttpsStatus,
  Project,
  ProjectEmailResponse,
  ProjectHttpsResponse,
  ProjectStatus,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, TYPE_LABELS } from "@/pages/DashboardPage";
import { cn } from "@/lib/utils";
import { AlertTriangle, Box, CheckCircle2, Code2, ExternalLink, Globe, Loader2, Mail, Rocket } from "lucide-react";
import { ComposeServicesCard } from "./ComposeServices";
import { DeployLogView, DeploySteps, JobStatusBadge } from "./DeployLog";
import { deployDuration, formatDateTime, isActiveJob } from "./deploy-format";

const STATUS_TEXT: Record<ProjectStatus, string> = {
  running: "No ar — os containers estão rodando.",
  deploying: "Deploy em andamento.",
  stopped: "Parado — os containers estão desligados. Use Iniciar para religar.",
  error: "Com erro — veja o último deploy abaixo.",
  created: "Ainda sem deploy. Clique em Deploy, no topo, para publicar.",
};

function urlOf(domain: string): string {
  return domain.endsWith(".localhost") || domain === "localhost" ? `http://${domain}` : `https://${domain}`;
}

function HttpsLine({ status }: { status: DomainHttpsStatus | undefined }) {
  if (!status) return <span className="text-muted-foreground">verificando o certificado…</span>;
  if (status.ok) {
    return (
      <span className="flex items-center gap-1 text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> HTTPS válido
        {status.issuer ? ` · ${status.issuer}` : ""}
        {status.validTo ? ` · até ${new Date(status.validTo).toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : ""}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1 text-amber-300" title={status.error ?? undefined}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        ainda sem certificado válido — sai sozinho depois do deploy, com o DNS apontando para a VPS
        {status.error ? <span className="block text-xs text-muted-foreground">detalhe: {status.error}</span> : null}
      </span>
    </span>
  );
}

/**
 * Visão geral do projeto: tudo de uma vez — status, domínios com o estado do
 * certificado, e-mail, containers, código e o deploy (o que está acontecendo
 * agora, ou como foi o último). Simples de ler: o detalhe fica um clique adiante.
 */
export function ProjectOverview({
  project,
  status,
  containers,
  jobs,
  latestJob,
  onOpenJob,
  onChanged,
}: {
  project: Project;
  status: ProjectStatus;
  containers: DockerContainerInfo[];
  jobs: DeployJob[];
  /** O deploy mais recente com o log (atualizado enquanto roda). */
  latestJob: DeployJob | null;
  onOpenJob: (jobId: string) => void;
  /** Algo do projeto mudou aqui (entrada do compose, nova leitura): recarregar. */
  onChanged?: () => void;
}) {
  const [https, setHttps] = useState<DomainHttpsStatus[] | null>(null);
  const [email, setEmail] = useState<ProjectEmailResponse["email"] | null>(null);
  const domains = [project.domain, ...(project.aliases ?? [])];
  const domainsKey = domains.join(",");

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectHttpsResponse>(`/api/projects/${project.id}/https`)
      .then((r) => !cancelled && setHttps(r.domains ?? []))
      .catch(() => !cancelled && setHttps([]));
    return () => {
      cancelled = true;
    };
    // revalida quando os domínios mudam ou um deploy termina
  }, [project.id, domainsKey, project.lastDeployAt]);

  useEffect(() => {
    apiFetch<ProjectEmailResponse>(`/api/projects/${project.id}/email`)
      .then((r) => setEmail(r.email ?? null))
      .catch(() => setEmail(null));
  }, [project.id]);

  const job = latestJob ?? jobs[0] ?? null;
  const active = job ? isActiveJob(job) : false;
  const runningContainers = containers.filter((c) => c.state === "running").length;

  return (
    <div className="flex flex-col gap-4">
      {/* deploy rodando: o cartão de baixo já conta o que acontece */}
      {status !== "deploying" && (
        <Card data-testid="overview-status">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <StatusBadge status={status} />
            <span className="text-sm">{STATUS_TEXT[status]}</span>
          </CardContent>
        </Card>
      )}

      <Card data-testid="overview-deploy" className={cn(active && "border-violet-500/50")}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="h-4 w-4" /> {active ? "Deploy em andamento" : "Último deploy"}
            </CardTitle>
            {job && <JobStatusBadge status={job.status} />}
            {job && (
              <span className="text-xs text-muted-foreground">
                {formatDateTime(job.createdAt)} · {active ? "rodando há" : "duração"} {deployDuration(job)}
              </span>
            )}
            {job && (
              <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
                <Button variant="outline" size="sm" onClick={() => onOpenJob(job.id)}>
                  Ver detalhes
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/projects/${project.id}/deploys`}>Histórico</Link>
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!job && <p className="text-sm text-muted-foreground">Nenhum deploy ainda.</p>}
          {job && active && (
            <>
              <DeploySteps job={job} />
              <DeployLogView job={job} tail={12} className="max-h-60" />
            </>
          )}
          {job && !active && job.error && <p className="text-sm text-destructive">{job.error}</p>}
        </CardContent>
      </Card>

      {project.detection?.type === "compose" && (
        <ComposeServicesCard project={project} containers={containers} onChanged={() => onChanged?.()} />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-testid="overview-domains">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Domínios · HTTPS automático
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {domains.map((d) => (
              <div key={d} data-testid={`https-${d}`} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={urlOf(d)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 break-all font-mono hover:underline"
                  >
                    {d} <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  {d === project.domain && domains.length > 1 && (
                    <span className="whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                      principal
                    </span>
                  )}
                </div>
                <span className="text-xs">
                  <HttpsLine status={https?.find((h) => h.domain === d) ?? (https ? { domain: d, ok: false, issuer: null, validTo: null, error: null } : undefined)} />
                </span>
              </div>
            ))}
            <Link to={`/projects/${project.id}/domains`} className="text-xs text-sky-400 hover:underline">
              Gerenciar domínios
            </Link>
          </CardContent>
        </Card>

        <Card data-testid="overview-email">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" /> E-mail do projeto
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {email === null ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : email.enabled ? (
              <>
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Ativo
                </span>
                <span className="font-mono text-xs">{email.mailbox}</span>
                <span className="text-xs text-muted-foreground">SMTP_* e MAIL_FROM entram sozinhos no deploy.</span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">E-mail não ativado — o app não tem por onde enviar.</span>
                <Link to={`/projects/${project.id}/email`} className="text-xs text-sky-400 hover:underline">
                  Ativar o e-mail do projeto
                </Link>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Box className="h-3.5 w-3.5" /> Containers
            </CardDescription>
            <CardTitle className="text-base">
              {runningContainers}/{containers.length} rodando
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
            {containers.map((c) => (
              <span key={c.id} className="flex items-center gap-1.5 font-mono">
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", c.state === "running" ? "bg-emerald-400" : "bg-red-400")}
                />
                {c.name} — {c.status}
              </span>
            ))}
            {containers.length === 0 && <span>nenhum container ainda</span>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Code2 className="h-3.5 w-3.5" /> Código
            </CardDescription>
            <CardTitle className="text-base">
              {project.detection ? TYPE_LABELS[project.detection.type] : "não detectado"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>
              {project.ingestMode === "git" ? "repositório git" : project.ingestMode}
              {project.branch ? ` · branch ${project.branch}` : ""}
            </span>
            {project.detection?.composeFile && (
              <span data-testid="compose-file">
                arquivo <code>{project.detection.composeFile}</code>
              </span>
            )}
            {project.websocket && <span>WebSocket habilitado</span>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
