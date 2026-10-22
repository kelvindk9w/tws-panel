import { useRef, useState } from "react";
import { BACKUP_ENGINE_LABELS, RESTORE_CHECK_FREQUENCIES, type RestoreCheckFrequency, type RestoreCheckReasonCode, type RestoreCheckResult, type RestoreCheckView } from "@paas/core";
import { useI18n, type Key } from "@/i18n";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";
import { Feedback, errorText, when } from "@/components/backups/backup-ui";
import { AlertTriangle, DatabaseBackup, Loader2 } from "lucide-react";

const FREQUENCY_KEYS = {
  each: "backups.restoreCheck.frequency.each",
  daily: "backups.restoreCheck.frequency.daily",
  weekly: "backups.restoreCheck.frequency.weekly",
} as const satisfies Record<RestoreCheckFrequency, Key>;

const UNAVAILABLE_KEYS = {
  undetected: "backups.restoreCheck.unavailable.undetected",
  no_database: "backups.restoreCheck.unavailable.no_database",
  not_selected: "backups.restoreCheck.unavailable.not_selected",
  is_destination: "backups.restoreCheck.unavailable.is_destination",
  engine_unsupported: "backups.restoreCheck.unavailable.engine_unsupported",
} as const satisfies Record<NonNullable<RestoreCheckView["unavailableCode"]>, Key>;

const REASON_KEYS = {
  source_no_database: "backups.restoreCheck.reason.source_no_database",
  destination_missing: "backups.restoreCheck.reason.destination_missing",
  destination_renamed: "backups.restoreCheck.reason.destination_renamed",
  destination_no_database: "backups.restoreCheck.reason.destination_no_database",
  destination_chain: "backups.restoreCheck.reason.destination_chain",
  destination_not_running: "backups.restoreCheck.reason.destination_not_running",
  destination_busy: "backups.restoreCheck.reason.destination_busy",
  engine_mismatch: "backups.restoreCheck.reason.engine_mismatch",
  engine_unsupported: "backups.restoreCheck.reason.engine_unsupported",
  destination_permission: "backups.restoreCheck.reason.destination_permission",
  no_backup: "backups.restoreCheck.reason.no_backup",
  backup_incomplete: "backups.restoreCheck.reason.backup_incomplete",
  no_password: "backups.restoreCheck.reason.no_password",
  no_database_in_backup: "backups.restoreCheck.reason.no_database_in_backup",
  ambiguous_database: "backups.restoreCheck.reason.ambiguous_database",
  no_space: "backups.restoreCheck.reason.no_space",
  timeout: "backups.restoreCheck.reason.timeout",
  panel_restarted: "backups.restoreCheck.reason.panel_restarted",
  restart_before_start: "backups.restoreCheck.reason.restart_before_start",
  settings_changed: "backups.restoreCheck.reason.settings_changed",
  cleanup_failed: "backups.restoreCheck.reason.cleanup_failed",
  restore_failed: "backups.restoreCheck.reason.restore_failed",
  sanity_failed: "backups.restoreCheck.reason.sanity_failed",
  backup_unreadable: "backups.restoreCheck.reason.backup_unreadable",
  turned_off: "backups.restoreCheck.reason.turned_off",
} as const satisfies Record<RestoreCheckReasonCode, Key>;

function sameName(typed: string, word: string): boolean {
  return typed.trim().toLowerCase() === word.toLowerCase();
}

function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "Último teste de restauração: ok em <data>, no projeto <destino>". */
function LastResult({ last }: { last: RestoreCheckResult | null }) {
  const { t } = useI18n();
  if (!last) {
    return <p className="text-muted-foreground">{t("backups.restoreCheck.last.none")}</p>;
  }
  const reason = last.reasonCode ? t(REASON_KEYS[last.reasonCode]) : (last.reason ?? "");
  const at = last.finishedAt ?? last.startedAt;
  const variant = last.status === "ok" ? "success" : last.status === "failed" ? "destructive" : last.status === "running" ? "warning" : "secondary";
  const text =
    last.status === "running"
      ? t("backups.restoreCheck.last.running", { destination: last.destinationName })
      : last.status === "ok"
        ? t("backups.restoreCheck.last.ok", { when: when(at), destination: last.destinationName })
        : last.status === "failed"
          ? t("backups.restoreCheck.last.failed", { when: when(at), destination: last.destinationName, reason })
          : t("backups.restoreCheck.last.not_run", { when: when(at), destination: last.destinationName, reason });
  return (
    <div data-testid="restore-check-last" data-status={last.status} className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2">
        {last.status === "running" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        <Badge variant={variant}>{t(`backups.status.${last.status === "ok" ? "success" : last.status === "running" ? "running" : last.status === "failed" ? "failed" : "warning"}`)}</Badge>
        <span className={last.status === "failed" ? "text-red-400" : undefined}>{text}</span>
      </p>
      {last.status === "ok" && (last.durationMs !== null || last.checked !== null) && (
        <p className="text-xs text-muted-foreground">
          {[
            last.durationMs !== null ? t("backups.restoreCheck.last.duration", { duration: durationText(last.durationMs) }) : null,
            last.checked !== null ? t("backups.restoreCheck.last.checked", { tables: last.checked.tables, rows: last.checked.rows }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * Aba Backups do projeto: "Validar o backup do banco restaurando em outro
 * projeto". Desligado por padrão. Ligar pede o projeto de destino (só os
 * elegíveis, que o servidor lista) e a confirmação digitando o nome dele: o painel
 * cria um banco TEMPORÁRIO no servidor de banco do destino (e o apaga no fim) com
 * dados reais de produção. Nada do banco do próprio destino é alterado.
 */
export function RestoreCheckCard({ projectId, view, onChanged }: { projectId: string; view: RestoreCheckView; onChanged: () => void }) {
  const { t } = useI18n();
  const settings = view.settings?.enabled ? view.settings : null;
  const [destinationId, setDestinationId] = useState("");
  const [frequency, setFrequency] = useState<RestoreCheckFrequency>(settings?.frequency ?? "each");
  const [confirm, setConfirm] = useState("");
  const [testing, setTesting] = useState(false);
  const [testConfirm, setTestConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const chosen = view.candidates.find((c) => c.id === destinationId) ?? null;
  const unavailable = view.unavailableCode ? t(UNAVAILABLE_KEYS[view.unavailableCode]) : view.unavailableReason;
  const running = view.last?.status === "running";

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
          <Badge data-testid="restore-check-badge" variant={settings ? "success" : "outline"}>
            {settings ? t("backups.restoreCheck.on") : t("backups.restoreCheck.off")}
          </Badge>
        </CardTitle>
        <CardDescription>{t("backups.restoreCheck.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {view.notice && (
          <p data-testid="restore-check-notice" role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t(`backups.restoreCheck.notice.${view.notice.code}`)}
          </p>
        )}

        {unavailable ? (
          <>
            <p data-testid="restore-check-unavailable" className="text-muted-foreground">
              {unavailable}
            </p>
            {settings && (
              // a opção continua ligada mesmo com a origem indisponível: tem de dar para desligar
              <div>
                <Button variant="outline" disabled={busy !== null} onClick={() => void act("off", () => put({ enabled: false }), t("backups.restoreCheck.turnedOff"))}>
                  {busy === "off" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.restoreCheck.turnOff")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div data-testid="restore-check-warning" className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
              <p className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t("backups.restoreCheck.warning.title")}
              </p>
              <p>{t("backups.restoreCheck.warning.replace")}</p>
              <p>{t("backups.restoreCheck.warning.lgpd")}</p>
              <p>{t("backups.restoreCheck.warning.only")}</p>
              <p>{t("backups.restoreCheck.warning.schema")}</p>
              <p>{t("backups.restoreCheck.warning.partial")}</p>
            </div>

            {settings ? (
              <div className="flex flex-col gap-3">
                <p data-testid="restore-check-current">
                  <strong className="font-medium">{t("backups.restoreCheck.current", { name: settings.destinationName })}</strong>
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 sm:w-auto">
                    <label htmlFor="rc-frequency-on" className="text-muted-foreground">
                      {t("backups.restoreCheck.frequency")}
                    </label>
                    <select
                      id="rc-frequency-on"
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
                  <Button variant="outline" disabled={busy !== null} onClick={() => void act("off", () => put({ enabled: false }), t("backups.restoreCheck.turnedOff"))}>
                    {busy === "off" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.restoreCheck.turnOff")}
                  </Button>
                  <Button variant="info" disabled={busy !== null || running} onClick={() => setTesting((v) => !v)}>
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t("backups.restoreCheck.testNow")}
                  </Button>
                </div>
                {testing && (
                  <div data-testid="restore-check-test-now" className="flex flex-col gap-2 rounded-md border p-3">
                    <p className="text-muted-foreground">{t("backups.restoreCheck.testNow.help")}</p>
                    <ConfirmWordInput
                      id="rc-test-confirm"
                      word={settings.destinationName}
                      value={testConfirm}
                      onChange={setTestConfirm}
                      labelKey="backups.restoreCheck.confirm.label"
                      hintKey="backups.restoreCheck.confirm.hint"
                    />
                    <div>
                      <Button
                        disabled={busy !== null || !sameName(testConfirm, settings.destinationName)}
                        onClick={() =>
                          void act(
                            "run",
                            async () => {
                              await apiFetch(`/api/backups/projects/${projectId}/restore-check/run`, { method: "POST", body: JSON.stringify({ confirm: testConfirm }) });
                              setTesting(false);
                              setTestConfirm("");
                            },
                            t("backups.restoreCheck.testNow.queued"),
                          )
                        }
                      >
                        {busy === "run" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.restoreCheck.testNow.run")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : view.candidates.length === 0 ? (
              <p data-testid="restore-check-no-candidates" className="text-muted-foreground">
                {t("backups.restoreCheck.noCandidates", { engine: view.engine ? BACKUP_ENGINE_LABELS[view.engine] : "" })}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 sm:w-auto">
                    <label htmlFor="rc-destination" className="text-muted-foreground">
                      {t("backups.restoreCheck.destination")}
                    </label>
                    <select
                      id="rc-destination"
                      className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-transparent px-2 text-sm"
                      value={destinationId}
                      onChange={(e) => {
                        setDestinationId(e.target.value);
                        setConfirm("");
                      }}
                    >
                      <option value="" className="bg-background">
                        {t("backups.restoreCheck.destination.choose")}
                      </option>
                      {view.candidates.map((c) => (
                        <option key={c.id} value={c.id} className="bg-background">
                          {t("backups.restoreCheck.destination.item", { name: c.name, engine: BACKUP_ENGINE_LABELS[c.engine] })}
                        </option>
                      ))}
                    </select>
                  </div>
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
                </div>
                {chosen && (
                  <ConfirmWordInput
                    id="rc-confirm"
                    word={chosen.name}
                    value={confirm}
                    onChange={setConfirm}
                    labelKey="backups.restoreCheck.confirm.label"
                    hintKey="backups.restoreCheck.confirm.hint"
                  />
                )}
                <div>
                  <Button
                    disabled={busy !== null || !chosen || !sameName(confirm, chosen.name)}
                    onClick={() => void act("on", () => put({ enabled: true, destinationId, frequency, confirm }), t("backups.restoreCheck.turnedOn"))}
                  >
                    {busy === "on" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.restoreCheck.turnOn")}
                  </Button>
                </div>
              </div>
            )}
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
