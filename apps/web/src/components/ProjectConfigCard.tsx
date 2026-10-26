/**
 * Card de configuração do projeto, em duas seções do menu do projeto:
 *  - "git": repositório, branch, aviso do que está no ar e credencial de leitura
 *    (escondida quando o repositório é público);
 *  - "general": nome, slug fixo e WebSocket.
 * O domínio mora na seção Domínios (vários domínios por projeto).
 *
 * Edita o que é seguro editar depois da criação. O slug NÃO é editável — ele nomeia o
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
import { apiErrorText, formatDateTime, t as tGlobal, Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, Eye, GitBranch, KeyRound, Loader2, Settings, Trash2 } from "lucide-react";

export interface ProjectConfigCardProps {
  /** Seção do menu do projeto. */
  section: "git" | "general";
  project: Project;
  /** Seção Git: o repositório é público? (público = sem o bloco de token) */
  repoVisibility?: "public" | "private" | "unknown";
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
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  // formulário sempre aberto quando não há credencial; para substituir, o
  // operador precisa pedir — assim o estado "já cadastrada" fica evidente.
  const [editando, setEditando] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cadastrando = !credential.configured || editando;

  async function salvar() {
    if (token.trim().length === 0) return;
    setBusy("save");
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
      setError(apiErrorText(err, "projects.config.cred.saveError"));
    } finally {
      setBusy(null);
    }
  }

  async function remover() {
    setBusy("remove");
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/credential`, { method: "DELETE" });
      setConfirmandoRemocao(false);
      onSaved();
    } catch (err) {
      setError(apiErrorText(err, "projects.config.cred.removeError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" /> {t("projects.config.cred.title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("projects.config.cred.description")}
        </p>
      </div>

      {credential.configured ? (
        <div
          data-testid="credencial-resumo"
          className="flex flex-col gap-1 rounded-md border bg-secondary/40 px-3 py-2 text-sm"
        >
          <span>
            <Trans
              k="projects.config.cred.saved"
              params={{ hint: credential.hint ?? "????" }}
              components={{ code: <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs" /> }}
            />
          </span>
          <span className="text-xs text-muted-foreground">
            {t("projects.config.cred.user", { user: credential.username ?? "—" })}
            {credential.updatedAt
              ? t("projects.config.cred.updatedAt", { date: formatDateTime(credential.updatedAt) })
              : ""}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("projects.config.cred.none")}
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
              <Trans
                k="projects.config.cred.readOnly"
                components={{
                  b: <strong />,
                  em: <em />,
                  code: <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-xs" />,
                }}
              />
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-token" className="text-sm font-medium">
                {t("projects.config.cred.tokenLabel")}
              </label>
              <PasswordInput
                id="cfg-token"
                revealLabel={t("projects.config.cred.revealToken")}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("projects.config.cred.tokenPlaceholder")}
              />
              <span className="text-xs text-muted-foreground">
                {t("projects.config.cred.tokenHint")}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-cred-usuario" className="text-sm font-medium">
                {t("projects.config.cred.usernameLabel")}
              </label>
              <Input
                id="cfg-cred-usuario"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                placeholder={DEFAULT_GIT_CREDENTIAL_USERNAME}
              />
              <span className="text-xs text-muted-foreground">
                {t("projects.config.cred.usernameHint", { user: DEFAULT_GIT_CREDENTIAL_USERNAME })}
              </span>
            </div>
          </div>
        </>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {confirmandoRemocao ? (
        <div className="flex flex-col gap-3 rounded-md border border-destructive/40 px-3 py-3">
          <p className="text-sm">
            {t("projects.config.cred.removeConfirm")}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirmandoRemocao(false)}
            >
              {t("projects.config.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy !== null}
              onClick={() => void remover()}
            >
              {busy === "remove" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t("projects.config.cred.confirmRemove")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {cadastrando ? (
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => void salvar()}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("projects.config.cred.save")}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditando(true)}>
              {t("projects.config.cred.replace")}
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
              <Trash2 className="h-4 w-4" /> {t("projects.config.cred.remove")}
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
              {t("projects.config.cred.discard")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Projeto criado por um token de API limitado: o painel NÃO usa a conta GitHub conectada para
 * clonar (só repositório público ou a credencial acima). Só a pessoa libera, com a senha (e o
 * código, se tem 2FA). Voltar a bloquear não pede nada.
 */
function ContaGithubSection({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [abrindo, setAbrindo] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function liberar(event: FormEvent) {
    event.preventDefault();
    if (password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/account-credential`, {
        method: "PUT",
        body: JSON.stringify({ allow: true, currentPassword: password, ...(code.trim() ? { code: code.trim() } : {}) }),
      });
      setPassword("");
      setCode("");
      setAbrindo(false);
      onSaved();
    } catch (err) {
      setError(apiErrorText(err, "projects.config.account.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="conta-github-bloqueada" className="mt-6 flex flex-col gap-3 border-t pt-5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" /> {t("projects.config.account.title")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("projects.config.account.body")}</p>
      {abrindo ? (
        <form onSubmit={(e) => void liberar(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            {t("projects.config.account.password")}
            <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t("projects.config.account.code")}
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || password.length === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("projects.config.account.confirm")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAbrindo(false)}>
              {t("projects.config.account.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setAbrindo(true)}>
            {t("projects.config.account.release")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Descreve a divergência entre o configurado e o publicado, ou null se não há. */
function divergencia(project: Project): string | null {
  if (project.deployedBranch === null && project.deployedSource === null) {
    // Houve tentativa e ela falhou: dizer isso, não "nunca houve deploy".
    if (project.lastDeployStatus === "failed") {
      return tGlobal("projects.config.divergence.lastFailed");
    }
    return tGlobal("projects.config.divergence.neverDeployed");
  }
  const partes: string[] = [];
  if (project.deployedBranch !== project.branch) {
    partes.push(tGlobal("projects.config.divergence.partBranch", { value: project.deployedBranch ?? "—" }));
  }
  if (project.deployedSource !== project.source) {
    partes.push(tGlobal("projects.config.divergence.partSource", { value: project.deployedSource ?? "—" }));
  }
  if (partes.length === 0) return null;
  const quando = project.lastDeployAt
    ? formatDateTime(project.lastDeployAt)
    : tGlobal("projects.config.divergence.unknownDate");
  return tGlobal("projects.config.divergence.live", { parts: partes.join(tGlobal("projects.config.divergence.and")), when: quando });
}

export function ProjectConfigCard({ section, project, repoVisibility = "unknown", credential, onSaved }: ProjectConfigCardProps) {
  const { t } = useI18n();
  const [name, setName] = useState(project.name);
  const [source, setSource] = useState(project.source);
  const [branch, setBranch] = useState(project.branch ?? "");
  const [websocket, setWebsocket] = useState(project.websocket);
  const [spa, setSpa] = useState(project.spa === true);
  const staticType = project.detection?.type === "static" || project.detection?.type === "static-node";
  const git = section === "git";
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aviso = git ? divergencia(project) : null;
  const cred = credential ?? SEM_CREDENCIAL;
  // Público: token não faz sentido — a não ser que um já esteja cadastrado (dá para remover).
  const mostrarCredencial = repoVisibility !== "public" || cred.configured;
  const ehGit = project.ingestMode === "git";

  /** Só envia o que mudou — evita PATCH que reescreve campos sem necessidade. */
  function alteracoes(): UpdateProjectRequest {
    const req: UpdateProjectRequest = {};
    if (!git && name !== project.name) req.name = name;
    if (!git && websocket !== project.websocket) req.websocket = websocket;
    if (!git && staticType && spa !== (project.spa === true)) req.spa = spa;
    if (git && ehGit && source !== project.source) req.source = source;
    if (git && ehGit && branch !== (project.branch ?? "")) req.branch = branch;
    return req;
  }

  async function salvar(publicar: boolean, event: FormEvent) {
    event.preventDefault();
    const req = alteracoes();
    if (Object.keys(req).length === 0 && !publicar) return;

    setBusy(publicar ? "publish" : "save");
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
      setError(apiErrorText(err, "projects.config.saveError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {git ? <GitBranch className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
          {git ? t("projects.config.titleGit") : t("projects.config.titleGeneral")}
        </CardTitle>
        <CardDescription>
          {git
            ? t("projects.config.descriptionGit")
            : t("projects.config.descriptionGeneral")}
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

          {!git && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cfg-nome" className="text-sm font-medium">
                {t("projects.config.name")}
              </label>
              <Input id="cfg-nome" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t("projects.config.slug")}</span>
              <p className="flex h-9 items-center rounded-md border border-dashed px-3 font-mono text-sm text-muted-foreground">
                {project.slug}
              </p>
              <span className="text-xs text-muted-foreground">
                {t("projects.config.slugHint")}
              </span>
            </div>
          </div>
          )}

          {!git && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={websocket}
                onChange={(e) => setWebsocket(e.target.checked)}
                className="h-4 w-4"
              />
              {t("projects.config.websocket")}
            </label>
          )}

          {!git && staticType && (
            <div data-testid="config-spa" className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={spa} onChange={(e) => setSpa(e.target.checked)} className="h-4 w-4" />
                {t("projects.config.spa")}
              </label>
              <span className="text-xs text-muted-foreground">{t("projects.config.spaHint")}</span>
            </div>
          )}

          {git && !ehGit && (
            <p className="text-sm text-muted-foreground">
              {t("projects.config.serverFolder", { source: project.source })}
            </p>
          )}

          {git && ehGit ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="cfg-repo" className="text-sm font-medium">
                  {t("projects.config.repository")}
                </label>
                <Input id="cfg-repo" value={source} onChange={(e) => setSource(e.target.value)} />
                <span className="text-xs text-muted-foreground">
                  {t("projects.config.repositoryHint")}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="cfg-branch" className="text-sm font-medium">
                  {t("projects.config.branch")}
                </label>
                <Input id="cfg-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
                <span className="text-xs text-muted-foreground">
                  {t("projects.config.branchHint")}
                </span>
              </div>
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy !== null} onClick={(e) => void salvar(true, e)}>
              {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("projects.config.saveAndPublish")}
            </Button>
            <Button type="submit" variant="outline" disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("projects.config.save")}
            </Button>
          </div>
        </form>

        {/*
          Fora do <form> de propósito: Enter no campo do token não pode disparar
          o "Salvar" da configuração, e form aninhado não é HTML válido.
        */}
        {git && ehGit && mostrarCredencial ? (
          <CredencialSection projectId={project.id} credential={cred} onSaved={onSaved} />
        ) : null}
        {git && ehGit && project.noAccountCredential ? (
          <ContaGithubSection projectId={project.id} onSaved={onSaved} />
        ) : null}
        {git && ehGit && !mostrarCredencial ? (
          <p className="mt-6 border-t pt-5 text-xs text-muted-foreground">
            {t("projects.config.publicRepo")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
