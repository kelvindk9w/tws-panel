import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  DYNAMIC_NAME_STATES,
  DYNAMIC_PAGE_SIZES,
  type AddDynamicDomainResponse,
  type DynamicDomainItem,
  type DynamicDomainsResponse,
  type DynamicNameState,
  type DynamicSuffix,
  type Project,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { saasDomainsGuideUrl } from "@/lib/links";
import { formatDay, STATE_KEYS, stateVariant } from "@/lib/certificates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, BookOpen, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

const base = (projectId: string) => `/api/projects/${projectId}/dynamic-domains`;

/** Quem cadastrou o nome, em texto para a pessoa. */
function AddedBy({ by }: { by: string }) {
  const { t } = useI18n();
  if (by === "acesso") return <>{t("projects.dynamic.by.access")}</>;
  if (by.startsWith("token:")) return <>{t("projects.dynamic.by.token", { name: by.slice("token:".length) })}</>;
  return <>{t("projects.dynamic.by.user")}</>;
}

function Row({ item, projectId, onChanged }: { item: DynamicDomainItem; projectId: string; onChanged: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base(projectId)}/${encodeURIComponent(item.host)}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(apiErrorText(err, "projects.dynamic.remove.error"));
      setBusy(false);
    }
  }

  return (
    <li data-testid={`dynamic-${item.host}`} className="flex flex-col gap-1 border-b py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-sm">{item.host}</span>
        <Badge variant={stateVariant(item.state)}>{t(STATE_KEYS[item.state])}</Badge>
        <span className="text-xs text-muted-foreground">{t(`projects.dynamic.via.${item.via}` as const)}</span>
        <div className="ml-auto flex gap-2">
          {!confirming ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-red-400"
              aria-label={t("projects.dynamic.remove.aria", { host: item.host })}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("projects.dynamic.remove")}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirming(false)}>
                {t("projects.dynamic.remove.cancel")}
              </Button>
              <Button size="sm" variant="destructive" className="h-7" disabled={busy} onClick={() => void remove()}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {t("projects.dynamic.remove.confirm")}
              </Button>
            </>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        <AddedBy by={item.addedBy} />
        {item.validTo ? ` · ${t("projects.dynamic.until", { date: formatDay(item.validTo) })}` : ""}
      </p>
      {item.message && <p className="text-xs text-destructive">{item.message}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** Sufixos do usuário (`*.seu-saas.com.br`): lista editável, salva de uma vez. */
function Suffixes({ projectId, suffixes, onSaved }: { projectId: string; suffixes: DynamicSuffix[]; onSaved: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<DynamicSuffix[]>(suffixes);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // a lista salva mudou por fora (outra aba, outro token): volta a refletir o servidor
  const serverKey = JSON.stringify(suffixes);
  useEffect(() => setDraft(suffixes), [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== serverKey;

  function add(event: FormEvent) {
    event.preventDefault();
    const value = text.trim().toLowerCase().replace(/^\*\./, "");
    if (!value || draft.some((s) => s.suffix === value)) return;
    setDraft([...draft, { suffix: value, openAll: false }]);
    setText("");
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch(`${base(projectId)}/suffixes`, { method: "PUT", body: JSON.stringify({ suffixes: draft }) });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(apiErrorText(err, "projects.dynamic.suffix.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="dynamic-suffixes" className="flex flex-col gap-3 rounded-md border p-3">
      <div>
        <h3 className="text-sm font-medium">{t("projects.dynamic.suffix.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("projects.dynamic.suffix.intro")}</p>
      </div>
      {draft.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("projects.dynamic.suffix.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {draft.map((s) => (
            <li key={s.suffix} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-sm">*.{s.suffix}</span>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={s.openAll}
                    onChange={(e) => {
                      setDraft(draft.map((x) => (x.suffix === s.suffix ? { ...x, openAll: e.target.checked } : x)));
                      setSaved(false);
                    }}
                  />
                  {t("projects.dynamic.suffix.openAll")}
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 text-red-400"
                  aria-label={t("projects.dynamic.suffix.remove", { suffix: s.suffix })}
                  onClick={() => {
                    setDraft(draft.filter((x) => x.suffix !== s.suffix));
                    setSaved(false);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {s.openAll && (
                <p role="note" className="flex items-start gap-1.5 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("projects.dynamic.suffix.openAll.warn")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="dynamic-suffix-input" className="text-xs">
            {t("projects.dynamic.suffix.add.label")}
          </label>
          <Input
            id="dynamic-suffix-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("projects.dynamic.suffix.add.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!text.trim()}>
          <Plus className="h-4 w-4" /> {t("projects.dynamic.suffix.add.button")}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || busy} onClick={() => void save()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("projects.dynamic.suffix.save")}
        </Button>
        {saved && !dirty && (
          <span role="status" className="text-xs text-emerald-400">
            {t("projects.dynamic.suffix.saved")}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Domínios dinâmicos do projeto (SaaS): nomes dos clientes servidos sem editar o projeto.
 * Lista com busca, filtro por situação e páginas (centenas de nomes), cadastro, remoção,
 * sufixos do usuário e o aviso do que falta para o proxy servir esses nomes.
 */
export function ProjectDynamicDomainsCard({ project }: { project: Project }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<DynamicDomainsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState<DynamicNameState | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DYNAMIC_PAGE_SIZES[0]);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q.trim()) params.set("q", q.trim());
    if (state) params.set("state", state);
    try {
      setData(await apiFetch<DynamicDomainsResponse>(`${base(project.id)}?${params.toString()}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorText(err, "projects.dynamic.loadError"));
    }
  }, [project.id, page, pageSize, q, state]);

  useEffect(() => {
    // pequena espera na busca: um pedido por pausa na digitação, não por tecla
    const timer = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const value = host.trim();
    if (!value || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      await apiFetch<AddDynamicDomainResponse>(base(project.id), { method: "POST", body: JSON.stringify({ host: value }) });
      setHost("");
      setPage(1);
      await load();
    } catch (err) {
      setAddError(apiErrorText(err, "projects.dynamic.add.error"));
    } finally {
      setBusy(false);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtering = q.trim() !== "" || state !== "";

  return (
    <Card data-testid="dynamic-domains-card">
      <CardHeader>
        <CardTitle>{t("projects.dynamic.title")}</CardTitle>
        <CardDescription>{t("projects.dynamic.intro")}</CardDescription>
        <a
          href={saasDomainsGuideUrl(locale)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
        >
          <BookOpen className="h-3.5 w-3.5" /> {t("projects.dynamic.guide")}
        </a>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}
        {data && !data.routing.ready && (
          <p role="alert" data-testid="dynamic-routing-off" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {t("projects.dynamic.routingOff", { reason: data.routing.reason ?? t("projects.dynamic.routingOffUnknown") })}
          </p>
        )}
        {data && (
          <p data-testid="dynamic-usage" className="text-xs text-muted-foreground">
            {t("projects.dynamic.usage", {
              names: data.usage.names,
              maxNames: data.limits.maxNamesPerProject,
              issuances: data.usage.issuancesLastHour,
              maxIssuances: data.limits.maxIssuancesPerHour,
            })}
          </p>
        )}

        <form onSubmit={(e) => void add(e)} className="flex flex-col gap-1.5">
          <label htmlFor="dynamic-host-input" className="text-sm font-medium">
            {t("projects.dynamic.add.label")}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="dynamic-host-input"
              className="min-w-0 flex-1"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t("projects.dynamic.add.placeholder")}
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={!host.trim() || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {t("projects.dynamic.add.button")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("projects.dynamic.add.hint")}</p>
          {addError && (
            <p role="alert" className="text-xs text-destructive">
              {addError}
            </p>
          )}
        </form>

        {data && data.counters.waiting > 0 && (
          <p data-testid="dynamic-waiting-hint" className="rounded-md bg-secondary p-3 text-xs text-muted-foreground">
            {t("projects.dynamic.waitingHint")}
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="dynamic-search" className="text-xs">
              {t("projects.dynamic.search.label")}
            </label>
            <Input
              id="dynamic-search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder={t("projects.dynamic.search.placeholder")}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="dynamic-state" className="text-xs">
              {t("projects.dynamic.filter.label")}
            </label>
            <select
              id="dynamic-state"
              value={state}
              onChange={(e) => {
                setState(e.target.value as DynamicNameState | "");
                setPage(1);
              }}
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="">{t("projects.dynamic.filter.all")}</option>
              {DYNAMIC_NAME_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(STATE_KEYS[s])}
                  {data ? ` (${data.counters[s]})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="dynamic-page-size" className="text-xs">
              {t("projects.dynamic.pageSize.label")}
            </label>
            <select
              id="dynamic-page-size"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
            >
              {DYNAMIC_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("projects.dynamic.refresh")}
          </Button>
        </div>

        {data && data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">{filtering ? t("projects.dynamic.emptyFiltered") : t("projects.dynamic.empty")}</p>
        )}
        {data && data.items.length > 0 && (
          <ul data-testid="dynamic-list">
            {data.items.map((item) => (
              <Row key={item.host} item={item} projectId={project.id} onChanged={() => void load()} />
            ))}
          </ul>
        )}
        {data && data.total > data.pageSize && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t("projects.dynamic.page.prev")}
            </Button>
            <span data-testid="dynamic-page-summary">{t("projects.dynamic.page.summary", { page, pages, total: data.total })}</span>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t("projects.dynamic.page.next")}
            </Button>
          </div>
        )}

        {data && <Suffixes projectId={project.id} suffixes={data.suffixes} onSaved={() => void load()} />}
      </CardContent>
    </Card>
  );
}
