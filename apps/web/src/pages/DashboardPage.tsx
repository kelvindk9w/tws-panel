import { useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  DockerContainersResponse,
  ProjectListResponse,
  ProjectResponse,
  ProjectStatus,
} from "@paas/core";
import { apiFetch, getSetupToken } from "@/lib/api";
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
  switch (status) {
    case "running":
      return <Badge variant="success">rodando</Badge>;
    case "stopped":
      return <Badge variant="secondary">parado</Badge>;
    case "deploying":
      return <Badge variant="warning">deployando…</Badge>;
    case "error":
      return <Badge variant="destructive">erro</Badge>;
    case "created":
      return <Badge variant="outline">criado</Badge>;
  }
}

export const TYPE_LABELS: Record<string, string> = {
  "static-node": "estático (Node)",
  compose: "compose adotado",
  dockerfile: "dockerfile",
  unknown: "desconhecido",
};

function ProjectCard({ item }: { item: ProjectResponse }) {
  const { project, status, containers, url } = item;
  return (
    <Card>
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
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
          >
            {project.domain}
            <ExternalLink className="h-3 w-3" />
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">
          {project.detection ? TYPE_LABELS[project.detection.type] : "não detectado"}
        </Badge>
        <span>
          {containers.length} container(es)
          {containers.length > 0 &&
            ` · ${containers.filter((c) => c.state === "running").length} ativo(s)`}
        </span>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [containers, setContainers] = useState<DockerContainersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
      setError(err instanceof Error ? err.message : "Falha ao carregar.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, []);

  const external = (containers?.containers ?? []).filter((c) => !c.managed);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projetos</h1>
          <p className="text-sm text-muted-foreground">
            Deploys gerenciados pelo painel, com domínio via Caddy central.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            Atualizar
          </Button>
          <Button size="sm" asChild>
            <Link to="/projects/new">
              <Plus className="h-4 w-4" />
              Novo Projeto
            </Link>
          </Button>
        </div>
      </div>

      {!getSetupToken() && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 text-sm text-amber-400">
            Sessão sem setup token — abra o <Link to="/setup" className="underline">setup</Link> com
            o link fornecido pelo instalador para autenticar.
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </p>
      )}

      {data && data.projects.length === 0 && !loading && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Server className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Nenhum projeto ainda. Crie o primeiro para fazer deploy com domínio automático.
            </p>
            <Button size="sm" asChild>
              <Link to="/projects/new">
                <Plus className="h-4 w-4" /> Criar projeto
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {data?.projects.map((item) => <ProjectCard key={item.project.id} item={item} />)}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Box className="h-5 w-5" /> Containers externos
          <span className="text-sm font-normal text-muted-foreground">
            (existem no Docker, mas não são gerenciados pelo painel — nunca são alterados)
          </span>
        </h2>
        <Card>
          <CardContent className="p-0">
            {external.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Nenhum container externo encontrado.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Nome</th>
                    <th className="px-4 py-2 font-medium">Imagem</th>
                    <th className="px-4 py-2 font-medium">Stack</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {external.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{c.name}</td>
                      <td className="px-4 py-2 font-mono text-xs">{c.image}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {c.composeProject ?? "—"}
                      </td>
                      <td className="px-4 py-2">
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
