import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  DeployJob,
  DeployJobListResponse,
  DeployJobResponse,
  GuardrailReport,
  GuardrailReportResponse,
  MailDomainListResponse,
  ProjectEmailResponse,
  ProjectResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Mail,
  Play,
  Rocket,
  ShieldAlert,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { StatusBadge, TYPE_LABELS } from "@/pages/DashboardPage";
import { cn } from "@/lib/utils";

function JobStatusBadge({ status }: { status: DeployJob["status"] }) {
  switch (status) {
    case "queued":
    case "running":
      return <Badge variant="warning">executando…</Badge>;
    case "success":
      return <Badge variant="success">sucesso</Badge>;
    case "failed":
      return <Badge variant="destructive">falhou</Badge>;
  }
}

function StepIcon({ status }: { status: DeployJob["steps"][number]["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-amber-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "skipped":
      return <span className="inline-block h-4 w-4 rounded-full border border-muted" />;
  }
}

/**
 * Card "E-mail do projeto" (Fase 3): ativa a caixa técnica <slug>@<domínio> e
 * mostra as env vars SMTP que serão injetadas no próximo deploy (mascaradas).
 */
function ProjectEmailCard({ projectId }: { projectId: string }) {
  const [email, setEmail] = useState<ProjectEmailResponse["email"] | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const names = res.domains.map((d) => d.name);
        setDomains(names);
        setSelectedDomain((prev) => prev || names[0] || "");
      })
      .catch(() => undefined);
  }, [refresh]);

  async function toggle(enable: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (enable) {
        await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`, {
          method: "POST",
          body: JSON.stringify({ domain: selectedDomain }),
        });
      } else {
        await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`, {
          method: "DELETE",
        });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar o e-mail do projeto.");
    } finally {
      setBusy(false);
    }
  }

  if (!email) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" /> E-mail do projeto
          </CardTitle>
          <Badge variant={email.enabled ? "success" : "secondary"}>
            {email.enabled ? "habilitado" : "desabilitado"}
          </Badge>
        </div>
        <CardDescription>
          Caixa técnica + env vars SMTP injetadas automaticamente no próximo deploy.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {email.enabled ? (
          <>
            <p className="text-sm">
              Caixa técnica: <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{email.mailbox}</code>
            </p>
            <div className="rounded-lg border bg-black/40 p-3 font-mono text-xs">
              {Object.entries(email.env).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-4">
                  <span className="text-emerald-300">{key}</span>
                  <span className="break-all text-muted-foreground">{value}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A senha (SMTP_PASS) fica mascarada aqui; o valor real é injetado no container no deploy.
            </p>
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggle(false)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Desativar e-mail
              </Button>
            </div>
          </>
        ) : domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum domínio de e-mail configurado. Cadastre um na página{" "}
            <Link to="/mail" className="underline">
              E-mail
            </Link>{" "}
            para habilitar o envio pelo projeto.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedDomain}
              onChange={(e) => setSelectedDomain(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {domains.map((d) => (
                <option key={d} value={d} className="bg-background">
                  {d}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy || !selectedDomain} onClick={() => void toggle(true)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              Ativar e-mail
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Modal de bloqueio de guardrails (Fase 4): exibido quando o deploy tem
 * findings "block". Exige checkbox explícito para override (auditado na API).
 */
export function GuardrailOverrideModal({
  report,
  busy,
  onCancel,
  onConfirm,
}: {
  report: GuardrailReport;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-auto rounded-xl border border-red-500/40 bg-background p-6 shadow-2xl">
        <div className="flex items-center gap-2 text-lg font-semibold text-red-400">
          <ShieldAlert className="h-5 w-5" /> Deploy bloqueado pelos guardrails
        </div>
        <p className="text-sm text-muted-foreground">
          {report.blockers} violação(ões) de segurança do tipo <strong>block</strong> foram encontradas
          {report.warnings > 0 ? `, além de ${report.warnings} alerta(s)` : ""}. Corrija os problemas ou
          assuma o risco explicitamente — o override fica registrado na auditoria.
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {report.findings.map((f, i) => (
            <li key={i} className="rounded-lg border bg-black/40 p-3">
              <div className="flex items-center gap-2">
                <Badge variant={f.level === "block" ? "destructive" : f.level === "warn" ? "warning" : "secondary"}>
                  {f.level}
                </Badge>
                <span className="font-medium">{f.title}</span>
                <code className="text-xs text-muted-foreground">[{f.rule}]</code>
              </div>
              <p className="pt-1 font-mono text-xs text-muted-foreground">{f.evidence}</p>
              <p className="pt-1 text-xs text-emerald-300/80">💡 {f.fix}</p>
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="h-4 w-4"
          />
          Entendo os riscos e quero fazer o deploy mesmo assim (override)
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" size="sm" disabled={!accepted || busy} onClick={onConfirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
            Deploy com override
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectResponse | null>(null);
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [activeJob, setActiveJob] = useState<DeployJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [guardrailReport, setGuardrailReport] = useState<GuardrailReport | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [project, jobList] = await Promise.all([
        apiFetch<ProjectResponse>(`/api/projects/${id}`),
        apiFetch<DeployJobListResponse>(`/api/projects/${id}/jobs`),
      ]);
      setData(project);
      setJobs(jobList.jobs);
      setError(null);
      return jobList.jobs[0] ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o projeto.");
      return null;
    }
  }, [id]);

  // polling do projeto + do job ativo (log de deploy com "streaming" por polling)
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      const latest = await refresh();
      if (cancelled) return;
      const running = jobs.find((j) => j.status === "running" || j.status === "queued");
      const current = running ?? activeJob ?? latest;
      if (current && id) {
        try {
          const res = await apiFetch<DeployJobResponse>(`/api/projects/${id}/jobs/${current.id}`);
          if (!cancelled) setActiveJob(res.job);
        } catch {
          /* job ainda não persistido */
        }
      }
      timer = setTimeout(() => void tick(), current?.status === "running" ? 1_500 : 5_000);
    }

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refresh, activeJob?.id]);

  // auto-scroll do log
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [activeJob?.log]);

  /** Inicia o deploy; em 409 guardrail_blocked abre o modal de override. */
  async function doDeploy(override: boolean) {
    if (!id) return;
    setBusy("deploy");
    setError(null);
    try {
      const res = await apiFetch<DeployJobResponse>(`/api/projects/${id}/deploy`, {
        method: "POST",
        body: JSON.stringify({ guardrailOverride: override }),
      });
      setActiveJob(res.job);
      setGuardrailReport(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "guardrail_blocked" && err.data?.report) {
        setGuardrailReport(err.data.report as GuardrailReport);
      } else {
        setError(err instanceof Error ? err.message : "Falha ao executar deploy.");
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * Fluxo de deploy com guardrails (Fase 4): consulta o relatório antes; se
   * houver bloqueios, abre o modal exigindo confirmação explícita.
   */
  async function deployWithGuardrails() {
    if (!id) return;
    setBusy("deploy");
    setError(null);
    try {
      const res = await apiFetch<GuardrailReportResponse>(`/api/projects/${id}/guardrails`);
      if (res.report && res.report.blockers > 0) {
        setGuardrailReport(res.report);
        setBusy(null);
        return;
      }
    } catch {
      // relatório indisponível — a API revalida no POST /deploy de qualquer forma
    }
    await doDeploy(false);
  }

  async function action(kind: "stop" | "start") {
    if (!id) return;
    setBusy(kind);
    setError(null);
    try {
      await apiFetch(`/api/projects/${id}/${kind}`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Falha ao executar ${kind}.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!id) return;
    setBusy("delete");
    try {
      await apiFetch(`/api/projects/${id}?deleteSource=${deleteSource}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover o projeto.");
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {error ?? "Carregando…"}
      </p>
    );
  }

  const { project, status, containers, url } = data;
  const running = status === "deploying";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              {project.name} <StatusBadge status={status} />
            </h1>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
            >
              <Globe className="h-3.5 w-3.5" /> {project.domain} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || running || status === "created"}
            onClick={() => void action("stop")}
          >
            <Square className="h-4 w-4" /> Parar
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || running || status === "running" || status === "created"}
            onClick={() => void action("start")}
          >
            <Play className="h-4 w-4" /> Iniciar
          </Button>
          <Button size="sm" disabled={busy !== null || running} onClick={() => void deployWithGuardrails()}>
            {busy === "deploy" || running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Deploy
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {guardrailReport && (
        <GuardrailOverrideModal
          report={guardrailReport}
          busy={busy === "deploy"}
          onCancel={() => setGuardrailReport(null)}
          onConfirm={() => void doDeploy(true)}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tipo / pipeline</CardDescription>
            <CardTitle className="text-base">
              {project.detection ? TYPE_LABELS[project.detection.type] : "não detectado"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            ingestão: {project.ingestMode}
            {project.branch ? ` · branch ${project.branch}` : ""}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Containers</CardDescription>
            <CardTitle className="text-base">
              {containers.filter((c) => c.state === "running").length}/{containers.length} ativos
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
            {containers.map((c) => (
              <span key={c.id} className="font-mono">
                {c.name} — {c.status}
              </span>
            ))}
            {containers.length === 0 && <span>nenhum container ainda</span>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Configuração</CardDescription>
            <CardTitle className="text-base">
              {project.websocket ? "WebSocket habilitado" : "HTTP padrão"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {project.lastDeployAt
              ? `último deploy: ${new Date(project.lastDeployAt).toLocaleString("pt-BR")}`
              : "nenhum deploy ainda"}
          </CardContent>
        </Card>
      </div>

      {project.detection && project.detection.warnings.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Guardrails ({project.detection.warnings.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {project.detection.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                      w.severity === "critical" ? "bg-red-400" : "bg-amber-400",
                    )}
                  />
                  <span>
                    {w.service && <code className="mr-1 text-xs">[{w.service}]</code>}
                    {w.message}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ProjectEmailCard projectId={project.id} />

      {activeJob && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Deploy {activeJob.id.slice(0, 8)}</CardTitle>
              <JobStatusBadge status={activeJob.status} />
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              {activeJob.steps.map((step, i) => (
                <span key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StepIcon status={step.status} /> {step.name}
                </span>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <pre
              ref={logRef}
              className="max-h-96 overflow-auto rounded-lg border bg-black/40 p-3 font-mono text-xs leading-relaxed text-emerald-100/90"
            >
              {activeJob.log || "aguardando log…"}
            </pre>
            {activeJob.error && (
              <p className="pt-2 text-sm text-destructive">{activeJob.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Histórico de deploys</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Nenhum deploy ainda.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className={cn(
                      "cursor-pointer border-b last:border-0 hover:bg-accent/50",
                      activeJob?.id === job.id && "bg-accent/40",
                    )}
                    onClick={() => setActiveJob(job)}
                  >
                    <td className="px-4 py-2 font-mono text-xs">{job.id.slice(0, 8)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <JobStatusBadge status={job.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-destructive">Zona de perigo</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!confirmDelete ? (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> Remover projeto
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                Remover containers, domínio e configuração de <strong>{project.name}</strong>?
              </p>
              {project.ingestMode !== "existing" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deleteSource}
                    onChange={(e) => setDeleteSource(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Apagar também o código-fonte copiado pelo painel
                </label>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === "delete"}
                  onClick={() => void remove()}
                >
                  {busy === "delete" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Confirmar remoção
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
