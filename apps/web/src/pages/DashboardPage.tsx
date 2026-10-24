import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type {
  DockerContainersResponse,
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
import {
  Box,
  ExternalLink,
  Globe,
  Loader2,
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
  unknown: "dashboard.type.unknown",
};

function ProjectCard({ item, updateBranch }: { item: ProjectResponse; updateBranch?: string | null }) {
  const { t } = useI18n();
  const { project, status, containers, url } = item;
  const provisional = useProvisionalHere(project.domain);
  return (
    <Card className="hover:bg-accent/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">
            <Link to={`/projects/${project.id}`} className="hover:underline">
              {project.name}
            </Link>
          </CardTitle>
          <StatusBadge status={status} />
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
        <span>
          {t("dashboard.card.containers", { n: containers.length })}
          {containers.length > 0 &&
            t("dashboard.card.active", { n: containers.filter((c) => c.state === "running").length })}
        </span>
        {updateBranch !== undefined && <UpdateBadge projectId={project.id} branch={updateBranch} />}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { t } = useI18n();
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [containers, setContainers] = useState<DockerContainersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  async function refresh() {
    try {
      const [projects, docker] = await Promise.all([
        apiFetch<ProjectListResponse>("/api/projects"),
        apiFetch<DockerContainersResponse>("/api/docker/containers"),
      ]);
      setData(projects);
      setContainers(docker);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "dashboard.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
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
        timer = setInterval(() => void refresh(), 15_000);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        void refresh();
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

  // Alerta de nova atualização (só aviso): só de projeto no ar (ou com erro); parado/criado/deployando ficam de fora.
  const updates = useProjectUpdateStatuses();
  const withUpdate = new Map<string, string | null>();
  for (const item of data?.projects ?? []) {
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
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
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
        items={(data?.projects ?? [])
          .filter((i) => withUpdate.has(i.project.id))
          .map((i) => ({ id: i.project.id, name: i.project.name, branch: withUpdate.get(i.project.id) ?? null }))}
      />
      {updates.failed && updates.loaded && (data?.projects.length ?? 0) > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("dashboard.update.unavailable")}
        </p>
      )}

      <MetricsStrip projects={(data?.projects ?? []).map((i) => ({ slug: i.project.slug, id: i.project.id, name: i.project.name }))} />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("dashboard.loading")}
        </p>
      )}

      {data && data.projects.length === 0 && !loading && (
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

      <div className="grid gap-4 sm:grid-cols-2">
        {data?.projects.map((item) => (
          <ProjectCard key={item.project.id} item={item} {...(withUpdate.has(item.project.id) ? { updateBranch: withUpdate.get(item.project.id) ?? null } : {})} />
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
            {external.length === 0 ? (
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
