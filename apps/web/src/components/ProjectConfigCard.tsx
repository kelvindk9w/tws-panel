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
import { DEFAULT_GIT_CREDENTIAL_USERNAME } from "@paas/core";
import type {
  Project,
  ProjectCredentialInfo,
  ProjectCredentialResponse,
  ProjectResponse,
  SetProjectCredentialRequest,
  UpdateProjectRequest,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Eye, KeyRound, Loader2, Settings, Trash2 } from "lucide-react";

export interface ProjectConfigCardProps {
  project: Project;
  /**
   * Existência (nunca o valor) da credencial de leitura do repositório. Vem
   * junto de toda ProjectResponse. Opcional para quem ainda não a repassa.
   */
  credential?: ProjectCredentialInfo;
  /** Chamado após salvar com sucesso, para a página recarregar os dados. */
  onSaved: () => void;
}

/** Estado neutro usado quando a página ainda não repassou a credencial. */
const SEM_CREDENCIAL: ProjectCredentialInfo = {
  configured: false,
  hint: null,
  username: null,
  updatedAt: null,
};

/**
 * Bloco da credencial de LEITURA do repositório privado.
 *
 * Mora no card de Configuração, logo abaixo de repositório/branch, porque é
 * exatamente a mesma decisão do operador: de onde o painel puxa o código. O
 * token entra aqui e some — o servidor guarda cifrado e nunca devolve o valor;
 * a interface só volta a mostrar a dica dos últimos caracteres.
 */
function CredencialSection({
  projectId,
  credential,
  onSaved,
}: {
  projectId: string;
  credential: ProjectCredentialInfo;
  onSaved: () => void;
}) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  // formulário sempre aberto quando não há credencial; para substituir, o
  // operador precisa pedir — assim o estado "já cadastrada" fica evidente.
  const [editando, setEditando] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [busy, setBusy] = useState<"salvar" | "remover" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cadastrando = !credential.configured || editando;

  async function salvar() {
    if (token.trim().length === 0) return;
    setBusy("salvar");
    setError(null);
    try {
      const req: SetProjectCredentialRequest = { token: token.trim() };
      if (username.trim().length > 0) req.username = username.trim();
      await apiFetch<ProjectCredentialResponse>(`/api/projects/${projectId}/credential`, {
        method: "PUT",
        body: JSON.stringify(req),
      });
      // some com o segredo da memória do componente e da tela
      setToken("");
      setUsername("");
      setEditando(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar a credencial.");
    } finally {
      setBusy(null);
    }
  }

  async function remover() {
    setBusy("remover");
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/credential`, { method: "DELETE" });
      setConfirmandoRemocao(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover a credencial.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" /> Credencial do repositório privado
        </h3>
        <p className="text-xs text-muted-foreground">
          Só é necessária para clonar repositórios privados. Fica cifrada no servidor e o valor
          nunca é exibido de volta.
        </p>
      </div>

      {credential.configured ? (
        <div
          data-testid="credencial-resumo"
          className="flex flex-col gap-1 rounded-md border bg-secondary/40 px-3 py-2 text-sm"
        >
          <span>
            Credencial cadastrada — token terminado em{" "}
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
              ••••{credential.hint ?? "????"}
            </code>
          </span>
          <span className="text-xs text-muted-foreground">
            Usuário: {credential.username ?? "—"}
            {credential.updatedAt
              ? ` · atualizada em ${new Date(credential.updatedAt).toLocaleString("pt-BR")}`
              : ""}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nenhuma credencial cadastrada. Repositórios públicos não precisam de uma.
        </p>
      )}

      {cadastrando ? (
        <>
          {/*
            A promessa central do produto, dita no momento em que o operador
            entrega o token: é por isso que o escopo pedido é o mínimo.
          */}
          <div
            data-testid="credencial-somente-leitura"
            className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300"
          >
            <Eye className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Acesso somente leitura.</strong> O painel apenas clona o repositório — nunca
              escreve, nunca commita, nunca faz push. Use um token de leitura de escopo mínimo: no
              GitHub, um <em>fine-grained personal access token</em> com a permissão{" "}
              <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs">
                Contents: Read
              </code>{" "}
              apenas para este repositório. Em outros provedores (GitLab, Bitbucket, Gitea), gere um
              token de acesso de leitura ao repositório.
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-token" className="text-sm font-medium">
                Token de leitura
              </label>
              <Input
                id="cfg-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="cole o token aqui"
              />
              <span className="text-xs text-muted-foreground">
                Guardado cifrado. Depois de salvo, só a dica dos últimos caracteres volta a aparecer.
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-cred-usuario" className="text-sm font-medium">
                Usuário do git (opcional)
              </label>
              <Input
                id="cfg-cred-usuario"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                placeholder={DEFAULT_GIT_CREDENTIAL_USERNAME}
              />
              <span className="text-xs text-muted-foreground">
                No GitHub qualquer valor serve com um PAT; em branco usa{" "}
                {DEFAULT_GIT_CREDENTIAL_USERNAME}.
              </span>
            </div>
          </div>
        </>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {confirmandoRemocao ? (
        <div className="flex flex-col gap-3 rounded-md border border-destructive/40 px-3 py-3">
          <p className="text-sm">
            Remover a credencial de leitura deste projeto? O próximo deploy de um repositório
            privado vai falhar até que uma nova seja cadastrada.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirmandoRemocao(false)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy !== null}
              onClick={() => void remover()}
            >
              {busy === "remover" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Confirmar remoção
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {cadastrando ? (
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => void salvar()}>
              {busy === "salvar" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salvar credencial
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditando(true)}>
              Substituir credencial
            </Button>
          )}
          {credential.configured ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => setConfirmandoRemocao(true)}
            >
              <Trash2 className="h-4 w-4" /> Remover credencial
            </Button>
          ) : null}
          {credential.configured && editando ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setToken("");
                setUsername("");
                setEditando(false);
              }}
            >
              Descartar
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
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

export function ProjectConfigCard({ project, credential, onSaved }: ProjectConfigCardProps) {
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

        {/*
          Fora do <form> de propósito: Enter no campo do token não pode disparar
          o "Salvar" da configuração, e form aninhado não é HTML válido.
        */}
        {ehGit ? (
          <CredencialSection
            projectId={project.id}
            credential={credential ?? SEM_CREDENCIAL}
            onSaved={onSaved}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
