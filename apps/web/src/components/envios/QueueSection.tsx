import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { MailQueueActionResponse, MailQueueItem, MailQueueResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { formatDateTime, QUEUE_STATE_KEYS, rejectionHint, senderLabel, stateVariant } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Action = "retry" | "cancel";

const CONFIRM_TEXT: Record<Action, { question: Key; yes: Key }> = {
  retry: {
    question: "envios.queue.confirm.retry.question",
    yes: "envios.queue.confirm.retry.yes",
  },
  cancel: {
    question: "envios.queue.confirm.cancel.question",
    yes: "envios.queue.confirm.cancel.yes",
  },
};

function QueueItemCard({ item, onDone }: { item: MailQueueItem; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<MailQueueActionResponse>(`/api/mail/envios/queue/${item.id}/${action}`, { method: "POST" });
      setConfirming(null);
      onDone(res.message);
    } catch (err) {
      setError(apiErrorText(err, "envios.queue.error.action"));
    } finally {
      setBusy(false);
    }
  }

  const hint = rejectionHint(item.lastError);
  return (
    <li data-testid={`queue-${item.id}`} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <ul className="flex flex-col gap-1">
        {item.recipients.map((r) => (
          <li key={r.address} className="flex flex-wrap items-center gap-2">
            <span className="break-all font-medium">{r.address}</span>
            <Badge variant={stateVariant(r.state)}>{t(QUEUE_STATE_KEYS[r.state])}</Badge>
            {r.detail && r.detail !== item.lastError && <span className="break-words text-xs text-muted-foreground">{r.detail}</span>}
          </li>
        ))}
      </ul>
      <p className="break-words text-xs text-muted-foreground">{t("envios.sender.from", { sender: senderLabel(item.sender) })}</p>
      <p className="text-xs text-muted-foreground">
        {t("envios.queue.schedule", {
          attempts: t(item.attempts === 1 ? "envios.queue.attempts.one" : "envios.queue.attempts.many", { n: item.attempts }),
          next: formatDateTime(item.nextRetryAt),
          expires: formatDateTime(item.expiresAt),
        })}
      </p>
      {item.lastError && (
        <p className="break-words rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          {t("envios.queue.lastError", { error: item.lastError })}
          {hint && <span className="mt-1 block text-muted-foreground">{hint}</span>}
        </p>
      )}
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 p-2">
          <p className="text-xs">{t(CONFIRM_TEXT[confirming].question)}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={confirming === "cancel" ? "danger" : "default"} disabled={busy} onClick={() => void run(confirming)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t(CONFIRM_TEXT[confirming].yes)}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
              {t("envios.queue.confirm.no")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setConfirming("retry")}>
            {t("envios.queue.action.retry")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming("cancel")}>
            {t("envios.queue.action.cancel")}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </li>
  );
}

/** Fila agora: o que o servidor ainda está tentando entregar. */
export function QueueSection() {
  const { t } = useI18n();
  const [data, setData] = useState<MailQueueResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<MailQueueResponse>("/api/mail/envios/queue"));
    } catch (err) {
      setError(apiErrorText(err, "envios.queue.error.load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("envios.queue.title")}</CardTitle>
        <CardDescription>
          {t("envios.queue.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("envios.queue.refresh")}
          </Button>
          {data?.available && <span className="text-xs text-muted-foreground">{t("envios.queue.readAt", { date: formatDateTime(data.checkedAt) })}</span>}
        </div>
        {notice && <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && !data.available && <p className="text-sm text-muted-foreground">{data.message}</p>}
        {data?.available && data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("envios.queue.empty")}</p>
        )}
        {data?.available && data.items.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {t(data.total === 1 ? "envios.queue.total.one" : "envios.queue.total.many", { n: data.total })}
              {data.total > data.items.length && ` ${t("envios.queue.showingFirst", { n: data.items.length })}`}
            </p>
            <ul className="flex flex-col gap-2">
              {data.items.map((item) => (
                <QueueItemCard
                  key={item.id}
                  item={item}
                  onDone={(message) => {
                    setNotice(message);
                    void load();
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
