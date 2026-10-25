import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  API_TOKEN_DEFAULT_TTL_HOURS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_SCOPES,
  validateApiTokenName,
  type ApiTokenInfo,
  type ApiTokenScope,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type ProjectListResponse,
  type TwoFactorStatusResponse,
  type UpdateApiTokenReachRequest,
  type UpdateApiTokenReachResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, useI18n, type Key } from "@/i18n";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, Ban, Bot, Loader2, Pencil } from "lucide-react";

const TTL_OPTIONS = [24, 168, 720, 2160, 8760] as const;
const TTL_KEY: Record<(typeof TTL_OPTIONS)[number], Key> = {
  24: "settings.apiAccess.form.ttl.24",
  168: "settings.apiAccess.form.ttl.168",
  720: "settings.apiAccess.form.ttl.720",
  2160: "settings.apiAccess.form.ttl.2160",
  8760: "settings.apiAccess.form.ttl.8760",
};
const SCOPE_KEY: Record<ApiTokenScope, { label: Key; desc: Key }> = {
  read: { label: "settings.apiAccess.scope.read", desc: "settings.apiAccess.scope.read.desc" },
  write: { label: "settings.apiAccess.scope.write", desc: "settings.apiAccess.scope.write.desc" },
  admin: { label: "settings.apiAccess.scope.admin", desc: "settings.apiAccess.scope.admin.desc" },
};
const STATUS_KEY = {
  active: "settings.apiAccess.status.active",
  expired: "settings.apiAccess.status.expired",
  revoked: "settings.apiAccess.status.revoked",
} as const satisfies Record<ApiTokenInfo["status"], Key>;

type ReachChoice = "panel" | "projects" | "projects-create" | "domains";
const REACH_KEY: Record<ReachChoice, { label: Key; desc: Key }> = {
  panel: { label: "settings.apiAccess.reach.panel", desc: "settings.apiAccess.reach.panel.desc" },
  projects: { label: "settings.apiAccess.reach.projects", desc: "settings.apiAccess.reach.projects.desc" },
  "projects-create": { label: "settings.apiAccess.reach.create", desc: "settings.apiAccess.reach.create.desc" },
  domains: { label: "settings.apiAccess.reach.domains", desc: "settings.apiAccess.reach.domains.desc" },
};

interface ProjectChoice {
  id: string;
  name: string;
}

/** Lista de projetos com caixas de marcar (alcance de um token). */
function ProjectPicker({
  projects,
  selected,
  onChange,
  loadError,
  legend,
}: {
  projects: ProjectChoice[] | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  loadError: string | null;
  legend: string;
}) {
  const { t } = useI18n();
  if (loadError) {
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
        {loadError}
      </p>
    );
  }
  if (projects === null) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("settings.apiAccess.projects.loading")}
      </p>
    );
  }
  if (projects.length === 0) return <p className="text-muted-foreground">{t("settings.apiAccess.projects.none")}</p>;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs text-muted-foreground">{legend}</legend>
      {projects.map((p) => (
        <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5 has-[:checked]:border-primary">
          <input
            type="checkbox"
            checked={selected.includes(p.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
          />
          <span className="min-w-0 break-words">{p.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Configurações → Acesso por IA. Criar, listar e revogar tokens de API (só com
 * a sessão humana; o servidor recusa token aqui). O valor do token aparece UMA
 * vez, logo depois de criar, e some ao fechar o aviso.
 */
export function ApiAccessSettings() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [maxActive, setMaxActive] = useState(20);
  // null = não deu para conferir (o campo do código aparece mesmo assim, com "tentar de novo")
  const [twoFactor, setTwoFactor] = useState<boolean | null>(false);
  const createdRef = useRef<HTMLElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("read");
  const [reach, setReach] = useState<ReachChoice>("panel");
  const [chosen, setChosen] = useState<string[]>([]);
  const [hostMetrics, setHostMetrics] = useState(false);
  const [projects, setProjects] = useState<ProjectChoice[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // edição da lista de um token existente
  const [editId, setEditId] = useState<string | null>(null);
  const [editChosen, setEditChosen] = useState<string[]>([]);
  const [editCreate, setEditCreate] = useState(false);
  const [editHost, setEditHost] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [editCode, setEditCode] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number>(API_TOKEN_DEFAULT_TTL_HOURS);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const ids = { name: useId(), nameHint: useId(), ttl: useId(), password: useId(), code: useId(), codeHint: useId() };

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<ListApiTokensResponse>("/api/settings/api-tokens");
      setTokens(res.tokens);
      setMaxActive(res.maxActive);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorText(err, "settings.apiAccess.error.load"));
    }
  }, []);

  const loadTwoFactor = useCallback(() => {
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setTwoFactor(s.enabled))
      .catch(() => setTwoFactor(null)); // o servidor exige o código se for preciso
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await apiFetch<ProjectListResponse>("/api/projects");
      setProjects(res.projects.map((p) => ({ id: p.project.id, name: p.project.name })));
      setProjectsError(null);
    } catch (err) {
      setProjectsError(apiErrorText(err, "settings.apiAccess.error.projects"));
    }
  }, []);

  useEffect(() => {
    void load();
    loadTwoFactor();
    void loadProjects();
  }, [load, loadTwoFactor, loadProjects]);

  // Token novo: leva o foco (e o leitor de tela) para o aviso com o segredo.
  useEffect(() => {
    if (created) createdRef.current?.focus();
  }, [created]);

  const trimmed = name.trim();
  const nameOk = validateApiTokenName(trimmed);
  const reachOk = reach === "panel" || reach === "projects-create" || chosen.length > 0;
  const canSubmit = nameOk && reachOk && password.length > 0 && (twoFactor !== true || code.trim().length > 0) && !busy;
  const active = (tokens ?? []).filter((x) => x.status === "active").length;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateApiTokenRequest = {
        name: trimmed,
        scope,
        ...(reach === "panel"
          ? {}
          : {
              reach: reach === "domains" ? ("domains" as const) : ("projects" as const),
              projects: chosen,
              canCreate: reach === "projects-create",
              // o token de domínios nunca vê o monitoramento da VPS: a opção nem é oferecida
              ...(hostMetrics && reach !== "domains" ? { hostMetrics: true } : {}),
            }),
        expiresInHours: ttl,
        currentPassword: password,
        ...(twoFactor !== false && code.trim() ? { code: code.trim() } : {}),
      };
      const res = await apiFetch<CreateApiTokenResponse>("/api/settings/api-tokens", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setCreated({ token: res.token, name: res.info.name });
      setName("");
      setPassword("");
      setCode("");
      setReach("panel");
      setChosen([]);
      setHostMetrics(false);
      await load();
    } catch (err) {
      setError(apiErrorText(err, "settings.apiAccess.error.create"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await apiFetch(`/api/settings/api-tokens/${id}`, { method: "DELETE" });
      setConfirmId(null);
      await load();
    } catch (err) {
      setRevokeError(apiErrorText(err, "settings.apiAccess.error.revoke"));
    } finally {
      setRevoking(null);
    }
  }

  function startEdit(tk: ApiTokenInfo) {
    setEditId(tk.id);
    setEditChosen(tk.projects);
    setEditCreate(tk.canCreate);
    setEditHost(tk.hostMetrics);
    setEditPassword("");
    setEditCode("");
    setEditError(null);
    void loadProjects();
  }

  // Aumentar o alcance (projeto novo ou "pode criar") pede a senha; reduzir não (o servidor decide igual).
  const editingToken = (tokens ?? []).find((x) => x.id === editId) ?? null;
  const editWidens =
    editingToken !== null &&
    (editChosen.some((id) => !editingToken.projects.includes(id)) || (editCreate && !editingToken.canCreate) || (editHost && !editingToken.hostMetrics));
  const editValid = editChosen.length > 0 || editCreate;
  const editReady =
    editValid && (!editWidens || (editPassword.length > 0 && (twoFactor !== true || editCode.trim().length > 0))) && !editBusy;

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editId || !editReady) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const body: UpdateApiTokenReachRequest = {
        projects: editChosen,
        canCreate: editCreate,
        // só quando mudou: cliente e servidor tratam ausente como "não muda"
        ...(editingToken && editHost !== editingToken.hostMetrics ? { hostMetrics: editHost } : {}),
        // a lista que a tela mostrava: se o token criou projeto nesse meio tempo, o servidor responde 409
        basedOn: editingToken?.projects ?? [],
        ...(editWidens ? { currentPassword: editPassword } : {}),
        ...(editWidens && twoFactor !== false && editCode.trim() ? { code: editCode.trim() } : {}),
      };
      await apiFetch<UpdateApiTokenReachResponse>(`/api/settings/api-tokens/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditId(null);
      await load();
    } catch (err) {
      setEditError(apiErrorText(err, "settings.apiAccess.error.edit"));
      // lista mudou por baixo: recarrega para a pessoa ver o que o token criou e reenviar
      if (err instanceof ApiRequestError && err.code === "token_reach_changed") {
        try {
          const res = await apiFetch<ListApiTokensResponse>("/api/settings/api-tokens");
          setTokens(res.tokens);
          const fresh = res.tokens.find((x) => x.id === editId);
          const seen = editingToken?.projects ?? [];
          // o que o token criou nesse meio tempo aparece marcado; a pessoa desmarca se não quiser e envia de novo
          if (fresh) setEditChosen((prev) => [...new Set([...prev, ...fresh.projects.filter((id) => !seen.includes(id))])]);
        } catch {
          /* a lista recarrega na próxima abertura */
        }
      }
    } finally {
      setEditBusy(false);
    }
  }

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" /> {t("settings.apiAccess.title")}
          </CardTitle>
          <CardDescription>{t("settings.apiAccess.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <p className="font-medium">{t("settings.apiAccess.never.title")}</p>
            <p className="text-muted-foreground">{t("settings.apiAccess.never.body")}</p>
          </div>
          <div data-testid="api-token-caveat" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <p className="font-medium">{t("settings.apiAccess.caveat.title")}</p>
            <p>{t("settings.apiAccess.caveat.body")}</p>
          </div>
        </CardContent>
      </Card>

      {created && (
        <section
          ref={createdRef}
          tabIndex={-1}
          role="status"
          data-testid="api-token-created"
          aria-labelledby="api-token-created-title"
          aria-describedby="api-token-created-warning"
          className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">{t("settings.apiAccess.created.announce", { name: created.name })}</span>
          <h2 id="api-token-created-title" className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-400" /> {t("settings.apiAccess.created.title")}
          </h2>
          <p id="api-token-created-warning">{t("settings.apiAccess.created.warning")}</p>
          <label htmlFor="api-token-value" className="font-medium">
            {t("settings.apiAccess.created.label")} <span className="text-muted-foreground">({created.name})</span>
          </label>
          <div className="flex min-w-0 items-center gap-1">
            <Input
              id="api-token-value"
              readOnly
              value={created.token}
              className="min-w-0 flex-1 font-mono text-xs"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton text={created.token} />
          </div>
          <Button variant="outline" className="self-start" onClick={() => setCreated(null)}>
            {t("settings.apiAccess.created.done")}
          </Button>
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.apiAccess.form.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void create(e)} className="flex max-w-lg flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.name} className="font-medium">
                {t("settings.apiAccess.form.name.label")}
              </label>
              <Input
                id={ids.name}
                value={name}
                maxLength={API_TOKEN_NAME_MAX_LENGTH}
                autoComplete="off"
                aria-describedby={ids.nameHint}
                aria-invalid={trimmed !== "" && !nameOk}
                onChange={(e) => setName(e.target.value)}
              />
              <p id={ids.nameHint} className="text-xs text-muted-foreground">
                {t("settings.apiAccess.form.name.hint")}
              </p>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium">{t("settings.apiAccess.form.scope.label")}</legend>
              {API_TOKEN_SCOPES.map((s) => (
                <label key={s} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-primary">
                  <input
                    type="radio"
                    name="api-token-scope"
                    value={s}
                    checked={scope === s}
                    onChange={() => {
                      setScope(s);
                      // "pode criar" só existe com administração: trocar de nível desfaz a escolha
                      if (s !== "admin" && reach === "projects-create") setReach("projects");
                      // "domínios do projeto" não existe com administração: trocar de nível desfaz a escolha
                      if (s === "admin" && reach === "domains") setReach("projects");
                    }}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{t(SCOPE_KEY[s].label)}</span>
                    <span className="block text-xs text-muted-foreground">{t(SCOPE_KEY[s].desc)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-col gap-2" data-testid="api-token-reach">
              <legend className="mb-1 font-medium">{t("settings.apiAccess.form.reach.label")}</legend>
              {(Object.keys(REACH_KEY) as ReachChoice[]).filter((r) => (r !== "projects-create" || scope === "admin") && (r !== "domains" || scope !== "admin")).map((r) => (
                <label key={r} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-primary">
                  <input type="radio" name="api-token-reach" value={r} checked={reach === r} onChange={() => setReach(r)} className="mt-1" />
                  <span className="min-w-0">
                    <span className="block font-medium">{t(REACH_KEY[r].label)}</span>
                    <span className="block text-xs text-muted-foreground">{t(REACH_KEY[r].desc)}</span>
                  </span>
                </label>
              ))}
              {reach !== "panel" && (
                <div data-testid="api-token-projects" className="flex flex-col gap-2 pl-1">
                  <ProjectPicker
                    projects={projects}
                    selected={chosen}
                    onChange={setChosen}
                    loadError={projectsError}
                    legend={reach === "projects-create" ? t("settings.apiAccess.projects.legendCreate") : t("settings.apiAccess.projects.legend")}
                  />
                  {(reach === "projects" || reach === "domains") && chosen.length === 0 && projects !== null && projects.length > 0 && (
                    <p className="text-xs text-muted-foreground">{t("settings.apiAccess.projects.pickOne")}</p>
                  )}
                  {reach !== "domains" && (
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-primary">
                      <input type="checkbox" checked={hostMetrics} onChange={(e) => setHostMetrics(e.target.checked)} className="mt-1" data-testid="api-token-host-metrics" />
                      <span className="min-w-0">
                        <span className="block font-medium">{t("settings.apiAccess.form.hostMetrics.label")}</span>
                        <span className="block text-xs text-muted-foreground">{t("settings.apiAccess.form.hostMetrics.desc")}</span>
                      </span>
                    </label>
                  )}
                </div>
              )}
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.ttl} className="font-medium">
                {t("settings.apiAccess.form.ttl.label")}
              </label>
              <select
                id={ids.ttl}
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {TTL_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {t(TTL_KEY[h])}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.password} className="font-medium">
                {t("settings.apiAccess.form.password.label")}
              </label>
              <PasswordInput
                id={ids.password}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {twoFactor !== false && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.code} className="font-medium">
                  {t("settings.apiAccess.form.code.label")}
                </label>
                <Input
                  id={ids.code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  aria-describedby={ids.codeHint}
                  onChange={(e) => setCode(e.target.value)}
                />
                <p id={ids.codeHint} className="text-xs text-muted-foreground">
                  {twoFactor === null ? t("settings.apiAccess.form.code.unknown") : t("settings.apiAccess.form.code.hint")}
                </p>
                {twoFactor === null && (
                  <Button type="button" variant="outline" size="sm" className="self-start" onClick={loadTwoFactor}>
                    {t("settings.apiAccess.form.code.retry")}
                  </Button>
                )}
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="self-start" disabled={!canSubmit}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.apiAccess.form.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.apiAccess.list.title")}</CardTitle>
          {tokens && <CardDescription>{t("settings.apiAccess.list.count", { active, max: maxActive })}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {tokens === null && !loadError && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("settings.apiAccess.list.loading")}
            </p>
          )}
          {loadError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              {loadError}
            </p>
          )}
          {revokeError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              {revokeError}
            </p>
          )}
          {tokens?.length === 0 && <p className="text-muted-foreground">{t("settings.apiAccess.list.empty")}</p>}
          {tokens && tokens.length > 0 && (
            <ul data-testid="api-token-list" className="flex flex-col gap-2">
              {tokens.map((tk) => (
                <li key={tk.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-medium">{tk.name}</span>
                    <Badge variant="outline">{t(SCOPE_KEY[tk.scope].label)}</Badge>
                    <Badge variant={tk.status === "active" ? "success" : tk.status === "expired" ? "warning" : "destructive"}>
                      {t(STATUS_KEY[tk.status])}
                    </Badge>
                  </div>
                  <p data-testid="api-token-reach-line" className="text-xs">
                    {tk.reach === "panel"
                      ? t("settings.apiAccess.item.reachPanel")
                      : tk.reach === "domains"
                        ? t("settings.apiAccess.item.reachDomains", { names: tk.projects.map(projectName).join(", ") })
                        : tk.projects.length === 0
                        ? t("settings.apiAccess.item.reachNone", { create: (tk.canCreate ? t("settings.apiAccess.item.reachCreate") : "") + (tk.hostMetrics ? t("settings.apiAccess.item.reachHostMetrics") : "") })
                        : t("settings.apiAccess.item.reachProjects", {
                            names: tk.projects.map(projectName).join(", "),
                            create: (tk.canCreate ? t("settings.apiAccess.item.reachCreate") : "") + (tk.hostMetrics ? t("settings.apiAccess.item.reachHostMetrics") : ""),
                          })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tk.status === "revoked" && tk.revokedAt
                      ? t("settings.apiAccess.item.revoked", { date: formatDateTime(tk.revokedAt) })
                      : tk.status === "expired"
                        ? t("settings.apiAccess.item.expired", { date: formatDateTime(tk.expiresAt) })
                        : t("settings.apiAccess.item.expires", { date: formatDateTime(tk.expiresAt) })}
                    {" · "}
                    {tk.lastUsedAt
                      ? t("settings.apiAccess.item.lastUsed", { date: formatDateTime(tk.lastUsedAt) })
                      : t("settings.apiAccess.item.neverUsed")}
                  </p>
                  {tk.status === "active" && tk.reach !== "panel" && editId !== tk.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      aria-label={t("settings.apiAccess.item.editLabel", { name: tk.name })}
                      onClick={() => startEdit(tk)}
                    >
                      <Pencil className="h-3.5 w-3.5" /> {t("settings.apiAccess.item.edit")}
                    </Button>
                  )}
                  {editId === tk.id && (
                    <form onSubmit={(e) => void saveEdit(e)} data-testid="api-token-edit" className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
                      <ProjectPicker
                        projects={projects}
                        selected={editChosen}
                        onChange={setEditChosen}
                        loadError={projectsError}
                        legend={t("settings.apiAccess.edit.legend")}
                      />
                      {editingToken?.scope === "admin" && (
                      <label className="flex cursor-pointer items-start gap-2">
                        <input type="checkbox" checked={editCreate} onChange={(e) => setEditCreate(e.target.checked)} className="mt-1" />
                        <span>{t("settings.apiAccess.edit.canCreate")}</span>
                      </label>
                      )}
                      {editingToken?.reach !== "domains" && (
                        <label className="flex cursor-pointer items-start gap-2">
                          <input type="checkbox" checked={editHost} onChange={(e) => setEditHost(e.target.checked)} className="mt-1" data-testid="api-token-edit-host-metrics" />
                          <span>{t("settings.apiAccess.edit.hostMetrics")}</span>
                        </label>
                      )}
                      {editWidens ? (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-xs text-muted-foreground">{t("settings.apiAccess.edit.widens")}</p>
                          <label htmlFor={`${ids.password}-edit`} className="font-medium">
                            {t("settings.apiAccess.form.password.label")}
                          </label>
                          <PasswordInput
                            id={`${ids.password}-edit`}
                            autoComplete="current-password"
                            value={editPassword}
                            onChange={(e) => setEditPassword(e.target.value)}
                          />
                          {twoFactor !== false && (
                            <>
                              <label htmlFor={`${ids.code}-edit`} className="font-medium">
                                {t("settings.apiAccess.form.code.label")}
                              </label>
                              <Input
                                id={`${ids.code}-edit`}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                value={editCode}
                                onChange={(e) => setEditCode(e.target.value)}
                              />
                            </>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("settings.apiAccess.edit.reduces")}</p>
                      )}
                      {!editValid && <p className="text-xs text-destructive">{t("settings.apiAccess.edit.needOne")}</p>}
                      {editError && (
                        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                          {editError}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" size="sm" disabled={!editReady}>
                          {editBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("settings.apiAccess.edit.save")}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditId(null)}>
                          {t("settings.apiAccess.item.revokeCancel")}
                        </Button>
                      </div>
                    </form>
                  )}
                  {tk.status === "active" &&
                    (confirmId === tk.id ? (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="destructive" size="sm" disabled={revoking === tk.id} onClick={() => void revoke(tk.id)}>
                          {revoking === tk.id && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("settings.apiAccess.item.revokeConfirm")}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setConfirmId(null)}>
                          {t("settings.apiAccess.item.revokeCancel")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        aria-label={t("settings.apiAccess.item.revokeLabel", { name: tk.name })}
                        onClick={() => setConfirmId(tk.id)}
                      >
                        <Ban className="h-3.5 w-3.5" /> {t("settings.apiAccess.item.revoke")}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
