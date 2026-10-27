/**
 * Seção "Caixa de teste" do projeto: liga/desliga a caixa de teste de e-mail (Mailpit), mostra o que
 * o painel redireciona, avisa quando falta reiniciar, e lista/abre as mensagens recebidas.
 *
 * O HTML de cada e-mail aparece num iframe com `sandbox=""` (sem scripts, sem formulários, sem
 * acesso ao painel) e sem imagens remotas por padrão; o isolamento de verdade vem do servidor
 * (CSP na resposta). Texto, cabeçalhos, anexos e links são mostrados como texto.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Download, Inbox, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { MailTestListResponse, MailTestMessage, MailTestMessageSummary, MailTestView } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { apiErrorText, formatDateTime, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PAGE = 50;
const REFRESH_MS = 5000;

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/mail-test`;
}

function errorText(err: unknown): string {
  return apiErrorText(err, "mailTest.error.generic");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function addressText(a: { name: string; address: string } | null): string {
  if (!a) return "";
  return a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name;
}

export function MailTestSection({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<MailTestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enable" | "save" | "disable" | "restart" | null>(null);
  const [maxMessages, setMaxMessages] = useState("500");
  const [maxAgeDays, setMaxAgeDays] = useState("7");
  const [confirmOff, setConfirmOff] = useState(false);
  const [deleteOnOff, setDeleteOnOff] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await apiFetch<MailTestView>(base(projectId));
      setView(v);
      return v;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void load().then((v) => {
      if (v) {
        setMaxMessages(String(v.settings.maxMessages));
        setMaxAgeDays(String(v.settings.maxAgeDays));
      }
    });
  }, [load]);

  async function send(enabled: boolean, extra: { deleteMessages?: boolean } = {}) {
    setBusy(enabled ? (view?.enabled ? "save" : "enable") : "disable");
    setError(null);
    setNotice(null);
    try {
      const body = enabled ? { enabled, maxMessages: Number(maxMessages), maxAgeDays: Number(maxAgeDays) } : { enabled, ...extra };
      const v = await apiFetch<MailTestView>(base(projectId), { method: "PUT", body: JSON.stringify(body) });
      setView(v);
      setConfirmOff(false);
      setNotice(t(!enabled ? "mailTest.disabled" : view?.enabled ? "mailTest.retention.saved" : "mailTest.enabled"));
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function restart() {
    setBusy("restart");
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/recreate`, { method: "POST" });
      setNotice(t("mailTest.restart.started"));
      onChanged?.();
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (!view) {
    return (
      <Card data-testid="mail-test-section">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : (
            t("mailTest.loading")
          )}
        </CardContent>
      </Card>
    );
  }

  const retentionChanged =
    view.enabled && (Number(maxMessages) !== view.settings.maxMessages || Number(maxAgeDays) !== view.settings.maxAgeDays);

  return (
    <div className="flex flex-col gap-4" data-testid="mail-test-section">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Inbox className="h-4 w-4" /> {t("mailTest.title")}
            {view.enabled && <Badge variant={view.container === "running" ? "success" : "warning"}>{t(`mailTest.container.${view.container === "off" ? "missing" : view.container}` as Key)}</Badge>}
          </CardTitle>
          <CardDescription>{t("mailTest.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p data-testid="mail-test-status" className={view.enabled ? "font-medium text-emerald-300" : "text-muted-foreground"}>
            {t(view.enabled ? "mailTest.status.on" : "mailTest.status.off")}
          </p>

          {view.enabled && view.problem && (
            <p role="alert" className="text-amber-300">
              {view.problem}
            </p>
          )}

          {view.enabled && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{t("mailTest.smtp", { host: view.smtpHost, port: view.smtpPort })}</span>
              {view.redirectedVariables.length > 0 && <span>{t("mailTest.redirected", { names: view.redirectedVariables.join(", ") })}</span>}
            </div>
          )}

          {view.needsRestart && (
            <div data-testid="mail-test-restart" className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-100">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                {t(view.enabled ? "mailTest.restart.on" : "mailTest.restart.off")}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => void restart()} disabled={busy !== null}>
                  {busy === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{" "}
                  {t(busy === "restart" ? "mailTest.restart.busy" : "mailTest.restart.button")}
                </Button>
                <span className="text-xs text-amber-200/80">{t("mailTest.restart.note")}</span>
              </div>
            </div>
          )}

          <div className="grid max-w-md grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("mailTest.retention.maxMessages")}
              <Input
                type="number"
                min={10}
                max={5000}
                value={maxMessages}
                onChange={(e) => setMaxMessages(e.target.value)}
                disabled={busy !== null}
                aria-label={t("mailTest.retention.maxMessages")}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("mailTest.retention.maxAgeDays")}
              <Input
                type="number"
                min={1}
                max={30}
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(e.target.value)}
                disabled={busy !== null}
                aria-label={t("mailTest.retention.maxAgeDays")}
              />
            </label>
            <p className="col-span-2 text-xs text-muted-foreground">{t("mailTest.retention.hint")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!view.enabled ? (
              <Button onClick={() => void send(true)} disabled={busy !== null}>
                {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}{" "}
                {t(busy === "enable" ? "mailTest.enabling" : "mailTest.enable")}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => void send(true)} disabled={busy !== null || !retentionChanged}>
                  {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
                  {t(busy === "save" ? "mailTest.retention.saving" : "mailTest.retention.save")}
                </Button>
                {view.container !== "running" && (
                  <Button variant="secondary" onClick={() => void send(true)} disabled={busy !== null}>
                    {t("mailTest.enable")}
                  </Button>
                )}
                {!confirmOff && (
                  <Button variant="outline" onClick={() => setConfirmOff(true)} disabled={busy !== null}>
                    {t("mailTest.disable")}
                  </Button>
                )}
              </>
            )}
          </div>

          {confirmOff && (
            <fieldset data-testid="mail-test-disable" className="flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/5 p-3" disabled={busy !== null}>
              <legend className="px-1 font-medium">{t("mailTest.disable.title")}</legend>
              <p className="text-muted-foreground">{t("mailTest.disable.help")}</p>
              <label className="flex items-start gap-2">
                <input type="radio" name="mt-off" className="mt-0.5 h-4 w-4" checked={!deleteOnOff} onChange={() => setDeleteOnOff(false)} />
                <span>{t("mailTest.disable.keep")}</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="mt-off" className="mt-0.5 h-4 w-4" checked={deleteOnOff} onChange={() => setDeleteOnOff(true)} />
                <span>{t("mailTest.disable.delete")}</span>
              </label>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={() => void send(false, { deleteMessages: deleteOnOff })}>
                  {busy === "disable" && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
                  {t(busy === "disable" ? "mailTest.disable.disabling" : "mailTest.disable.confirm")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmOff(false)}>
                  {t("mailTest.disable.cancel")}
                </Button>
              </div>
            </fieldset>
          )}

          {notice && (
            <p role="status" data-testid="mail-test-notice" className="text-emerald-300">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}

          <div data-testid="mail-test-limits" className="flex flex-col gap-1 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">{t("mailTest.limits.title")}</strong>
            <span>{t("mailTest.limits.api")}</span>
            <span>{t("mailTest.limits.url", { host: view.smtpHost, port: view.smtpPort })}</span>
            <span>{t("mailTest.limits.all")}</span>
            <span>{t("mailTest.limits.secure")}</span>
          </div>

          <div data-testid="mail-test-guarantee" className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-100">
            <strong className="text-foreground">{t("mailTest.guarantee.title")}</strong>
            <span>{t("mailTest.guarantee.body")}</span>
          </div>

          {view.enabled && (
            <div data-testid="mail-test-uncontrolled" className="flex flex-col gap-1 rounded-md border bg-secondary/20 p-3 text-xs">
              <strong className="text-foreground">{t("mailTest.uncontrolled.title")}</strong>
              {view.uncontrolled.length === 0 ? (
                <span className="text-muted-foreground">{t("mailTest.uncontrolled.none")}</span>
              ) : (
                <>
                  <span className="text-muted-foreground">{t("mailTest.uncontrolled.body")}</span>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {view.uncontrolled.map((u) => (
                      <li key={`${u.file}:${u.name}`}>
                        <code className="font-semibold">{u.name}</code> · {t("mailTest.uncontrolled.in", { file: u.file })} ·{" "}
                        <span className={u.kind === "api" ? "text-red-300" : "text-amber-300"}>{t(u.kind === "api" ? "mailTest.uncontrolled.api" : "mailTest.uncontrolled.smtp")}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {view.enabled && <MessagesCard projectId={projectId} view={view} onCountChanged={() => void load()} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

function MessagesCard({ projectId, view, onCountChanged }: { projectId: string; view: MailTestView; onCountChanged: () => void }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<MailTestMessageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const loaded = useRef(0);
  const running = view.container === "running";

  // recarrega do começo até onde a pessoa já tinha chegado (mensagens novas entram no topo)
  const refresh = useCallback(async () => {
    try {
      const limit = Math.min(100, Math.max(PAGE, loaded.current));
      const res = await apiFetch<MailTestListResponse>(`${base(projectId)}/messages?start=0&limit=${limit}`);
      setMessages(res.messages);
      loaded.current = res.messages.length;
      setTotal(res.total);
      setUnread(res.unread);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!running) {
      setLoading(false);
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function more() {
    try {
      const res = await apiFetch<MailTestListResponse>(`${base(projectId)}/messages?start=${messages.length}&limit=${PAGE}`);
      setMessages((prev) => [...prev, ...res.messages.filter((m) => !prev.some((p) => p.id === m.id))]);
      loaded.current = messages.length + res.messages.length;
      setTotal(res.total);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function clear() {
    setConfirmClear(false);
    try {
      await apiFetch(`${base(projectId)}/messages`, { method: "DELETE" });
      setNotice(t("mailTest.messages.cleared"));
      setOpenId(null);
      await refresh();
      onCountChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (openId) {
    return (
      <MessageDetail
        projectId={projectId}
        id={openId}
        onBack={() => {
          setOpenId(null);
          void refresh();
        }}
        onDeleted={() => {
          setOpenId(null);
          setNotice(t("mailTest.detail.deleted"));
          void refresh();
          onCountChanged();
        }}
      />
    );
  }

  return (
    <Card data-testid="mail-test-messages">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">{t("mailTest.messages.title")}</CardTitle>
        {running && <CardDescription>{t("mailTest.messages.summary", { count: total === 1 ? 1 : 2, n: total, unread })}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {running ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" /> {t("mailTest.messages.refresh")}
            </Button>
            {total > 0 &&
              (confirmClear ? (
                <>
                  <span>{t("mailTest.messages.clearConfirm")}</span>
                  <Button variant="danger" size="sm" onClick={() => void clear()}>
                    {t("mailTest.messages.clearYes")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)}>
                    {t("mailTest.disable.cancel")}
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
                  <Trash2 className="h-4 w-4" /> {t("mailTest.messages.clear")}
                </Button>
              ))}
          </div>
        ) : (
          <p className="text-muted-foreground">{t("mailTest.messages.stopped")}</p>
        )}
        {notice && (
          <p role="status" className="text-emerald-300">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {running && loading && <p className="text-muted-foreground">{t("mailTest.loading")}</p>}
        {running && !loading && messages.length === 0 && !error && <p className="text-muted-foreground">{t("mailTest.messages.empty")}</p>}
        {messages.length > 0 && (
          <ul className="divide-y rounded-md border">
            {messages.map((m) => {
              const subject = m.subject || t("mailTest.messages.noSubject");
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent/40"
                    onClick={() => setOpenId(m.id)}
                    aria-label={t("mailTest.messages.open", { subject })}
                    data-testid={`mail-test-row-${m.id}`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={m.read ? "" : "font-semibold"}>{subject}</span>
                      {!m.read && <Badge variant="secondary">{t("mailTest.messages.unread")}</Badge>}
                      {m.attachments > 0 && (
                        <span className="text-xs text-muted-foreground">{t("mailTest.messages.attachmentsCount", { count: m.attachments === 1 ? 1 : 2, n: m.attachments })}</span>
                      )}
                    </span>
                    <span className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                      <span>
                        {t("mailTest.detail.from")}: {addressText(m.from) || t("mailTest.messages.noSender")}
                      </span>
                      <span>
                        {t("mailTest.detail.to")}: {m.to.map(addressText).join(", ")}
                      </span>
                      <span>{m.created ? formatDateTime(m.created) : ""}</span>
                    </span>
                    {m.snippet && <span className="truncate text-xs text-muted-foreground">{m.snippet}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {messages.length < total && (
          <Button variant="outline" size="sm" className="self-start" onClick={() => void more()}>
            {t("mailTest.messages.more")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Uma mensagem
// ---------------------------------------------------------------------------

type Tab = "html" | "text" | "headers" | "attachments" | "links";

function MessageDetail({ projectId, id, onBack, onDeleted }: { projectId: string; id: string; onBack: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [message, setMessage] = useState<MailTestMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("html");
  const [images, setImages] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessage(null);
    apiFetch<{ message: MailTestMessage }>(`${base(projectId)}/messages/${encodeURIComponent(id)}`)
      .then((r) => {
        if (cancelled) return;
        setMessage(r.message);
        setTab(r.message.hasHtml ? "html" : "text");
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, id]);

  async function remove() {
    try {
      await apiFetch(`${base(projectId)}/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function copy(url: string) {
    if (await copyText(url)) {
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    }
  }

  const tabs: Array<{ key: Tab; label: string }> = message
    ? [
        { key: "html", label: t("mailTest.tab.html") },
        { key: "text", label: t("mailTest.tab.text") },
        { key: "headers", label: t("mailTest.tab.headers") },
        { key: "attachments", label: t("mailTest.tab.attachments", { n: message.attachmentList.length }) },
        { key: "links", label: t("mailTest.tab.links", { n: message.links.length }) },
      ]
    : [];

  return (
    <Card data-testid="mail-test-detail">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> {t("mailTest.detail.back")}
          </Button>
          {confirmDelete ? (
            <>
              <span className="text-sm">{t("mailTest.detail.deleteConfirm")}</span>
              <Button variant="danger" size="sm" onClick={() => void remove()}>
                {t("mailTest.detail.delete")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                {t("mailTest.disable.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)} disabled={!message}>
              <Trash2 className="h-4 w-4" /> {t("mailTest.detail.delete")}
            </Button>
          )}
        </div>
        {message && <CardTitle className="text-base">{message.subject || t("mailTest.messages.noSubject")}</CardTitle>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!message && !error && <p className="text-muted-foreground">{t("mailTest.detail.loading")}</p>}
        {message && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t("mailTest.detail.from")}</dt>
              <dd>{addressText(message.from)}</dd>
              <dt className="text-muted-foreground">{t("mailTest.detail.to")}</dt>
              <dd>{message.to.map(addressText).join(", ")}</dd>
              {message.cc.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{t("mailTest.detail.cc")}</dt>
                  <dd>{message.cc.map(addressText).join(", ")}</dd>
                </>
              )}
              {message.bcc.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{t("mailTest.detail.bcc")}</dt>
                  <dd>{message.bcc.map(addressText).join(", ")}</dd>
                </>
              )}
              {message.replyTo.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{t("mailTest.detail.replyTo")}</dt>
                  <dd>{message.replyTo.map(addressText).join(", ")}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t("mailTest.detail.date")}</dt>
              <dd>{message.created ? formatDateTime(message.created) : ""}</dd>
              <dt className="text-muted-foreground">{t("mailTest.detail.size")}</dt>
              <dd>{formatSize(message.size)}</dd>
            </dl>

            <div role="tablist" aria-label={t("mailTest.tabs.aria")} className="flex flex-wrap gap-1 border-b">
              {tabs.map((x) => (
                <button
                  key={x.key}
                  role="tab"
                  type="button"
                  aria-selected={tab === x.key}
                  onClick={() => setTab(x.key)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === x.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {x.label}
                </button>
              ))}
            </div>

            {tab === "html" &&
              (message.hasHtml ? (
                <div className="flex flex-col gap-2">
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={images} onChange={(e) => setImages(e.target.checked)} />
                    <span>
                      {t("mailTest.html.images")}
                      <span className="block text-muted-foreground">{t("mailTest.html.imagesHint")}</span>
                    </span>
                  </label>
                  {/* sandbox vazio = o isolamento máximo do navegador; o servidor ainda manda a CSP */}
                  <iframe
                    key={images ? "img" : "noimg"}
                    title={t("mailTest.html.frame")}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    src={`${base(projectId)}/messages/${encodeURIComponent(id)}/html${images ? "?images=1" : ""}`}
                    className="h-[28rem] w-full rounded-md border bg-white"
                  />
                  <p className="text-xs text-muted-foreground">{t("mailTest.html.safe")}</p>
                </div>
              ) : (
                <p className="text-muted-foreground">{t("mailTest.html.none")}</p>
              ))}

            {tab === "text" &&
              (message.text ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-secondary/20 p-3 text-xs">{message.text}</pre>
              ) : (
                <p className="text-muted-foreground">{t("mailTest.text.none")}</p>
              ))}

            {tab === "headers" &&
              (message.headers.length > 0 ? (
                <dl className="max-h-[28rem] overflow-auto rounded-md border bg-secondary/20 p-3 font-mono text-xs">
                  {message.headers.map((h, i) => (
                    <div key={`${h.name}-${i}`} className="break-all">
                      <dt className="inline font-semibold">{h.name}: </dt>
                      <dd className="inline">{h.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-muted-foreground">{t("mailTest.headers.none")}</p>
              ))}

            {tab === "attachments" &&
              (message.attachmentList.length > 0 ? (
                <ul className="divide-y rounded-md border">
                  {message.attachmentList.map((a) => (
                    <li key={a.partId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="break-all">{a.fileName || a.partId}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.contentType} · {formatSize(a.size)}
                        {a.inline ? ` · ${t("mailTest.attachments.inline")}` : ""}
                      </span>
                      <a
                        className="ml-auto inline-flex items-center gap-1 text-sky-400 underline"
                        href={`${base(projectId)}/messages/${encodeURIComponent(id)}/parts/${encodeURIComponent(a.partId)}?download=1`}
                        download={a.fileName || undefined}
                      >
                        <Download className="h-4 w-4" /> {t("mailTest.attachments.download")}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t("mailTest.attachments.none")}</p>
              ))}

            {tab === "links" &&
              (message.links.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">{t("mailTest.links.hint")}</p>
                  <ul className="divide-y rounded-md border">
                    {message.links.map((url) => (
                      <li key={url} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <code className="break-all text-xs">{url}</code>
                        <span className="ml-auto flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => void copy(url)}>
                            {copied === url ? t("mailTest.links.copied") : t("mailTest.links.copy")}
                          </Button>
                          <a className="inline-flex h-8 items-center text-sky-400 underline" href={url} target="_blank" rel="noopener noreferrer">
                            {t("mailTest.links.open")}
                          </a>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted-foreground">{t("mailTest.links.none")}</p>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
