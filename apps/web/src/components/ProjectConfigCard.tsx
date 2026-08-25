/**
 * Card de configuração do projeto.
 *
 * Edita o que é seguro editar depois da criação: nome de exibição, URL do
 * repositório, branch e domínio. O slug NÃO é editável — ele nomeia o
 * diretório do clone, a imagem, o compose project e os containers, então
 * alterá-lo seria uma migração de infraestrutura, não uma renomeação.
 *
 * O card também compara a configuração atual com o que o último deploy
 * efetivamente publicou, para responder "qual branch está no ar agora?".
 */
import { useState, type FormEvent } from "react";
import type { Project, ProjectResponse, UpdateProjectRequest } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2, Settings } from "lucide-react";

export interface ProjectConfigCardProps {
  project: Project;
  /** Chamado após salvar com sucesso, para a página recarregar os dados. */
  onSaved: () => void;
}

/** Descreve a divergência entre o configurado e o publicado, ou null se não há. */
function divergencia(project: Project): string | null {
  if (project.deployedBranch === null && project.deployedSource === null) {
    return "Nenhum deploy publicado ainda — a configuração abaixo vale para o primeiro deploy.";
  }
  const partes: string[] = [];
  if (project.deployedBranch !== project.branch) {
    partes.push(`branch ${project.deployedBranch ?? "—"}`);
  }
  if (project.deployedSource !== project.source) {
    partes.push(`repositório ${project.deployedSource ?? "—"}`);
  }
  if (partes.length === 0) return null;
  const quando = project.lastDeployAt
    ? new Date(project.lastDeployAt).toLocaleString("pt-BR")
    : "data desconhecida";
  return `No ar: ${partes.join(" e ")} (deploy de ${quando}). Publique para aplicar as mudanças.`;
}

export function ProjectConfigCard({ project, onSaved }: ProjectConfigCardProps) {
  const [name, setName] = useState(project.name);
  const [source, setSource] = useState(project.source);
  const [branch, setBranch] = useState(project.branch ?? "");
  const [domain, setDomain] = useState(project.domain);
  const [busy, setBusy] = useState<"salvar" | "publicar" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aviso = divergencia(project);
  const ehGit = project.ingestMode === "git";

  /** Só envia o que mudou — evita PATCH que reescreve campos sem necessidade. */
  function alteracoes(): UpdateProjectRequest {
    const req: UpdateProjectRequest = {};
    if (name !== project.name) req.name = name;
    if (ehGit && source !== project.source) req.source = source;
    if (ehGit && branch !== (project.branch ?? "")) req.branch = branch;
    if (domain !== project.domain) req.domain = domain;
    return req;
  }

  async function salvar(publicar: boolean, event: FormEvent) {
    event.preventDefault();
    const req = alteracoes();
    if (Object.keys(req).length === 0 && !publicar) return;

    setBusy(publicar ? "publicar" : "salvar");
    setError(null);
    try {
      if (Object.keys(req).length > 0) {
        await apiFetch<ProjectResponse>(`/api/projects/${project.id}`, {
          method: "PATCH",
          body: JSON.stringify(req),
        });
      }
      if (publicar) {
        await apiFetch(`/api/projects/${project.id}/deploy`, {
          method: "POST",
          body: JSON.stringify({ guardrailOverride: false }),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar a configuração.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings className="h-4 w-4" /> Configuração
        </CardTitle>
        <CardDescription>
          Nome, origem do código e domínio. Mudanças de repositório ou branch são aplicadas no
          próximo deploy.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(e) => void salvar(false, e)}>
          {aviso ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{aviso}</span>
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-nome" className="text-sm font-medium">
                Nome
              </label>
              <Input id="cfg-nome" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Slug</span>
              <p className="flex h-9 items-center rounded-md border border-dashed px-3 font-mono text-sm text-muted-foreground">
                {project.slug}
              </p>
              <span className="text-xs text-muted-foreground">
                Fixo: identifica containers, imagem e diretório do projeto.
              </span>
            </div>
          </div>

          {ehGit ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="cfg-repo" className="text-sm font-medium">
                  Repositório
                </label>
                <Input id="cfg-repo" value={source} onChange={(e) => setSource(e.target.value)} />
                <span className="text-xs text-muted-foreground">
                  Trocar o repositório refaz o clone do zero no próximo deploy.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="cfg-branch" className="text-sm font-medium">
                  Branch
                </label>
                <Input id="cfg-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
                <span className="text-xs text-muted-foreground">
                  Ex.: main para produção, sandbox para testes.
                </span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5 sm:max-w-sm">
            <label htmlFor="cfg-dominio" className="text-sm font-medium">
              Domínio
            </label>
            <Input id="cfg-dominio" value={domain} onChange={(e) => setDomain(e.target.value)} />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy !== null} onClick={(e) => void salvar(true, e)}>
              {busy === "publicar" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salvar e publicar
            </Button>
            <Button type="submit" variant="outline" disabled={busy !== null}>
              {busy === "salvar" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salvar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
