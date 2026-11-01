import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type {
  DockerContainersResponse,
  ProjectBasicListResponse,
  ProjectBasicResponse,
  ProjectListResponse,
  ProjectResponse,
  ProjectStatus,
  ProjectType,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { ActionNotice, NoticeRegion } from "@/components/ActionNotice";
import { TwoFactorNudge } from "@/components/TwoFactorNudge";
import { ProvisionalAddressNotice, useProvisionalHere } from "@/components/project/ProvisionalAddressNotice";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import { MetricsStrip } from "@/components/metrics/MetricsStrip";
import { ReconciliationNotice } from "@/components/restore/ReconciliationNotice";
import { UpdateBadge, UpdateSummary } from "@/components/project/UpdateNotice";
import { useProjectUpdateStatuses } from "@/lib/update-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Box,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const { t } = useI18n();
  switch (status) {
    case "running":
      return <Badge variant="success">{t("dashboard.status.running")}</Badge>;
    case "stopped":
      return <Badge variant="secondary">{t("dashboard.status.stopped")}</Badge>;
    case "deploying":
      return <Badge variant="warning">{t("dashboard.status.deploying")}</Badge>;
    case "error":
      return <Badge variant="destructive">{t("dashboard.status.error")}</Badge>;
    case "created":
      return <Badge variant="outline">{t("dashboard.status.created")}</Badge>;
  }
}

export const TYPE_LABELS: Record<ProjectType, Key> = {
  static: "dashboard.type.static",
  "static-node": "dashboard.type.staticNode",
  compose: "dashboard.type.compose",
  dockerfile: "dashboard.type.dockerfile",
  // type genérico (servidor Node gerado pelo painel); hoje o único framework é o Next.js
  "node-server": "dashboard.type.nodeServerNext",
  unknown: "dashboard.type.unknown",
};

/** Estado vivo (Docker) de um projeto: `undefined` = ainda carregando; `"error"` = a consulta falhou. */
type LiveState = Pick<ProjectResponse, "status" | "containers"> | undefined | "error";

function ProjectCard({
  item,
  live,
  updateBranch,
}: {
  item: ProjectBasicResponse;
  live: LiveState;
  updateBranch?: string | null;
}) {
  const { t } = useI18n();
  const { project, url } = item;
  const provisional = useProvisionalHere(project.domain);
  return (
    <Card className="hover:bg-accent/30" data-testid="project-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">
            <Link to={`/projects/${project.id}`} className="hover:underline">
              {project.name}
            </Link>
          </CardTitle>
          {live === undefined ? (
            <Skeleton data-testid="status-skeleton" className="h-[22px] w-16 rounded-full" />
          ) : live === "error" ? (
            <Badge variant="outline">{t("dashboard.status.unknown")}</Badge>
          ) : (
            <StatusBadge status={live.status} />
          )}
        </div>
        <CardDescription className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5" />
          {provisional ? (
            <span>{project.domain}</span>
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              {project.domain}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </CardDescription>
        {provisional && <ProvisionalAddressNotice projectId={project.id} compact />}
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">
          {project.detection ? t(TYPE_LABELS[project.detection.type]) : t("dashboard.type.undetected")}
        </Badge>
        {live === undefined ? (
          <Skeleton data-testid="containers-skeleton" className="h-4 w-28" />
        ) : live === "error" ? (
          <span data-testid="live-error">{t("dashboard.card.liveUnavailable")}</span>
        ) : (
          <span>
            {t("dashboard.card.containers", { n: live.containers.length })}
            {live.containers.length > 0 &&
              t("dashboard.card.active", { n: live.containers.filter((c) => c.state === "running").length })}
          </span>
        )}
        {updateBranch !== undefined && <UpdateBadge projectId={project.id} branch={updateBranch} />}
      </CardContent>
    </Card>
  );
}

/** Placeholder de um cartão de projeto, do tamanho do cartão pronto (a lista não "pula" quando chega). */
function ProjectCardSkeleton() {
  return (
    <Card data-testid="project-card-skeleton">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-[22px] w-16 rounded-full" />
        </div>
        <Skeleton className="mt-1 h-5 w-48" />
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-[22px] w-24 rounded-full" />
        <Skeleton className="h-4 w-28" />
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { t } = useI18n();
  // Três leituras independentes, cada uma com o seu estado: a lista básica (só o cadastro, rápida), o estado
  // vivo dos projetos (Docker) e os containers externos (Docker). Nenhuma espera pelas outras nem derruba a tela.
  const [basic, setBasic] = useState<ProjectBasicListResponse | null>(null);
  const [basicError, setBasicError] = useState<string | null>(null);
  const [live, setLive] = useState<ProjectListResponse | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const [containers, setContainers] = useState<DockerContainersResponse | null>(null);
  const [containersFailed, setContainersFailed] = useState(false);
  // o roteiro "Deixe o painel pronto" está na tela? (null = ainda não sabe)
  const [checklistShown, setChecklistShown] = useState<boolean | null>(null);
  // vindo da remoção de um projeto: confirma o que aconteceu (uma vez só)
  const location = useLocation();
  const navigate = useNavigate();
  const [removed, setRemoved] = useState<{ name: string; leftovers: string[] } | null>(null);
  useEffect(() => {
    const st = location.state as { removedProject?: unknown; removalLeftovers?: unknown } | null;
    const name = st?.removedProject;
    if (typeof name === "string") {
      const left = Array.isArray(st?.removalLeftovers) ? (st.removalLeftovers as unknown[]).map(String) : [];
      setRemoved({ name, leftovers: left });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  async function loadBasic() {
    try {
      setBasic(await apiFetch<ProjectBasicListResponse>("/api/projects/basic"));
      setBasicError(null);
    } catch (err) {
      setBasicError(apiErrorText(err, "dashboard.loadError"));
    }
  }

  async function loadLive() {
    try {
      setLive(await apiFetch<ProjectListResponse>("/api/projects"));
      setLiveFailed(false);
    } catch {
      setLiveFailed(true);
    }
  }

  async function loadContainers() {
    try {
      setContainers(await apiFetch<DockerContainersResponse>("/api/docker/containers"));
      setContainersFailed(false);
    } catch {
      setContainersFailed(true);
    }
  }

  function refresh() {
    void loadBasic();
    void loadLive();
    void loadContainers();
  }

  useEffect(() => {
    refresh();
    // Polling de 15s PAUSADO com a aba oculta (antes: 5s ininterruptos — cada
    // ciclo batia no dockerd mesmo com a aba em background). Ao voltar para a
    // aba, atualiza na hora e retoma o intervalo.
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer === null && document.visibilityState !== "hidden") {
        timer = setInterval(refresh, 15_000);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        refresh();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const external = (containers?.containers ?? []).filter((c) => !c.managed);

  // A lista vem do cadastro (rápido). Se ela falhar mas o estado vivo chegar, ele também traz os projetos.
  const items: ProjectBasicResponse[] | null = basic?.projects ?? live?.projects ?? null;
  const liveById = new Map((live?.projects ?? []).map((p) => [p.project.id, p]));
  const liveOf = (id: string): LiveState => {
    const found = liveById.get(id);
    if (found) return found;
    return liveFailed && live === null ? "error" : undefined;
  };

  // Alerta de nova atualização (só aviso): só de projeto no ar (ou com erro); parado/criado/deployando ficam de fora.
  const updates = useProjectUpdateStatuses();
  const withUpdate = new Map<string, string | null>();
  for (const item of live?.projects ?? []) {
    if (item.status !== "running" && item.status !== "error") continue;
    const found = updates.statuses.find((s) => s.projectId === item.project.id);
    if (found?.state === "update_available") withUpdate.set(item.project.id, found.branch);
  }

  return (
    <div className="flex flex-col gap-8">
      {/* independente do roteiro: "o painel antigo tinha X ativo" depois de restaurar um backup */}
      <ReconciliationNotice />
      <NoticeRegion>
        {removed !== null && (
          <ActionNotice
            tone={removed.leftovers.length > 0 ? "warning" : "success"}
            testId="removed-notice"
            title={t(removed.leftovers.length > 0 ? "dashboard.removed.titleLeftovers" : "dashboard.removed.title", {
              name: removed.name,
            })}
            onDismiss={() => setRemoved(null)}
          >
            {removed.leftovers.length > 0 ? removed.leftovers.join("\n") : t("dashboard.removed.body")}
          </ActionNotice>
        )}
      </NoticeRegion>
      <OnboardingChecklist variant="dashboard" onVisibleChange={setChecklistShown} />
      {/* com o roteiro na tela, o passo 2 dele já fala do 2FA */}
      {checklistShown === false && <TwoFactorNudge />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("dashboard.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("dashboard.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
            {t("dashboard.refresh")}
          </Button>
          <Button size="sm" asChild>
            <Link to="/projects/new">
              <Plus className="h-4 w-4" />
              {t("dashboard.newProject")}
            </Link>
          </Button>
        </div>
      </div>

      <UpdateSummary
        items={(live?.projects ?? [])
          .filter((i) => withUpdate.has(i.project.id))
          .map((i) => ({ id: i.project.id, name: i.project.name, branch: withUpdate.get(i.project.id) ?? null }))}
      />
      {updates.failed && updates.loaded && (items?.length ?? 0) > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("dashboard.update.unavailable")}
        </p>
      )}

      <MetricsStrip projects={(items ?? []).map((i) => ({ slug: i.project.slug, id: i.project.id, name: i.project.name }))} />

      {basicError !== null && items === null && (
        <p role="alert" className="text-sm text-destructive">
          {basicError}
        </p>
      )}

      {items !== null && items.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary ring-1 ring-border">
              <Server className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-medium">{t("dashboard.empty.title")}</p>
              <p className="text-sm text-muted-foreground">
                {t("dashboard.empty.hint")}
              </p>
            </div>
            <Button size="sm" asChild>
              <Link to="/projects/new">
                <Plus className="h-4 w-4" /> {t("dashboard.empty.create")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2" aria-busy={items === null && basicError === null}>
        {items === null && basicError === null && (
          <>
            <span className="sr-only" role="status">
              {t("dashboard.loading")}
            </span>
            <ProjectCardSkeleton />
            <ProjectCardSkeleton />
          </>
        )}
        {items?.map((item) => (
          <ProjectCard
            key={item.project.id}
            item={item}
            live={liveOf(item.project.id)}
            {...(withUpdate.has(item.project.id) ? { updateBranch: withUpdate.get(item.project.id) ?? null } : {})}
          />
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Box className="h-5 w-5" /> {t("dashboard.external.title")}
          <span className="text-sm font-normal text-muted-foreground">
            {t("dashboard.external.note")}
          </span>
        </h2>
        <Card>
          <CardContent className="p-0">
            {containers === null && !containersFailed ? (
              <div data-testid="external-skeleton" className="flex flex-col gap-3 px-4 py-5" aria-busy="true">
                <span className="sr-only" role="status">
                  {t("dashboard.loading")}
                </span>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : containers === null ? (
              <p role="alert" data-testid="external-error" className="px-4 py-6 text-sm text-destructive">
                {t("dashboard.external.loadError")}
              </p>
            ) : external.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {t("dashboard.external.empty")}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">{t("dashboard.external.colName")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("dashboard.external.colImage")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("dashboard.external.colStack")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("dashboard.external.colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {external.map((c) => (
                    <tr key={c.id} className="border-b transition-colors last:border-0 hover:bg-accent/40">
                      <td className="px-4 py-2.5 font-mono text-xs">{c.name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{c.image}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {c.composeProject ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.state === "running" ? (
                          <Badge variant="success">{c.status}</Badge>
                        ) : (
                          <Badge variant="secondary">{c.status}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
