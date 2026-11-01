import { IpInAddressHint } from "@/components/IpInAddress";
import { ActionNotice, NoticeRegion } from "@/components/ActionNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { guardrailBlockKey } from "@paas/core";
import type {
  DeployJob,
  DeployJobListResponse,
  ProjectBasicResponse,
  DeployJobResponse,
  GuardrailReport,
  GuardrailReportResponse,
  ProjectResponse,
  ProjectStatus,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorText, t as tGlobal, Trans, useI18n, type Key } from "@/i18n";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { ProjectConfigCard } from "@/components/ProjectConfigCard";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { ProjectDynamicDomainsCard } from "@/components/project/ProjectDynamicDomainsCard";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { DeployDetailModal } from "@/components/project/DeployDetailModal";
import { DeployHistory } from "@/components/project/DeployHistory";
import { MissingEnvModal } from "@/components/project/MissingEnvModal";
import { ProjectEmailCard } from "@/components/project/ProjectEmailCard";
import { UpdateNotice } from "@/components/project/UpdateNotice";
import { useProjectUpdateStatus } from "@/lib/update-status";
import { SendLogSection } from "@/components/envios/SendLogSection";
import { RefusalsSection } from "@/components/envios/RefusalsSection";
import { MailDiagnosisPanel } from "@/components/envios/MailDiagnosisPanel";
import { ProjectNotices } from "@/components/project/ProjectNotices";
import { ProjectTimezoneCard } from "@/components/project/ProjectTimezoneCard";
import { MailTestBanner } from "@/components/project/MailTestBanner";
import { MailTestSection } from "@/components/project/MailTestSection";
import { ProjectBackupsCard } from "@/components/project/ProjectBackupsCard";
import { ProjectLogsSection } from "@/components/project/ProjectLogsSection";
import { ProjectDatabaseSection } from "@/components/project/ProjectDatabaseSection";
import { ProjectResourcesSection } from "@/components/project/ProjectResourcesSection";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Database,
  DatabaseBackup,
  ExternalLink,
  GitBranch,
  Globe,
  LayoutDashboard,
  Inbox,
  Loader2,
  Mail,
  Play,
  Rocket,
  ScrollText,
  Send,
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
  error = null,
}: {
  report: GuardrailReport;
  busy: boolean;
  onCancel: () => void;
  /** Recebe a reautenticação (senha + código do app + código por e-mail): sem ela o servidor recusa o override. */
  onConfirm: (reauth: Reauth) => void;
  /** Erro da última tentativa (senha ou código errado, sem 2FA…), mostrado dentro do diálogo. */
  error?: string | null;
}) {
  const { t } = useI18n();
  const [accepted, setAccepted] = useState(false);
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  // 80/443 com proxy HTTPS próprio: forçar não adianta — o `up` falharia com
  // "porta já em uso" (ou tomaria o lugar do proxy do painel)
  const noOverride = report.findings.some((f) => f.level === "block" && f.rule === "proxy-port-conflict");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-auto rounded-xl border border-red-500/40 bg-background p-6 shadow-2xl">
        <div className="flex items-center gap-2 text-lg font-semibold text-red-400">
          <ShieldAlert className="h-5 w-5" /> {t("projects.detail.guardrail.title")}
        </div>
        <p className="text-sm text-muted-foreground">
          <Trans
            k={report.warnings > 0 ? "projects.detail.guardrail.summaryWithWarnings" : "projects.detail.guardrail.summary"}
            params={{ blockers: report.blockers, warnings: report.warnings }}
            components={{ b: <strong /> }}
          />
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
              {t("projects.detail.guardrail.noOverride")}
            </p>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onCancel}>
                {t("projects.detail.guardrail.close")}
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
              {t("projects.detail.guardrail.accept")}
            </label>
            {accepted && (
              <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-xs text-muted-foreground">{t("projects.detail.guardrail.reauth")}</p>
                <ReauthFields idPrefix="override" action="deploy.override" value={reauth} onChange={setReauth} />
              </div>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                {t("projects.detail.guardrail.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!accepted || busy || reauth.password.length === 0 || reauth.code.trim().length === 0}
                onClick={() => {
                  onConfirm(reauth);
                  setReauth({ ...reauth, code: "", emailCode: "" });
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                {t("projects.detail.guardrail.confirm")}
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
 * real (vitrine, 03/10/2026): durante o deploy aparecia um texto vermelho
 * acima do menu do projeto, que sumia na consulta seguinte — ninguém
 * conseguia ler. As causas esperadas viram frase simples; durante o deploy, é
 * estado normal.
 */
function pollProblemText(err: unknown, deploying: boolean): string {
  if (err instanceof ApiRequestError && err.status === 429) {
    return tGlobal("projects.detail.poll.rateLimited");
  }
  if (deploying) {
    return tGlobal("projects.detail.poll.deploying");
  }
  if (err instanceof ApiRequestError && err.status === 0) {
    return tGlobal("projects.detail.poll.offline");
  }
  const detail = err instanceof Error ? err.message : String(err);
  return tGlobal("projects.detail.poll.failed", { detail });
}

type LifecycleKind = "stop" | "start";

/** Quantas vezes (e de quanto em quanto tempo) o painel confere o estado real depois de parar/iniciar. */
const CONFIRM_ATTEMPTS = 20;
const CONFIRM_INTERVAL_MS = 1_500;
/** Para confirmar, o estado esperado precisa aparecer em duas leituras seguidas (com este intervalo). */
const STABLE_INTERVAL_MS = 1_000;
const STABLE_READS = 2;

/** Linhas do log da remoção que indicam algo que NÃO foi removido. */
function removalLeftovers(log: unknown): string[] {
  if (typeof log !== "string") return [];
  return log.split("\n").filter((l) => /^(NÃO removido|Aviso|compose down:)/.test(l.trim()));
}

function wasPublished(p: ProjectResponse["project"]): boolean {
  return p.lastDeployStatus === "success" || (p.deployedSource ?? null) !== null;
}

/** Parar vale quando nenhum container roda; iniciar, só com o projeto "em execução". */
function reachedExpected(kind: LifecycleKind, status: ProjectStatus): boolean {
  return kind === "stop" ? status === "stopped" || status === "error" || status === "created" : status === "running";
}

/** Seções do projeto — cada uma com o seu endereço (/projects/:id/:seção). */
const PROJECT_SECTIONS = [
  { key: "overview", label: "projects.detail.nav.overview", icon: LayoutDashboard },
  { key: "deploys", label: "projects.detail.nav.deploys", icon: Rocket },
  { key: "domains", label: "projects.detail.nav.domains", icon: Globe },
  { key: "git", label: "projects.detail.nav.git", icon: GitBranch },
  { key: "env", label: "projects.detail.nav.env", icon: Variable },
  { key: "email", label: "projects.detail.nav.email", icon: Mail },
  { key: "mailTest", label: "projects.detail.nav.mailTest", icon: Inbox },
  { key: "sends", label: "projects.detail.nav.sends", icon: Send },
  { key: "logs", label: "projects.detail.nav.logs", icon: ScrollText },
  { key: "resources", label: "projects.detail.nav.resources", icon: Activity },
  { key: "database", label: "database.nav", icon: Database },
  { key: "backups", label: "projects.detail.nav.backups", icon: DatabaseBackup },
  { key: "settings", label: "projects.detail.nav.settings", icon: Settings },
] as const satisfies ReadonlyArray<{ key: string; label: Key; icon: unknown }>;
type ProjectSectionKey = (typeof PROJECT_SECTIONS)[number]["key"];

export function ProjectDetailPage() {
  const { t } = useI18n();
  const { id, section: sectionParam } = useParams<{ id: string; section?: string }>();
  const section: ProjectSectionKey = PROJECT_SECTIONS.some((s) => s.key === sectionParam)
    ? (sectionParam as ProjectSectionKey)
    : "overview";
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [repoVisibility, setRepoVisibility] = useState<"public" | "private" | "unknown">("unknown");
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectResponse | null>(null);
  // O cadastro do projeto (nome, endereço) chega rápido; o estado vivo (Docker) demora mais. Enquanto o vivo não
  // chega, `data` guarda o cadastro com status/containers provisórios e a tela mostra esses pontos como "carregando".
  const [liveStatus, setLiveStatus] = useState<"loading" | "ready" | "error">("loading");
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
  // resultado de parar/iniciar: sucesso, ou "não consegui confirmar" (nunca sucesso sem conferir)
  const [notice, setNotice] = useState<{
    tone: "success" | "warning";
    title?: string;
    text: string;
    recheck?: LifecycleKind;
    /** sucesso que afirma um estado: sai de cena se o estado real deixar de bater */
    confirms?: LifecycleKind;
  } | null>(null);
  const [retryKind, setRetryKind] = useState<LifecycleKind | "delete" | null>(null);
  // instante da última leitura confirmada: respostas mais antigas do polling são ignoradas
  const confirmedAt = useRef(0);
  // "geração" da página: muda ao trocar de projeto/desmontar; resposta de uma geração antiga é descartada
  const generation = useRef(0);
  const busyRef = useRef(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<LifecycleKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [guardrailReport, setGuardrailReport] = useState<GuardrailReport | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  /** Muda quando a lista de bloqueios muda: o diálogo recomeça (aceite desmarcado) e a pessoa aceita de novo. */
  const [overrideKey, setOverrideKey] = useState(0);
  // ?deploy=1 (vindo do assistente): o primeiro deploy começa sozinho, uma vez
  const [searchParams, setSearchParams] = useSearchParams();
  const autoDeployDone = useRef(false);
  // o cadastro rápido (/basic) é pedido uma vez por projeto aberto, não a cada ciclo
  const basicRequested = useRef(false);
  // detalhe de um deploy (janela) e variáveis que faltam (deploy recusado)
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [missingEnv, setMissingEnv] = useState<string[] | null>(null);

  // Alerta de nova atualização (só aviso). Refeito quando o projeto muda: fim de um deploy, outra branch.
  const updateKey = `${data?.project.lastDeployAt ?? ""}|${data?.project.deployedCommit ?? ""}|${data?.project.branch ?? ""}|${data?.project.source ?? ""}`;
  const update = useProjectUpdateStatus(id, updateKey, data?.project.ingestMode === "git");

  const refresh = useCallback(async (): Promise<{ job: DeployJob | null; rateLimited: boolean }> => {
    if (!id) return { job: null, rateLimited: false };
    const startedAt = Date.now();
    const gen = generation.current;
    // Primeira carga: o cadastro (rápido, sem Docker) mostra a página já; o estado vivo preenche depois.
    if (!basicRequested.current) {
      basicRequested.current = true;
      apiFetch<ProjectBasicResponse>(`/api/projects/${id}/basic`)
        .then((basic) => {
          // resposta sem o formato do cadastro (proxy no meio, servidor antigo): ignora, o estado vivo traz o projeto
          if (generation.current !== gen || !basic?.project) return;
          setData((d) => (d && d.project.id === basic.project.id ? d : { ...basic, status: "created", containers: [] }));
        })
        .catch(() => {
          // tenta de novo no próximo ciclo
          basicRequested.current = false;
        });
    }
    // As duas leituras seguem em paralelo e cada uma entra na tela quando chega, sem esperar a outra.
    const projectRead = apiFetch<ProjectResponse>(`/api/projects/${id}`).then((project) => {
      // uma leitura iniciada antes da última confirmação pode estar velha: não a deixa desfazer a confirmação
      if (startedAt >= confirmedAt.current) setData(project);
      setLiveStatus("ready");
      deployingRef.current = project.status === "deploying";
      return project;
    });
    const jobsRead = apiFetch<DeployJobListResponse>(`/api/projects/${id}/jobs`).then((jobList) => {
      setJobs(jobList.jobs);
      return jobList;
    });
    const [projectResult, jobsResult] = await Promise.allSettled([projectRead, jobsRead]);
    if (projectResult.status === "fulfilled" && jobsResult.status === "fulfilled") {
      pollFailures.current = 0;
      loadedRef.current = true;
      setPollProblem(null);
      return { job: jobsResult.value.jobs[0] ?? null, rateLimited: false };
    }
    const err = projectResult.status === "rejected" ? projectResult.reason : (jobsResult as PromiseRejectedResult).reason;
    if (projectResult.status === "rejected") setLiveStatus((s) => (s === "ready" ? s : "error"));
    pollFailures.current += 1;
    // uma falha isolada não vira aviso (a próxima consulta costuma passar);
    // na primeira carga, sem nada na tela, o motivo aparece logo
    if (pollFailures.current >= 2 || !loadedRef.current) setPollProblem(pollProblemText(err, deployingRef.current));
    return {
      job: jobsResult.status === "fulfilled" ? (jobsResult.value.jobs[0] ?? null) : null,
      rateLimited: err instanceof ApiRequestError && err.status === 429,
    };
  }, [id]);

  // trocar de projeto (ou sair da página) invalida ações em andamento: o
  // resultado tardio do projeto anterior não pode aparecer no novo
  useEffect(() => {
    generation.current += 1;
    loadedRef.current = false;
    basicRequested.current = false;
    setLiveStatus("loading");
    busyRef.current = false;
    setBusy(null);
    setNotice(null);
    setRetryKind(null);
    setError(null);
    setConfirmDelete(false);
    setData((d) => (d && d.project.id !== id ? null : d));
    return () => {
      generation.current += 1;
    };
  }, [id]);

  // depois de parar/iniciar, o foco não pode ficar perdido no botão que desabilitou
  useEffect(() => {
    if (busy !== null || !focusNext.current) return;
    const el = (focusNext.current === "start" ? startButton : stopButton).current;
    focusNext.current = null;
    if (el && !el.disabled && (!document.activeElement || document.activeElement === document.body)) el.focus();
  }, [busy]);

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
  async function doDeploy(override: boolean, reauth?: Reauth) {
    if (!id) return;
    setBusy("deploy");
    setError(null);
    setOverrideError(null);
    try {
      const res = await apiFetch<DeployJobResponse>(`/api/projects/${id}/deploy`, {
        method: "POST",
        body: JSON.stringify({
          guardrailOverride: override,
          ...(override && reauth ? reauthPayload(reauth) : {}),
          // o override vale só para os bloqueios que esta tela mostrou
          ...(override ? { acceptedBlocks: (guardrailReport?.findings ?? []).filter((f) => f.level === "block").map(guardrailBlockKey) } : {}),
        }),
      });
      setActiveJob(res.job);
      setGuardrailReport(null);
      if (res.alertWarning) setError(res.alertWarning);
    } catch (err) {
      if (override && err instanceof ApiRequestError && err.code === "guardrail_changed" && err.data?.report) {
        // apareceu bloqueio novo: mostra a lista atual e pede para aceitar de novo
        setGuardrailReport(err.data.report as GuardrailReport);
        setOverrideKey((k) => k + 1);
        setOverrideError(apiErrorText(err, "projects.detail.guardrail.error"));
      } else if (override) {
        // o diálogo de override continua aberto e mostra o motivo (senha/código errado, sem 2FA…)
        setOverrideError(apiErrorText(err, "projects.detail.guardrail.error"));
      } else if (err instanceof ApiRequestError && err.code === "guardrail_blocked" && err.data?.report) {
        setGuardrailReport(err.data.report as GuardrailReport);
      } else if (err instanceof ApiRequestError && err.code === "missing_env" && Array.isArray(err.data?.missing)) {
        setGuardrailReport(null);
        setMissingEnv(err.data.missing as string[]);
      } else {
        setError(apiErrorText(err, "projects.detail.deployError"));
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
    // qualquer deploy (clique ou ?deploy=1) encerra o deploy automático: não repete quando o estado voltar
    autoDeployDone.current = true;
    // e tira ?deploy=1 do endereço (sem entrada no histórico): recarregar a página não repete o deploy
    if (searchParams.get("deploy") === "1") {
      const rest = new URLSearchParams(searchParams);
      rest.delete("deploy");
      setSearchParams(rest, { replace: true });
    }
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
    if (!data || liveStatus !== "ready" || autoDeployDone.current || searchParams.get("deploy") !== "1") return;
    autoDeployDone.current = true;
    setSearchParams({}, { replace: true });
    void deployWithGuardrails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, liveStatus, searchParams]);

  /** Clique no aviso de atualização: o MESMO fluxo do botão Deploy (guardrails, variáveis); nunca publica sozinho. */
  function deployFromNotice() {
    void deployWithGuardrails();
    // fora da Visão geral e dos Deploys o andamento não aparece: leva para onde o deploy é acompanhado
    if (id && section !== "overview" && section !== "deploys") navigate(`/projects/${id}/deploys`);
  }

  /**
   * Confere o estado REAL do projeto na API (não confia só no "ok" do POST).
   * Devolve "ok" quando chegou ao estado esperado, "diverged" (com o estado
   * visto) se não chegou dentro do prazo, "unknown" se a consulta falhou e
   * "stale" se o usuário já saiu deste projeto.
   */
  async function confirmState(
    kind: LifecycleKind,
    runId: number,
  ): Promise<
    { result: "ok"; published: boolean } | { result: "unknown" | "stale" } | { result: "diverged"; status: ProjectStatus }
  > {
    let last: ProjectStatus | null = null;
    let streak = 0;
    let published = true;
    for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
      try {
        const res = await apiFetch<ProjectResponse>(`/api/projects/${id}`);
        if (generation.current !== runId) return { result: "stale" };
        confirmedAt.current = Date.now();
        setData(res);
        setLiveStatus("ready");
        last = res.status;
        published = wasPublished(res.project);
        if (reachedExpected(kind, res.status)) {
          streak += 1;
          if (streak >= STABLE_READS) return { result: "ok", published };
        } else {
          streak = 0;
        }
      } catch {
        if (generation.current !== runId) return { result: "stale" };
        last = null;
        streak = 0;
      }
      if (i < CONFIRM_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, streak > 0 ? STABLE_INTERVAL_MS : CONFIRM_INTERVAL_MS));
        if (generation.current !== runId) return { result: "stale" };
      }
    }
    if (streak > 0) return { result: "ok", published };
    return last ? { result: "diverged", status: last } : { result: "unknown" };
  }

  function reportConfirmation(kind: LifecycleKind, outcome: Awaited<ReturnType<typeof confirmState>>) {
    if (outcome.result === "stale") return;
    if (outcome.result === "ok") {
      setNotice({
        tone: "success",
        title: t(kind === "stop" ? "projects.detail.stopDone.title" : "projects.detail.startDone.title"),
        text: t(
          kind === "start"
            ? "projects.detail.startDone.body"
            : outcome.published
              ? "projects.detail.stopDone.body"
              : "projects.detail.stopDone.bodyPending",
        ),
        confirms: kind,
      });
      focusNext.current = kind === "stop" ? "start" : "stop";
    } else {
      setNotice({
        tone: "warning",
        text:
          outcome.result === "diverged"
            ? t(kind === "stop" ? "projects.detail.notConfirmed.stop" : "projects.detail.notConfirmed.start", {
                status: t(`dashboard.status.${outcome.status}` as Key),
              })
            : t("projects.detail.notConfirmed.unknown"),
        recheck: kind,
      });
      focusNext.current = kind;
    }
  }

  async function action(kind: LifecycleKind) {
    if (!id || busyRef.current) return;
    busyRef.current = true;
    const runId = generation.current;
    setBusy(kind);
    setError(null);
    setNotice(null);
    setRetryKind(null);
    try {
      await apiFetch(`/api/projects/${id}/${kind}`, { method: "POST" });
      if (generation.current !== runId) return;
      reportConfirmation(kind, await confirmState(kind, runId));
    } catch (err) {
      if (generation.current !== runId) return;
      setError(apiErrorText(err, kind === "stop" ? "projects.detail.stopError" : "projects.detail.startError"));
      setRetryKind(kind);
      focusNext.current = kind;
      // timeout/queda de rede não provam que falhou: relê o estado real
      if (!(err instanceof ApiRequestError) || err.status === 0 || err.status >= 500) {
        await reconcileAfterError(kind, runId);
      }
    } finally {
      if (generation.current === runId) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  async function reconcileAfterError(kind: LifecycleKind, runId: number) {
    try {
      const res = await apiFetch<ProjectResponse>(`/api/projects/${id}`);
      if (generation.current !== runId) return;
      confirmedAt.current = Date.now();
      setData(res);
      setLiveStatus("ready");
      if (!reachedExpected(kind, res.status)) return;
      setError(null);
      setRetryKind(null);
      if (kind === "stop") {
        reportConfirmation(kind, { result: "ok", published: wasPublished(res.project) });
      } else {
        setNotice({ tone: "warning", text: t("projects.detail.startErrorButRunning") });
      }
    } catch {
      // sem leitura, o erro original continua valendo
    }
  }

  /** "Verificar de novo": só reconfere o estado, sem repetir o pedido. */
  async function recheck(kind: LifecycleKind) {
    if (!id || busyRef.current) return;
    busyRef.current = true;
    const runId = generation.current;
    setBusy(kind);
    setNotice(null);
    try {
      reportConfirmation(kind, await confirmState(kind, runId));
    } finally {
      if (generation.current === runId) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  async function remove() {
    if (!id || busyRef.current) return;
    busyRef.current = true;
    const runId = generation.current;
    const name = data?.project.name ?? "";
    setBusy("delete");
    setError(null);
    setRetryKind(null);
    try {
      const res = await apiFetch<{ ok?: boolean; log?: string } | undefined>(
        `/api/projects/${id}?deleteSource=${deleteSource}`,
        { method: "DELETE" },
      );
      const leftovers = removalLeftovers(res?.log);
      if (generation.current === runId) {
        // a lista mostra o aviso de "removido" (o projeto já não existe aqui)
        navigate("/", { state: { removedProject: name, removalLeftovers: leftovers } });
      } else {
        // o usuário já foi para outro projeto: não o tira de lá, só anuncia
        setNotice({
          tone: leftovers.length > 0 ? "warning" : "success",
          title: tGlobal(leftovers.length > 0 ? "dashboard.removed.titleLeftovers" : "dashboard.removed.title", { name }),
          text: leftovers.length > 0 ? leftovers.join("\n") : tGlobal("dashboard.removed.body"),
        });
      }
    } catch (err) {
      if (generation.current !== runId) return;
      setError(apiErrorText(err, "projects.detail.removeError"));
      setRetryKind("delete");
      busyRef.current = false;
      setBusy(null);
    }
  }

  // aviso de sucesso que afirma um estado: se o estado real mudar depois (outra aba, queda), troca por um verdadeiro
  useEffect(() => {
    if (!notice?.confirms || !data || data.project.id !== id || liveStatus !== "ready") return;
    if (reachedExpected(notice.confirms, data.status)) return;
    setNotice({
      tone: "warning",
      text: tGlobal("projects.detail.stateChanged", { status: tGlobal(`dashboard.status.${data.status}` as Key) }),
    });
  }, [data, notice, id, liveStatus]);

  if (!data) {
    // o cadastro ainda não chegou: o contorno da página já ocupa o lugar (título, endereço e cartão)
    return (
      <div className="flex flex-col gap-6" data-testid="project-skeleton" aria-busy="true">
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {pollProblem ?? error ?? t("projects.detail.loading")}
        </p>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-5 w-44" />
          </div>
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { project, status, containers, url, credential } = data;
  const running = status === "deploying";
  const liveReady = liveStatus === "ready";
  // deploy que falhou antes de criar containers: parar/iniciar dariam 409 no_containers
  const noContainers = status === "error" && containers.length === 0;

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
              {project.name}{" "}
              {liveReady ? (
                <StatusBadge status={status} />
              ) : liveStatus === "error" ? (
                <Badge variant="outline">{t("dashboard.status.unknown")}</Badge>
              ) : (
                <Skeleton data-testid="status-skeleton" className="h-[22px] w-16 rounded-full" />
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1 break-all text-sm text-muted-foreground hover:underline"
              >
                <Globe className="h-3.5 w-3.5 shrink-0" /> {project.domain} <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              <IpInAddressHint domain={project.domain} />
            </div>
          </div>
        </div>
        {/* celular: duas colunas embaixo do nome; tela larga: em linha, à direita */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button asChild size="sm" variant="info">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" /> {t("projects.detail.openSite")}
            </a>
          </Button>
          <Button
            ref={stopButton}
            variant="danger"
            size="sm"
            aria-describedby="lifecycle-hint"
            aria-busy={busy === "stop"}
            className={busy === "stop" ? "cursor-wait disabled:opacity-100" : undefined}
            disabled={busy !== null || !liveReady || running || noContainers || status === "created" || status === "stopped"}
            onClick={() => void action("stop")}
          >
            {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}{" "}
            {busy === "stop" ? t("projects.detail.stopping") : t("projects.detail.stop")}
          </Button>
          <Button
            ref={startButton}
            variant="success"
            size="sm"
            aria-describedby="lifecycle-hint"
            aria-busy={busy === "start"}
            className={busy === "start" ? "cursor-wait disabled:opacity-100" : undefined}
            disabled={busy !== null || !liveReady || running || noContainers || status === "running" || status === "created"}
            onClick={() => void action("start")}
          >
            {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{" "}
            {busy === "start" ? t("projects.detail.starting") : t("projects.detail.start")}
          </Button>
          <Button
            variant="deploy"
            size="sm"
            disabled={busy !== null || running || liveStatus === "loading"}
            onClick={() => void deployWithGuardrails()}
            title={t("projects.detail.deployTooltip")}
            aria-describedby="deploy-help"
          >
            {busy === "deploy" || running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {t("projects.detail.deploy")}
          </Button>
          <span id="deploy-help" className="sr-only">
            {t("projects.detail.deployTooltip")}
          </span>
        </div>
      </div>

      <p id="lifecycle-hint" data-testid="lifecycle-hint" className="-mt-3 text-xs text-muted-foreground">
        {t(noContainers ? "projects.detail.lifecycleNoContainers" : "projects.detail.lifecycleHint")}
      </p>
      <NoticeRegion>
        {notice && (
          <ActionNotice
            tone={notice.tone}
            title={notice.title}
            action={
              notice.recheck
                ? { label: t("projects.detail.recheck"), onClick: () => void recheck(notice.recheck!) }
                : undefined
            }
            onDismiss={() => setNotice(null)}
          >
            {notice.text}
          </ActionNotice>
        )}
      </NoticeRegion>
      {/* aviso de nova atualização: sem parar/sem projeto em deploy, e na aba Git quem mostra é o cartão completo */}
      {section !== "git" && liveReady && (status === "running" || status === "error") && (
        <UpdateNotice
          variant="banner"
          status={update.status}
          onDeploy={deployFromNotice}
          deployDisabled={busy !== null || running}
        />
      )}
      {error && (
        <ActionNotice
          tone="error"
          testId="action-error"
          action={
            retryKind
              ? {
                  label: t("projects.detail.retry"),
                  onClick: () => void (retryKind === "delete" ? remove() : action(retryKind)),
                }
              : undefined
          }
          onDismiss={() => {
            setError(null);
            setRetryKind(null);
          }}
        >
          {error}
        </ActionNotice>
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
          key={overrideKey}
          report={guardrailReport}
          busy={busy === "deploy"}
          error={overrideError}
          onCancel={() => {
            setGuardrailReport(null);
            setOverrideError(null);
          }}
          onConfirm={(reauth) => void doDeploy(true, reauth)}
        />
      )}
      {missingEnv && (
        <MissingEnvModal projectId={project.id} missing={missingEnv} onClose={() => setMissingEnv(null)} />
      )}
      {openJobId && (
        <DeployDetailModal projectId={project.id} jobId={openJobId} projectName={project.name} ingestMode={project.ingestMode} source={project.source} branch={project.branch ?? undefined} onClose={() => setOpenJobId(null)} />
      )}

      {section !== "mailTest" && <MailTestBanner projectId={project.id} />}
      {section === "overview" && <ProjectNotices projectId={project.id} />}
      <div className="flex flex-col gap-6 md:flex-row">
        <nav
          data-testid="project-nav"
          aria-label={t("projects.detail.navAria")}
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
              <Icon className="h-4 w-4" /> {t(label)}
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
        live={liveStatus}
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
              <AlertTriangle className="h-4 w-4" /> {t("projects.detail.guardrails", { n: project.detection.warnings.length })}
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
        <>
          <ProjectDomainsCard project={project} publicIp={publicIp} onChanged={() => void refresh()} />
          <ProjectDynamicDomainsCard project={project} />
        </>
      )}

      {section === "git" && project.ingestMode === "git" && (
        <UpdateNotice
          variant="full"
          status={update.status}
          failed={update.failed}
          onDeploy={deployFromNotice}
          deployDisabled={busy !== null || running}
          onCheck={() => void update.checkNow()}
          checking={update.checking}
          limited={update.limited}
        />
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
          {t("projects.detail.deployPending")}
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

      {section === "mailTest" && <MailTestSection projectId={project.id} />}
      {section === "sends" && (
        <div className="flex flex-col gap-6">
          <MailDiagnosisPanel projectId={project.id} />
          <SendLogSection projectId={project.id} />
          <RefusalsSection projectId={project.id} />
        </div>
      )}

      {section === "logs" && <ProjectLogsSection projectId={project.id} />}

      {section === "database" && <ProjectDatabaseSection projectId={project.id} projectName={project.name} />}

      {section === "resources" && <ProjectResourcesSection projectId={project.id} />}

      {section === "deploys" && <DeployHistory jobs={jobs} onOpen={setOpenJobId} />}

      {section === "backups" && <ProjectBackupsCard projectId={project.id} projectName={project.name} />}

      {section === "settings" && (
        <>
      <ProjectConfigCard
        key={`general-${project.updatedAt}`}
        section="general"
        project={project}
        onSaved={() => void refresh()}
      />
      <ProjectTimezoneCard projectId={project.id} onChanged={() => void refresh()} />
      <Card className="border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-destructive">{t("projects.detail.danger.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("projects.detail.danger.noNeedToStop")}</p>
          {!confirmDelete ? (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> {t("projects.detail.danger.remove")}
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                <Trans k="projects.detail.danger.confirm" params={{ name: project.name }} components={{ b: <strong /> }} />
              </p>
              {project.ingestMode !== "existing" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deleteSource}
                    onChange={(e) => setDeleteSource(e.target.checked)}
                    className="h-4 w-4"
                  />
                  {t("projects.detail.danger.deleteSource")}
                </label>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                  {t("projects.detail.danger.cancel")}
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
                  {busy === "delete" ? t("projects.detail.removing") : t("projects.detail.danger.confirmRemove")}
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
