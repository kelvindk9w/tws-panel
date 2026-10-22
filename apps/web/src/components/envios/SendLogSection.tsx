import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import {
  MAIL_SEND_ORIGINS,
  MAIL_SEND_STATES,
  type MailSendContent,
  type MailSendItem,
  type MailSendListResponse,
  type MailSendOrigin,
  type MailSendSettings,
  type MailSendState,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { apiErrorText, useI18n } from "@/i18n";
import { formatBytes, formatDateTime, SEND_ORIGIN_KEYS, SEND_STATE_KEYS, sendErrorText, sendStateVariant } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PAGE = 25;
/** Enquanto há mensagem na fila: confere a cada 10 s no começo, depois mais espaçado. */
const WATCH: readonly RefreshPhase[] = [
  { untilMs: 5 * 60_000, everyMs: 10_000 },
  { untilMs: Infinity, everyMs: 60_000 },
];
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Filters {
  state: "" | MailSendState;
  projectId: string;
  origin: "" | MailSendOrigin;
  from: string;
  to: string;
  recipient: string;
}

type Revealed = { loading: boolean; error: string | null; content: MailSendContent | null };

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

interface Props {
  /** Presente: só os envios deste projeto (aba Envios do projeto). Ausente: todos (E-mail > Envios). */
  projectId?: string;
}

/**
 * Envios por SMTP (a caixa do projeto que o app usa): fila, histórico e erros
 * com filtros e páginas. Assunto e corpo ficam ocultos; "Exibir" busca UMA
 * mensagem (e a servidor registra quem pediu). Nada do conteúdo fica na lista
 * do servidor nem no navegador depois de ocultar.
 */
export function SendLogSection({ projectId }: Props) {
  const { t } = useI18n();
  const scope = projectId ? `/api/projects/${encodeURIComponent(projectId)}/email/saidas` : "/api/mail/envios/saidas";
  const [filters, setFilters] = useState<Filters>({ state: "", projectId: "", origin: "", from: "", to: "", recipient: "" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<MailSendListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const [projectBusy, setProjectBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [projectNote, setProjectNote] = useState<{ ok: boolean; text: string } | null>(null);
  const seq = useRef(0);

  // Busca digitada: espera a pessoa parar de digitar.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.recipient === search ? f : { ...f, recipient: search }));
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
      for (const key of ["state", "origin", "from", "to", "recipient"] as const) if (filters[key]) qs.set(key, filters[key]);
      if (!projectId && filters.projectId) qs.set("projectId", filters.projectId);
      try {
        const res = await apiFetch<MailSendListResponse>(`${scope}?${qs.toString()}`);
        if (mine === seq.current) setData(res);
      } catch (err) {
        if (mine === seq.current && !quiet) {
          // Sem lista velha ao lado do erro (ela diria "Mostrando 1 a 24" de uma consulta que falhou).
          setData(null);
          setError(apiErrorText(err, "envios.sends.error.load"));
        }
      } finally {
        if (mine === seq.current && !quiet) setLoading(false);
      }
    },
    [filters, page, projectId, scope],
  );

  // Filtro, página ou projeto novo: carrega e esquece o que estava exibido.
  useEffect(() => {
    setRevealed({});
    void load(false);
  }, [load]);

  const pending = data?.items.some((i) => i.state === "queued" || i.state === "deferred") ?? false;
  useAutoRefresh(pending, () => load(true), WATCH);

  const setFilter = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    setPage(0);
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  };

  async function reveal(item: MailSendItem) {
    setRevealed((r) => ({ ...r, [item.id]: { loading: true, error: null, content: null } }));
    try {
      const content = await apiFetch<MailSendContent>(`${scope}/${item.id}/reveal`, { method: "POST" });
      setRevealed((r) => ({ ...r, [item.id]: { loading: false, error: null, content } }));
    } catch (err) {
      setRevealed((r) => ({ ...r, [item.id]: { loading: false, error: apiErrorText(err, "envios.sends.content.error"), content: null } }));
    }
  }

  const hide = (id: string) =>
    setRevealed((r) => {
      const { [id]: _gone, ...rest } = r;
      return rest;
    });

  const canReveal = (data?.items ?? []).filter((i) => i.hasContent);
  const allShown = canReveal.length > 0 && canReveal.every((i) => revealed[i.id]?.content);

  async function toggleProjectStore(next: boolean) {
    if (!projectId) return;
    setConfirmOff(false);
    setProjectBusy(true);
    setProjectNote(null);
    try {
      await apiFetch<MailSendSettings>(`/api/projects/${encodeURIComponent(projectId)}/email/saidas/settings`, {
        method: "PUT",
        body: JSON.stringify({ storeContent: next }),
      });
      setProjectNote({ ok: true, text: t("envios.sends.project.saved") });
      setRevealed({});
      await load(true);
    } catch (err) {
      setProjectNote({ ok: false, text: apiErrorText(err, "envios.sends.project.saveError") });
    } finally {
      setProjectBusy(false);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const capture = data?.capture;
  const first = data && data.total > 0 ? data.offset + 1 : 0;
  const last = data ? Math.min(data.offset + data.items.length, data.total) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{projectId ? t("envios.sends.titleProject") : t("envios.sends.title")}</CardTitle>
        <CardDescription>{projectId ? t("envios.sends.descProject") : t("envios.sends.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {capture && !capture.serverCreated && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("envios.sends.capture.notReady")}</p>}
        {capture && capture.serverCreated && !capture.configured && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("envios.sends.capture.off")}</p>
        )}
        {capture && capture.configured && !capture.lastReceivedAt && data && data.total === 0 && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t("envios.sends.capture.waiting")}</p>
        )}
        {capture?.lastReceivedAt && (
          <p className="text-xs text-muted-foreground">{t("envios.sends.capture.last", { date: formatDateTime(capture.lastReceivedAt) })}</p>
        )}

        {projectId && data && (
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={data.storesContent}
                disabled={projectBusy}
                onChange={(e) => (e.target.checked ? void toggleProjectStore(true) : setConfirmOff(true))}
              />
              <span>{t("envios.sends.project.storeContent")}</span>
            </label>
            <p className="text-xs text-muted-foreground">{t("envios.sends.project.storeContent.help")}</p>
            {confirmOff && (
              <div role="alertdialog" aria-label={t("envios.sends.project.confirm.question")} className="flex flex-col gap-2 rounded-md border border-destructive/40 p-2">
                <p className="text-xs">{t("envios.sends.project.confirm.question")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="danger" disabled={projectBusy} onClick={() => void toggleProjectStore(false)}>
                    {t("envios.sends.project.confirm.yes")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmOff(false)}>
                    {t("envios.sends.project.confirm.cancel")}
                  </Button>
                </div>
              </div>
            )}
            {projectNote && (
              <p role="status" className={projectNote.ok ? "text-xs text-emerald-400" : "text-xs text-destructive"}>
                {projectNote.text}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="s-state" label={t("envios.sends.field.state")}>
            <select id="s-state" className={selectClass} value={filters.state} onChange={setFilter("state")}>
              <option value="">{t("envios.sends.all")}</option>
              {MAIL_SEND_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(SEND_STATE_KEYS[s])}
                </option>
              ))}
            </select>
          </Field>
          {!projectId && (
            <>
              <Field id="s-project" label={t("envios.sends.field.project")}>
                <select id="s-project" className={selectClass} value={filters.projectId} onChange={setFilter("projectId")}>
                  <option value="">{t("envios.sends.allProjects")}</option>
                  {data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="none">{t("envios.sends.noProject")}</option>
                </select>
              </Field>
              <Field id="s-origin" label={t("envios.sends.field.origin")}>
                <select id="s-origin" className={selectClass} value={filters.origin} onChange={setFilter("origin")}>
                  <option value="">{t("envios.sends.all")}</option>
                  {MAIL_SEND_ORIGINS.map((o) => (
                    <option key={o} value={o}>
                      {t(SEND_ORIGIN_KEYS[o])}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field id="s-from" label={t("envios.sends.field.from")}>
            <Input id="s-from" type="date" value={filters.from} onChange={setFilter("from")} />
          </Field>
          <Field id="s-to" label={t("envios.sends.field.to")}>
            <Input id="s-to" type="date" value={filters.to} onChange={setFilter("to")} />
          </Field>
          <Field id="s-recipient" label={t("envios.sends.field.recipient")}>
            <Input id="s-recipient" value={search} maxLength={100} placeholder={t("envios.sends.recipient.placeholder")} onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(false)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("envios.sends.refresh")}
          </Button>
          {canReveal.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => (allShown ? setRevealed({}) : void Promise.all(canReveal.filter((i) => !revealed[i.id]?.content).map(reveal)))}
            >
              {allShown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {allShown ? t("envios.sends.hideAll") : t("envios.sends.showAll")}
            </Button>
          )}
        </div>
        {canReveal.length > 0 && <p className="text-xs text-muted-foreground">{t("envios.sends.showAll.hint")}</p>}

        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {loading
            ? t("envios.sends.status.loading")
            : data && data.total > 0
              ? t("envios.sends.status.showing", { from: first, to: last, total: data.total })
              : data
                ? Object.values(filters).some(Boolean)
                  ? t("envios.sends.status.empty")
                  : t("envios.sends.empty")
                : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {data && data.items.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="send-list">
            {data.items.map((item) => (
              <SendRow key={item.id} item={item} state={revealed[item.id]} onShow={() => void reveal(item)} onHide={() => hide(item.id)} />
            ))}
          </ul>
        )}

        {data && pages > 1 && (
          <nav className="flex flex-wrap items-center gap-2" aria-label={t("envios.sends.page.of", { page: page + 1, pages })}>
            <Button size="sm" variant="outline" disabled={loading || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              {t("envios.sends.page.prev")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("envios.sends.page.of", { page: page + 1, pages })}</span>
            <Button size="sm" variant="outline" disabled={loading || page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              {t("envios.sends.page.next")}
            </Button>
          </nav>
        )}
      </CardContent>
    </Card>
  );
}

function SendRow({ item, state, onShow, onHide }: { item: MailSendItem; state: Revealed | undefined; onShow: () => void; onHide: () => void }) {
  const { t } = useI18n();
  const to = item.recipients.map((r) => r.address).join(", ");
  const shown = state?.content ?? null;
  const contentId = `send-content-${item.id}`;
  // O rótulo do botão cita o primeiro destinatário e quantos mais (não a lista inteira).
  const ariaTo = item.recipients.length > 1 ? t("envios.sends.aria.more", { to: item.recipients[0]!.address, n: item.recipients.length - 1 }) : (item.recipients[0]?.address ?? "");
  const origin = item.projectName ?? t(SEND_ORIGIN_KEYS[item.origin]);
  return (
    <li data-testid={`send-${item.id}`} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sendStateVariant(item.state)}>{t(SEND_STATE_KEYS[item.state])}</Badge>
        <span className="min-w-0 break-all font-medium">{to}</span>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="flex gap-1">
          <dt>{t("envios.sends.row.when")}:</dt>
          <dd>{formatDateTime(item.at)}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt>{t("envios.sends.row.from")}:</dt>
          <dd className="min-w-0 break-all">
            {item.from} · {origin}
          </dd>
        </div>
        {item.size > 0 && (
          <div className="flex gap-1">
            <dt>{t("envios.sends.row.size")}:</dt>
            <dd>{formatBytes(item.size)}</dd>
          </div>
        )}
        {item.attachments.length > 0 && (
          <div className="flex min-w-0 gap-1 sm:col-span-2">
            <dt>{t("envios.sends.row.attachments")}:</dt>
            <dd className="min-w-0 break-all">{item.attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(", ")}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs text-muted-foreground">{t("envios.sends.row.subject")}: </span>
          {shown ? (
            <span className="break-words">{shown.subject ?? "—"}</span>
          ) : item.hasContent ? (
            <span className="text-muted-foreground">{t("envios.sends.hidden")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {!item.captured
                ? t("envios.sends.row.notCaptured")
                : item.contentRemoved
                  ? t("envios.sends.row.removed")
                  : item.contentExpired
                    ? t("envios.sends.row.expired")
                    : t("envios.sends.row.noContent")}
            </span>
          )}
        </div>
        {item.hasContent && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={Boolean(shown)}
            aria-controls={contentId}
            aria-label={shown ? t("envios.sends.hide.aria", { to: ariaTo }) : t("envios.sends.show.aria", { to: ariaTo })}
            disabled={state?.loading}
            onClick={shown ? onHide : onShow}
          >
            {state?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {shown ? t("envios.sends.hide") : t("envios.sends.show")}
          </Button>
        )}
      </div>
      <div id={contentId} role="region" aria-label={t("envios.sends.row.subject")} aria-live="polite" hidden={!shown && !state?.error && !state?.loading}>
        {state?.loading && <p className="text-xs text-muted-foreground">{t("envios.sends.content.loading")}</p>}
        {state?.error && <p className="text-xs text-destructive">{state.error}</p>}
        {shown && (
          <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
            <p className="text-xs text-muted-foreground">{t("envios.sends.content.body")}</p>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{shown.body ?? "—"}</pre>
            {shown.bodyTruncated && <p className="text-xs text-amber-300">{t("envios.sends.content.truncated")}</p>}
            {shown.expiresAt && (
              <p className="text-xs text-muted-foreground">{t("envios.sends.content.expires", { date: formatDateTime(shown.expiresAt) })}</p>
            )}
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {item.recipients
          .filter((r) => r.error || item.recipients.length > 1)
          .map((r) => {
            const text = r.error ? sendErrorText(r.error.kind) : null;
            return (
              <li key={r.address} className="flex flex-col gap-1 text-xs">
                {item.recipients.length > 1 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{r.address}</span>
                    <Badge variant={sendStateVariant(r.state)}>{t(SEND_STATE_KEYS[r.state])}</Badge>
                  </div>
                )}
                {text && r.error && (
                  <div className="flex flex-col gap-1 rounded-md bg-amber-500/10 p-2">
                    <p className="font-medium text-amber-300">{text.title}</p>
                    <p>{text.hint}</p>
                    {r.state === "deferred" && (
                      <p className="text-muted-foreground">{t("envios.sends.row.deferrals", { n: r.deferrals, next: formatDateTime(r.nextRetryAt) })}</p>
                    )}
                    {r.error.technical && (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">{t("envios.sends.technical")}</summary>
                        <code className="mt-1 block break-words rounded bg-muted p-2">
                          {r.remoteHost ? `${r.remoteHost}: ` : ""}
                          {r.error.technical}
                        </code>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </li>
  );
}
