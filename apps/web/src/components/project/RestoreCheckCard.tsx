import { useRef, useState } from "react";
import { BACKUP_ENGINE_LABELS, RESTORE_CHECK_FREQUENCIES, type RestoreCheckFrequency, type RestoreCheckResult, type RestoreCheckView } from "@paas/core";
import { useI18n, type Key } from "@/i18n";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Feedback, errorText, restoreCheckReason, when } from "@/components/backups/backup-ui";
import { DatabaseBackup, Loader2, PlayCircle } from "lucide-react";

const FREQUENCY_KEYS = {
  each: "backups.restoreCheck.frequency.each",
  daily: "backups.restoreCheck.frequency.daily",
  weekly: "backups.restoreCheck.frequency.weekly",
} as const satisfies Record<RestoreCheckFrequency, Key>;

function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "Último teste de restauração: ok em <data>" com o que foi conferido. */
function LastResult({ last }: { last: RestoreCheckResult | null }) {
  const { t } = useI18n();
  if (!last) {
    return <p className="text-muted-foreground">{t("backups.restoreCheck.last.none")}</p>;
  }
  const reason = restoreCheckReason(last.reasonCode, last.reason);
  const at = last.finishedAt ?? last.startedAt;
  const variant = last.status === "ok" ? "success" : last.status === "failed" ? "destructive" : last.status === "running" ? "warning" : "secondary";
  const text =
    last.status === "running"
      ? t("backups.restoreCheck.last.running")
      : last.status === "ok"
        ? t("backups.restoreCheck.last.ok", { when: when(at) })
        : last.status === "failed"
          ? t("backups.restoreCheck.last.failed", { when: when(at), reason })
          : t("backups.restoreCheck.last.not_run", { when: when(at), reason });
  const c = last.checked;
  const details =
    last.status === "ok"
      ? [
          last.durationMs !== null ? t("backups.restoreCheck.last.duration", { duration: durationText(last.durationMs) }) : null,
          c && last.engine ? (c.rows === null ? t("backups.restoreCheck.last.checkedTables", { tables: c.tables }) : t("backups.restoreCheck.last.checked", { tables: c.tables, rows: c.rows })) : null,
          c?.files ? t("backups.restoreCheck.last.checkedFiles", { files: c.files }) : null,
          last.image ? t("backups.restoreCheck.last.image", { image: last.image }) : null,
        ].filter(Boolean)
      : [];
  return (
    <div data-testid="restore-check-last" data-status={last.status} className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2">
        {last.status === "running" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        <Badge variant={variant}>{t(`backups.status.${last.status === "ok" ? "success" : last.status === "running" ? "running" : last.status === "failed" ? "failed" : "warning"}`)}</Badge>
        <span className={last.status === "failed" ? "text-red-400" : undefined}>{text}</span>
      </p>
      {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>}
    </div>
  );
}

/**
 * Aba Backups do projeto: "Testar a restauração do backup numa cópia
 * descartável". Ligado por padrão (no máximo 1 vez por dia). O painel sobe um
 * container novo da mesma imagem do banco, sem rede e sem os volumes do
 * projeto, restaura o backup nele, confere e remove o container. Como nada do
 * projeto é tocado, ligar, desligar e "Testar restauração" não pedem confirmação.
 */
export function RestoreCheckCard({ projectId, view, onChanged }: { projectId: string; view: RestoreCheckView; onChanged: () => void }) {
  const { t } = useI18n();
  const settings = view.settings;
  const [frequency, setFrequency] = useState<RestoreCheckFrequency>(settings.frequency);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const running = view.last?.status === "running";
  const unavailable = view.unavailableCode ? t(`backups.restoreCheck.unavailable.${view.unavailableCode}`) : view.unavailableReason;

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      // o botão apertado fica desabilitado enquanto age: o foco vai para o resultado, em vez de se perder
      setTimeout(() => feedbackRef.current?.focus(), 0);
    }
  }

  const put = (body: Record<string, unknown>) => apiFetch(`/api/backups/projects/${projectId}/restore-check`, { method: "PUT", body: JSON.stringify(body) });

  return (
    <Card data-testid="restore-check-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <DatabaseBackup className="h-4 w-4 text-emerald-400" /> {t("backups.restoreCheck.title")}
          <Badge data-testid="restore-check-badge" variant={settings.enabled ? "success" : "outline"}>
            {settings.enabled ? t("backups.restoreCheck.on") : t("backups.restoreCheck.off")}
            {view.isDefault ? ` (${t("backups.restoreCheck.default")})` : ""}
          </Badge>
        </CardTitle>
        <CardDescription>{t("backups.restoreCheck.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {unavailable ? (
          <p data-testid="restore-check-unavailable" className="text-muted-foreground">
            {unavailable}
          </p>
        ) : (
          <>
            <p data-testid="restore-check-scope" className="text-muted-foreground">
              {view.engine ? t("backups.restoreCheck.engine", { engine: BACKUP_ENGINE_LABELS[view.engine] }) : t("backups.restoreCheck.filesOnly")}{" "}
              {t("backups.restoreCheck.limits", { memory: view.limits.memoryMb, cpus: view.limits.cpus, minutes: view.limits.restoreMinutes })}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              {settings.enabled && (
                <>
                  <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 sm:w-auto">
                    <label htmlFor="rc-frequency" className="text-muted-foreground">
                      {t("backups.restoreCheck.frequency")}
                    </label>
                    <select
                      id="rc-frequency"
                      className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-transparent px-2 text-sm"
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value as RestoreCheckFrequency)}
                    >
                      {RESTORE_CHECK_FREQUENCIES.map((f) => (
                        <option key={f} value={f} className="bg-background">
                          {t(FREQUENCY_KEYS[f])}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy !== null || frequency === settings.frequency}
                    onClick={() => void act("frequency", () => put({ enabled: true, frequency }), t("backups.restoreCheck.frequencySaved"))}
                  >
                    {busy === "frequency" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.restoreCheck.saveFrequency")}
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "toggle",
                    () => put(settings.enabled ? { enabled: false } : { enabled: true, frequency: settings.frequency }),
                    settings.enabled ? t("backups.restoreCheck.turnedOff") : t("backups.restoreCheck.turnedOn"),
                  )
                }
              >
                {busy === "toggle" && <Loader2 className="h-4 w-4 animate-spin" />} {settings.enabled ? t("backups.restoreCheck.turnOff") : t("backups.restoreCheck.turnOn")}
              </Button>
              <Button
                variant="info"
                disabled={busy !== null || running}
                onClick={() =>
                  void act(
                    "run",
                    () => apiFetch(`/api/backups/projects/${projectId}/restore-check/run`, { method: "POST", body: "{}" }),
                    t("backups.restoreCheck.testNow.queued"),
                  )
                }
              >
                {busy === "run" || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} {t("backups.restoreCheck.testNow")}
              </Button>
            </div>
          </>
        )}

        <div className="flex flex-col gap-1">
          <span className="font-medium">{t("backups.restoreCheck.last.label")}</span>
          <LastResult last={view.last} />
        </div>
        <div ref={feedbackRef} tabIndex={-1} role="status" aria-live="polite" className="flex flex-col gap-1 outline-none">
          <Feedback error={error} notice={notice} />
        </div>
      </CardContent>
    </Card>
  );
}
