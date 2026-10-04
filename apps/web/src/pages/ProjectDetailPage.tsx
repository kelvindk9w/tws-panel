import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import type {
  DeployJob,
  DeployJobListResponse,
  DeployJobResponse,
  GuardrailReport,
  GuardrailReportResponse,
  ProjectResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { ProjectConfigCard } from "@/components/ProjectConfigCard";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { DeployDetailModal } from "@/components/project/DeployDetailModal";
import { DeployHistory } from "@/components/project/DeployHistory";
import { MissingEnvModal } from "@/components/project/MissingEnvModal";
import { ProjectEmailCard } from "@/components/project/ProjectEmailCard";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  GitBranch,
  Globe,
  LayoutDashboard,
  Loader2,
  Mail,
  Play,
  Rocket,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Variable,
  X,
} from "lucide-react";
import { StatusBadge } from "@/pages/DashboardPage";
import { cn } from "@/lib/utils";

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
  // 80/443 com proxy HTTPS próprio: forçar não adianta — o `up` falharia com
  // "porta já em uso" (ou tomaria o lugar do proxy do painel)
  const noOverride = report.findings.some((f) => f.level === "block" && f.rule === "proxy-port-conflict");
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
        {noOverride ? (
          <>
            <p data-testid="no-override" className="text-sm text-amber-300">
              Este bloqueio não tem como forçar: as portas 80 e 443 da VPS são do proxy do painel, e o deploy falharia
              com &quot;porta já em uso&quot;. Siga a orientação acima (💡) e faça o deploy de novo.
            </p>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onCancel}>
                Fechar
              </Button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Texto do aviso quando a consulta periódica falha seguidas vezes. Validação
 * real (cassino, 03/10/2026): durante o deploy aparecia um texto vermelho
 * acima do menu do projeto, que sumia na consulta seguinte — ninguém
 * conseguia ler. As causas esperadas viram frase simples; durante o deploy, é
 * estado normal.
 */
function pollProblemText(err: unknown, deploying: boolean): string {
  if (err instanceof ApiRequestError && err.status === 429) {
    return (
      "O painel recebeu consultas demais desta página em pouco tempo e pediu uma pausa. A página continua " +
      "tentando sozinha — o que aparece abaixo pode estar alguns segundos atrasado."
    );
  }
  if (deploying) {
    return "O deploy está recriando os containers e o painel demorou a responder — é normal nesta etapa. A página continua acompanhando.";
  }
  if (err instanceof ApiRequestError && err.status === 0) {
    return "Sem conexão com o painel agora (ele pode estar reiniciando). Tentando de novo a cada poucos segundos.";
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Não consegui atualizar o estado do projeto: ${detail} Tentando de novo a cada poucos segundos.`;
}

/** Seções do projeto — cada uma com o seu endereço (/projects/:id/:seção). */
const PROJECT_SECTIONS = [
  { key: "overview", label: "Visão geral", icon: LayoutDashboard },
  { key: "deploys", label: "Deploys", icon: Rocket },
  { key: "domains", label: "Domínios", icon: Globe },
  { key: "git", label: "Git", icon: GitBranch },
  { key: "env", label: "Variáveis", icon: Variable },
  { key: "email", label: "E-mail", icon: Mail },
  { key: "settings", label: "Configurações", icon: Settings },
] as const;
type ProjectSectionKey = (typeof PROJECT_SECTIONS)[number]["key"];

export function ProjectDetailPage() {
  const { id, section: sectionParam } = useParams<{ id: string; section?: string }>();
  const section: ProjectSectionKey = PROJECT_SECTIONS.some((s) => s.key === sectionParam)
    ? (sectionParam as ProjectSectionKey)
    : "overview";
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [repoVisibility, setRepoVisibility] = useState<"public" | "private" | "unknown">("unknown");
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectResponse | null>(null);
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [activeJob, setActiveJob] = useState<DeployJob | null>(null);
  // erro de uma AÇÃO (deploy, parar, iniciar, remover): fica até ser fechado
  const [error, setError] = useState<string | null>(null);
  // problema da consulta periódica: só aparece depois de falhas seguidas e
  // some sozinho quando a consulta volta (antes piscava em vermelho a cada 1,5 s)
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const pollFailures = useRef(0);
  const deployingRef = useRef(false);
  const loadedRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [guardrailReport, setGuardrailReport] = useState<GuardrailReport | null>(null);
  // ?deploy=1 (vindo do assistente): o primeiro deploy começa sozinho, uma vez
  const [searchParams, setSearchParams] = useSearchParams();
  const autoDeployDone = useRef(false);
  // detalhe de um deploy (janela) e variáveis que faltam (deploy recusado)
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [missingEnv, setMissingEnv] = useState<string[] | null>(null);

  const refresh = useCallback(async (): Promise<{ job: DeployJob | null; rateLimited: boolean }> => {
    if (!id) return { job: null, rateLimited: false };
    try {
      const [project, jobList] = await Promise.all([
        apiFetch<ProjectResponse>(`/api/projects/${id}`),
        apiFetch<DeployJobListResponse>(`/api/projects/${id}/jobs`),
      ]);
      setData(project);
      setJobs(jobList.jobs);
      pollFailures.current = 0;
      deployingRef.current = project.status === "deploying";
      loadedRef.current = true;
      setPollProblem(null);
      return { job: jobList.jobs[0] ?? null, rateLimited: false };
    } catch (err) {
      pollFailures.current += 1;
      // uma falha isolada não vira aviso (a próxima consulta costuma passar);
      // na primeira carga, sem nada na tela, o motivo aparece logo
      if (pollFailures.current >= 2 || !loadedRef.current) setPollProblem(pollProblemText(err, deployingRef.current));
      return { job: null, rateLimited: err instanceof ApiRequestError && err.status === 429 };
    }
  }, [id]);

  // polling do projeto + do job ativo (log de deploy com "streaming" por polling)
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      // o deploy mais recente já vem com o log na lista (a Visão geral mostra
      // o que acontece) — uma consulta a menos por ciclo
      const { job: current, rateLimited } = await refresh();
      if (cancelled) return;
      if (current) setActiveJob(current);
      // "consultas demais" (limite do servidor por minuto): espera mais
      timer = setTimeout(
        () => void tick(),
        rateLimited ? 15_000 : current?.status === "running" || current?.status === "queued" ? 1_500 : 5_000,
      );
    }

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refresh, activeJob?.id]);

  // IP público da VPS (guia de DNS) e visibilidade do repositório (seção Git)
  useEffect(() => {
    if (section !== "domains" || publicIp) return;
    apiFetch<{ publicIp: string | null }>("/api/domains/suggest?name=x")
      .then((r) => setPublicIp(r.publicIp))
      .catch(() => undefined);
  }, [section, publicIp]);

  useEffect(() => {
    if (section !== "git" || !id) return;
    apiFetch<{ visibility: "public" | "private" | "unknown" }>(`/api/projects/${id}/repo-visibility`)
      .then((r) => setRepoVisibility(r.visibility))
      .catch(() => setRepoVisibility("unknown"));
  }, [section, id]);

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
      } else if (err instanceof ApiRequestError && err.code === "missing_env" && Array.isArray(err.data?.missing)) {
        setGuardrailReport(null);
        setMissingEnv(err.data.missing as string[]);
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

  useEffect(() => {
    if (!data || autoDeployDone.current || searchParams.get("deploy") !== "1") return;
    autoDeployDone.current = true;
    setSearchParams({}, { replace: true });
    void deployWithGuardrails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, searchParams]);

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
        <Loader2 className="h-4 w-4 animate-spin" /> {pollProblem ?? error ?? "Carregando…"}
      </p>
    );
  }

  const { project, status, containers, url, credential } = data;
  const running = status === "deploying";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
              {project.name} <StatusBadge status={status} />
            </h1>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 break-all text-sm text-muted-foreground hover:underline"
            >
              <Globe className="h-3.5 w-3.5 shrink-0" /> {project.domain} <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </div>
        </div>
        {/* celular: duas colunas embaixo do nome; tela larga: em linha, à direita */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button asChild size="sm" variant="info">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" /> Abrir site
            </a>
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null || running || status === "created" || status === "stopped"}
            onClick={() => void action("stop")}
          >
            <Square className="h-4 w-4" /> Parar
          </Button>
          <Button
            variant="success"
            size="sm"
            disabled={busy !== null || running || status === "running" || status === "created"}
            onClick={() => void action("start")}
          >
            <Play className="h-4 w-4" /> Iniciar
          </Button>
          <Button
            variant="deploy"
            size="sm"
            disabled={busy !== null || running}
            onClick={() => void deployWithGuardrails()}
          >
            {busy === "deploy" || running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Deploy
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="action-error"
          className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">{error}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label="Fechar aviso" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {pollProblem && (
        <p
          role="status"
          data-testid="poll-problem"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          <span className="min-w-0 break-words">{pollProblem}</span>
        </p>
      )}

      {guardrailReport && (
        <GuardrailOverrideModal
          report={guardrailReport}
          busy={busy === "deploy"}
          onCancel={() => setGuardrailReport(null)}
          onConfirm={() => void doDeploy(true)}
        />
      )}
      {missingEnv && (
        <MissingEnvModal projectId={project.id} missing={missingEnv} onClose={() => setMissingEnv(null)} />
      )}
      {openJobId && (
        <DeployDetailModal projectId={project.id} jobId={openJobId} onClose={() => setOpenJobId(null)} />
      )}

      <div className="flex flex-col gap-6 md:flex-row">
        <nav
          data-testid="project-nav"
          aria-label="Seções do projeto"
          className="flex shrink-0 gap-1 overflow-x-auto text-sm md:w-44 md:flex-col"
        >
          {PROJECT_SECTIONS.map(({ key, label, icon: Icon }) => (
            <NavLink
              key={key}
              to={key === "overview" ? `/projects/${project.id}` : `/projects/${project.id}/${key}`}
              end
              className={() =>
                cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors",
                  section === key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
      {section === "overview" && (
        <>
      <ProjectOverview
        project={project}
        status={status}
        containers={containers}
        jobs={jobs}
        latestJob={activeJob && activeJob.id === jobs[0]?.id ? activeJob : null}
        onOpenJob={setOpenJobId}
        onChanged={() => void refresh()}
        onDeploy={() => void deployWithGuardrails()}
      />

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

        </>
      )}

      {section === "domains" && (
        <ProjectDomainsCard project={project} publicIp={publicIp} onChanged={() => void refresh()} />
      )}

      {section === "git" && (
        <ProjectConfigCard
          key={`git-${project.updatedAt}`}
          section="git"
          project={project}
          credential={credential}
          repoVisibility={repoVisibility}
          onSaved={() => void refresh()}
        />
      )}

      {section === "env" && searchParams.get("deploy") === "pending" && (
        <p
          data-testid="deploy-pending"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          O projeto foi criado, mas o compose exige variáveis obrigatórias que ainda não têm valor — o deploy falharia
          sem elas. Preencha as que faltam, salve e clique em Deploy, no topo da página.
        </p>
      )}
      {section === "env" && <ProjectEnvCard project={project} />}

      {section === "email" && (
        <ProjectEmailCard
          projectId={project.id}
          projectName={project.name}
          projectSlug={project.slug}
          projectDomain={project.domain ?? undefined}
        />
      )}

      {section === "deploys" && <DeployHistory jobs={jobs} onOpen={setOpenJobId} />}

      {section === "settings" && (
        <>
      <ProjectConfigCard
        key={`general-${project.updatedAt}`}
        section="general"
        project={project}
        onSaved={() => void refresh()}
      />
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
        </>
      )}
        </div>
      </div>
    </div>
  );
}
