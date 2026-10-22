import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  NOTIFICATION_KINDS,
  type MonitorStateResponse,
  type NotificationHistoryEntry,
  type NotificationKind,
  type NotificationsStatus,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, formatDateTime, Trans, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, Loader2, Mail, MessageCircle, Send } from "lucide-react";

/** Só erro da API traz mensagem própria; qualquer outro vira o texto padrão. */
function errorText(err: unknown, fallback: Key): string {
  return apiErrorText(err instanceof ApiRequestError ? err : null, fallback);
}

/**
 * Configurações → Notificações: avisos fora do painel quando algo precisa de
 * atenção. Dois canais — Telegram (um robô criado no @BotFather) e e-mail
 * (pelo servidor de e-mail do próprio painel) —, a escolha do que avisa e os
 * últimos envios. A verificação automática de segurança continua aqui.
 */

const GENERIC_ERROR: Key = "notifications.error.generic";

function when(iso: string): string {
  return formatDateTime(iso, { dateStyle: "short", timeStyle: "short" });
}

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Run = (path: string, init: RequestInit, okMessage?: string) => Promise<boolean>;

/** Ações de um cartão: chamada à API, ocupado, mensagem de sucesso e erro. */
function useAction(onStatus: (s: NotificationsStatus) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run: Run = async (path, init, okMessage) => {
    setBusy(`${init.method} ${path}`);
    setError(null);
    setErrorCode(null);
    setNotice(null);
    try {
      onStatus(await apiFetch<NotificationsStatus>(path, init));
      if (okMessage) setNotice(okMessage);
      return true;
    } catch (err) {
      setError(errorText(err, GENERIC_ERROR));
      setErrorCode(err instanceof ApiRequestError ? err.code : null);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, errorCode, notice, run };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {notice && (
        <p className="flex items-start gap-1.5 text-sm text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function TestedBadge({ testedAt }: { testedAt: string | null }) {
  const { t } = useI18n();
  return testedAt ? (
    <Badge variant="success">{t("notifications.tested.at", { when: when(testedAt) })}</Badge>
  ) : (
    <Badge variant="warning">{t("notifications.tested.missing")}</Badge>
  );
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function TelegramCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const tg = status.telegram;
  const { t } = useI18n();
  const { busy, error, notice, run } = useAction(onStatus);
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const bot = tg.botUsername ?? "";

  return (
    <Card data-testid="telegram-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="h-4 w-4 text-sky-400" /> {t("notifications.telegram.title")}
        </CardTitle>
        <CardDescription>{t("notifications.telegram.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {tg.state === "none" && (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                <Trans
                  k="notifications.telegram.step1"
                  components={{
                    link: (c) => (
                      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                        {c}
                      </a>
                    ),
                    code: <code className="text-foreground" />,
                  }}
                />
              </li>
              <li>{t("notifications.telegram.step2")}</li>
              <li>{t("notifications.telegram.step3")}</li>
            </ol>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void run("/api/notifications/telegram", { method: "PUT", body: JSON.stringify({ token: token.trim() }) }).then(
                  (ok) => ok && setToken(""),
                );
              }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label htmlFor="tg-token" className="font-medium">
                  {t("notifications.telegram.tokenLabel")}
                </label>
                <PasswordInput
                  id="tg-token"
                  revealLabel={t("notifications.telegram.tokenReveal")}
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:ABC…"
                />
              </div>
              <Button type="submit" disabled={!token.trim() || busy !== null}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("notifications.telegram.saveToken")}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">{t("notifications.telegram.tokenNote")}</p>
          </>
        )}

        {tg.state === "awaiting_chat" && (
          <>
            <p>
              <Trans k="notifications.telegram.botChecked" params={{ bot }} components={{ b: <strong /> }} />
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                <Trans
                  k="notifications.telegram.awaitingStep1"
                  params={{ bot }}
                  components={{
                    link: (c) => (
                      <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                        {c}
                      </a>
                    ),
                    code: <code className="text-foreground" />,
                  }}
                />
              </li>
              <li>{t("notifications.telegram.awaitingStep2")}</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void run("/api/notifications/telegram/connect", { method: "POST" })} disabled={busy !== null}>
                {busy?.endsWith("/connect") && <Loader2 className="h-4 w-4 animate-spin" />} {t("notifications.telegram.connect")}
              </Button>
              <Button variant="outline" onClick={() => void run("/api/notifications/telegram", { method: "DELETE" })} disabled={busy !== null}>
                {t("notifications.telegram.changeBot")}
              </Button>
            </div>
          </>
        )}

        {tg.state === "connected" && (
          <>
            <p className="break-words">
              <Trans k="notifications.telegram.connected" params={{ chat: tg.chatTitle ?? "", bot }} components={{ b: <strong /> }} />
            </p>
            <div>
              <TestedBadge testedAt={tg.testedAt} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="info"
                onClick={() =>
                  void run("/api/notifications/telegram/test", { method: "POST" }, t("notifications.telegram.testSent"))
                }
                disabled={busy !== null}
              >
                {busy?.endsWith("/test") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("notifications.telegram.sendTest")}
              </Button>
              {!confirmRemove ? (
                <Button variant="outline" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                  {t("notifications.telegram.disconnect")}
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{t("notifications.telegram.disconnectQuestion")}</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmRemove(false);
                      void run("/api/notifications/telegram", { method: "DELETE" });
                    }}
                  >
                    {t("notifications.telegram.disconnectYes")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
                    {t("notifications.telegram.disconnectNo")}
                  </Button>
                </span>
              )}
            </div>
          </>
        )}
        <Feedback error={error} notice={notice} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EmailCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const e = status.email;
  const { t } = useI18n();
  const { busy, error, errorCode, notice, run } = useAction(onStatus);
  const [text, setText] = useState(e.recipients.join("\n"));
  const saved = e.recipients.length > 0;

  return (
    <Card data-testid="email-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-violet-400" /> {t("notifications.email.title")}
        </CardTitle>
        <CardDescription>{t("notifications.email.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!e.available && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="break-words">
              {saved ? t("notifications.email.unavailablePrefix") : ""}
              {e.unavailableReason}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/mail">{t("notifications.email.openMail")}</Link>
              </Button>
              {!saved && <span className="text-muted-foreground">{t("notifications.email.telegramOnly")}</span>}
            </div>
          </div>
        )}

        {(e.available || saved) && (
          <>
            {e.from && (
              <p className="break-words text-muted-foreground">
                <Trans k="notifications.email.sentFrom" params={{ from: e.from }} components={{ b: <strong className="text-foreground" /> }} />
              </p>
            )}
            <form
              className="flex flex-col gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                void run("/api/notifications/email", { method: "PUT", body: JSON.stringify({ recipients: parseRecipients(text) }) });
              }}
            >
              <label htmlFor="nt-recipients" className="font-medium">
                {t("notifications.email.recipientsLabel")}
              </label>
              <textarea
                id="nt-recipients"
                className={textareaClass}
                value={text}
                onChange={(ev) => setText(ev.target.value)}
                placeholder={t("notifications.email.recipientsPlaceholder")}
                spellCheck={false}
              />
              <div>
                <Button type="submit" disabled={!text.trim() || busy !== null}>
                  {busy === "PUT /api/notifications/email" && <Loader2 className="h-4 w-4 animate-spin" />} {t("notifications.email.saveRecipients")}
                </Button>
              </div>
            </form>
            {saved && (
              <>
                <div>
                  <TestedBadge testedAt={e.testedAt} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="info"
                    onClick={() =>
                      void run(
                        "/api/notifications/email/test",
                        { method: "POST" },
                        t("notifications.email.testSent"),
                      )
                    }
                    disabled={busy !== null || !e.available}
                  >
                    {busy?.endsWith("/test") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("notifications.email.sendTest")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void run("/api/notifications/email", { method: "DELETE" }).then((ok) => ok && setText(""));
                    }}
                    disabled={busy !== null}
                  >
                    {t("notifications.email.turnOff")}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        <Feedback error={error} notice={notice} />
        {errorCode === "email_auth_rejected" && (
          <div>
            <Button asChild variant="outline" size="sm">
              <Link to="/mail">{t("notifications.email.openMailToSync")}</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// O que avisa
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<NotificationKind, { title: Key; description: Key }> = {
  security: { title: "notifications.kinds.security.title", description: "notifications.kinds.security.description" },
  deploy: { title: "notifications.kinds.deploy.title", description: "notifications.kinds.deploy.description" },
  certificate: { title: "notifications.kinds.certificate.title", description: "notifications.kinds.certificate.description" },
  blacklist: { title: "notifications.kinds.blacklist.title", description: "notifications.kinds.blacklist.description" },
  disk: { title: "notifications.kinds.disk.title", description: "notifications.kinds.disk.description" },
  panel: { title: "notifications.kinds.panel.title", description: "notifications.kinds.panel.description" },
  backup_failed: { title: "notifications.kinds.backup_failed.title", description: "notifications.kinds.backup_failed.description" },
  backup_stale: { title: "notifications.kinds.backup_stale.title", description: "notifications.kinds.backup_stale.description" },
  backup_reminder: { title: "notifications.kinds.backup_reminder.title", description: "notifications.kinds.backup_reminder.description" },
};

function KindsCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction(onStatus);
  const anyChannel = status.telegram.state === "connected" || status.email.recipients.length > 0;

  function toggle(kind: NotificationKind, value: boolean) {
    void run("/api/notifications/kinds", { method: "PUT", body: JSON.stringify({ kinds: { [kind]: value } }) });
  }

  return (
    <Card data-testid="kinds-card">
      <CardHeader>
        <CardTitle className="text-base">{t("notifications.kinds.title")}</CardTitle>
        <CardDescription>{t("notifications.kinds.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!anyChannel && <p className="text-muted-foreground">{t("notifications.kinds.noChannel")}</p>}
        <ul className="flex flex-col gap-3">
          {NOTIFICATION_KINDS.map((kind) => (
            <li key={kind} className="flex items-start gap-3">
              <input
                id={`kind-${kind}`}
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                checked={status.kinds[kind]}
                disabled={busy !== null}
                onChange={(ev) => toggle(kind, ev.target.checked)}
              />
              <label htmlFor={`kind-${kind}`} className="min-w-0">
                <span className="font-medium">{t(KIND_LABELS[kind].title)}</span>
                <span className="block text-muted-foreground">{t(KIND_LABELS[kind].description)}</span>
              </label>
            </li>
          ))}
        </ul>
        <Feedback error={error} notice={null} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<NotificationHistoryEntry["status"], { label: Key; variant: "success" | "destructive" | "warning" }> = {
  sent: { label: "notifications.history.status.sent", variant: "success" },
  failed: { label: "notifications.history.status.failed", variant: "destructive" },
  retrying: { label: "notifications.history.status.retrying", variant: "warning" },
};

function HistoryCard({ history }: { history: NotificationHistoryEntry[] }) {
  const { t } = useI18n();
  return (
    <Card data-testid="history-card">
      <CardHeader>
        <CardTitle className="text-base">{t("notifications.history.title")}</CardTitle>
        <CardDescription>{t("notifications.history.description")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {history.length === 0 ? (
          <p className="text-muted-foreground">{t("notifications.history.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {history.slice(0, 20).map((h) => {
              const badge = STATUS_BADGE[h.status];
              return (
                <li key={h.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground sm:w-28">{when(h.at)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground sm:w-16">{h.channel === "telegram" ? t("notifications.telegram.title") : t("notifications.history.channelEmail")}</span>
                  <span className="min-w-0 flex-1 break-words">
                    {h.title}
                    {h.detail && <span className="block text-xs text-muted-foreground">{h.detail}</span>}
                  </span>
                  <span className="shrink-0">
                    <Badge variant={badge.variant}>{t(badge.label)}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Verificação automática de segurança (já existia)
// ---------------------------------------------------------------------------

function MonitorIntervalCard() {
  const { t } = useI18n();
  const [hours, setHours] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MonitorStateResponse>("/api/security/monitor/last")
      .then((res) => setHours(String(Math.round(res.config.intervalMs / 3_600_000))))
      .catch(() => setError(t("notifications.monitor.loadError")));
  }, [t]);

  async function save() {
    const value = Number(hours);
    if (!Number.isFinite(value) || value < 1 || value > 168) {
      setError(t("notifications.monitor.rangeError"));
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await apiFetch("/api/security/monitor/config", {
        method: "PUT",
        body: JSON.stringify({ intervalMs: Math.round(value * 3_600_000) }),
      });
      setSaved(true);
    } catch (err) {
      setError(errorText(err, "notifications.monitor.saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("notifications.monitor.title")}</CardTitle>
        <CardDescription>{t("notifications.monitor.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hours === null && !error ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="nt-hours" className="text-sm font-medium">
                {t("notifications.monitor.hoursLabel")}
              </label>
              <Input
                id="nt-hours"
                type="number"
                min={1}
                max={168}
                value={hours ?? ""}
                onChange={(e) => {
                  setHours(e.target.value);
                  setSaved(false);
                }}
                className="w-28"
              />
            </div>
            <Button onClick={() => void save()} disabled={saving || hours === null}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t("notifications.monitor.save")}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 pb-2 text-xs text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> {t("notifications.monitor.saved")}
              </span>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<NotificationsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    apiFetch<NotificationsStatus>("/api/notifications")
      .then(setStatus)
      .catch((err: unknown) => setLoadError(errorText(err, GENERIC_ERROR)));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        <Trans
          k="notifications.intro"
          components={{ alerts: (c) => <Link to="/alerts" className="underline underline-offset-2">{c}</Link> }}
        />
      </p>
      {loadError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            {t("notifications.retry")}
          </Button>
        </div>
      )}
      {!status && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {status && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <TelegramCard status={status} onStatus={setStatus} />
            <EmailCard status={status} onStatus={setStatus} />
          </div>
          <KindsCard status={status} onStatus={setStatus} />
          <HistoryCard history={status.history} />
        </>
      )}
      <MonitorIntervalCard />
    </div>
  );
}
