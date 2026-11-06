import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { AlertTriangle, Eraser, Loader2, Search } from "lucide-react";
import {
  validateDockerCleanupSettings,
  type DockerCleanupBlock,
  type DockerCleanupFrequency,
  type DockerCleanupImage,
  type DockerCleanupProtectedImage,
  type DockerCleanupRecord,
  type DockerCleanupSettings as Settings,
  type DockerCleanupState,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { formatBytes, formatPercent } from "@/lib/metrics";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const size = (n: number) => formatBytes(n) ?? "0 B";
const FREQUENCIES: ReadonlyArray<{ value: DockerCleanupFrequency; key: Key }> = [
  { value: "daily", key: "dockerCleanup.auto.frequency.daily" },
  { value: "weekly", key: "dockerCleanup.auto.frequency.weekly" },
  { value: "monthly", key: "dockerCleanup.auto.frequency.monthly" },
];
const BLOCK_KEY: Record<DockerCleanupBlock, Key> = {
  deploy: "dockerCleanup.block.deploy",
  backup: "dockerCleanup.block.backup",
  cleaning: "dockerCleanup.block.cleaning",
  docker_unavailable: "dockerCleanup.block.docker_unavailable",
};
const REASON_KEY: Record<DockerCleanupProtectedImage["reason"], Key> = {
  panel: "dockerCleanup.list.reason.panel",
  in_use: "dockerCleanup.list.reason.in_use",
  recent: "dockerCleanup.list.reason.recent",
};
const TRIGGER_KEY: Record<DockerCleanupRecord["trigger"], Key> = {
  manual: "dockerCleanup.history.trigger.manual",
  schedule: "dockerCleanup.history.trigger.schedule",
  disk: "dockerCleanup.history.trigger.disk",
};
const RESULT_KEY: Record<DockerCleanupRecord["result"], Key> = {
  success: "dockerCleanup.history.result.success",
  partial: "dockerCleanup.history.result.partial",
  failed: "dockerCleanup.history.result.failed",
};

type Message = { tone: "ok" | "error"; text: string } | null;

/**
 * Configurações → Limpeza do Docker: verificador (só leitura, sempre disponível), limpeza automática
 * (desligada por padrão), "Limpar agora" com confirmação e o histórico das limpezas.
 */
export function DockerCleanupSettings() {
  const { t } = useI18n();
  const base = useId();
  const [state, setState] = useState<DockerCleanupState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanMessage, setScanMessage] = useState<Message>(null);
  const [runMessage, setRunMessage] = useState<Message>(null);
  const [saveMessage, setSaveMessage] = useState<Message>(null);

  const apply = (next: DockerCleanupState, keepDraft = false) => {
    setState(next);
    if (!keepDraft) setDraft({ ...next.settings });
  };

  const load = useCallback(async () => {
    try {
      apply(await apiFetch<DockerCleanupState>("/api/docker-cleanup"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const blockText = (err: unknown): string | null => {
    const code = err instanceof ApiRequestError ? err.code : "";
    const reason = (Object.keys(BLOCK_KEY) as DockerCleanupBlock[]).find((r) => code === `cleanup_${r}` || (r === "docker_unavailable" && code === "docker_unavailable"));
    return reason ? t(BLOCK_KEY[reason]) : null;
  };

  async function scan() {
    setScanning(true);
    setScanMessage(null);
    try {
      apply(await apiFetch<DockerCleanupState>("/api/docker-cleanup/scan", { method: "POST" }), true);
    } catch (err) {
      setScanMessage({ tone: "error", text: blockText(err) ?? t("dockerCleanup.scan.error") });
    } finally {
      setScanning(false);
    }
  }

  async function run() {
    setCleaning(true);
    setRunMessage(null);
    try {
      const res = await apiFetch<{ record: DockerCleanupRecord; state: DockerCleanupState }>("/api/docker-cleanup/run", { method: "POST", body: JSON.stringify({ confirm: true }) });
      apply(res.state, true);
      const key: Key = res.record.result === "success" ? "dockerCleanup.run.done" : res.record.result === "partial" ? "dockerCleanup.run.partial" : "dockerCleanup.run.failed";
      setRunMessage({ tone: res.record.result === "failed" ? "error" : "ok", text: t(key, { size: size(res.record.freedBytes) }) });
    } catch (err) {
      setRunMessage({ tone: "error", text: blockText(err) ?? t("dockerCleanup.run.error") });
    } finally {
      setCleaning(false);
      setConfirming(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    if (!validateDockerCleanupSettings(draft).ok) {
      setSaveMessage({ tone: "error", text: t("dockerCleanup.auto.invalid") });
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      apply(await apiFetch<DockerCleanupState>("/api/docker-cleanup/settings", { method: "PUT", body: JSON.stringify({ settings: draft }) }));
      setSaveMessage({ tone: "ok", text: t("dockerCleanup.auto.saved") });
    } catch (err) {
      setSaveMessage({ tone: "error", text: err instanceof ApiRequestError && err.code === "invalid_settings" ? t("dockerCleanup.auto.invalid") : t("dockerCleanup.auto.saveError") });
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <Eraser className="h-4 w-4" /> {t("dockerCleanup.title")}
      </CardTitle>
      <CardDescription>{t("dockerCleanup.desc")}</CardDescription>
    </CardHeader>
  );

  if (!state || !draft) {
    return (
      <Card>
        {header}
        <CardContent>
          {loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("dockerCleanup.loadError")}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("dockerCleanup.loading")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const scanResult = state.lastScan;
  const limits = state.limits;
  const defaults = state.defaults;
  const busy = state.working || scanning || cleaning;
  const blockedText = state.blocked && state.blocked !== "cleaning" ? t(BLOCK_KEY[state.blocked]) : null;
  const canClean = scanResult !== null && scanResult.totalBytes > 0 && state.blocked === null && !busy;
  const num = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
  const field = (id: string, value: number, min: number, max: number, onChange: (v: number) => void) => (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={Number.isNaN(value) ? "" : String(value)}
      aria-invalid={Number.isNaN(value) || !Number.isInteger(value) || value < min || value > max}
      onChange={(e) => {
        onChange(num(e.target.value));
        setSaveMessage(null);
      }}
    />
  );
  const imageRow = (i: DockerCleanupImage | DockerCleanupProtectedImage) => (
    <li key={i.id} className="flex flex-col gap-0.5 border-b py-1.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <span className="min-w-0 break-all font-mono text-xs">{i.tags.length > 0 ? i.tags.join(", ") : `${t("dockerCleanup.list.noName")} ${i.id.replace(/^sha256:/, "").slice(0, 12)}`}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("dockerCleanup.list.row", { size: size(i.bytes), days: i.ageDays })}
        {"reason" in i && <> · {t(REASON_KEY[i.reason])}</>}
      </span>
    </li>
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        {header}
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="flex items-center gap-2 font-medium">
              <Search className="h-4 w-4" /> {t("dockerCleanup.scan.title")}
            </h3>
            <Button type="button" variant="outline" size="sm" onClick={() => void scan()} disabled={busy}>
              {scanning && <Loader2 className="h-4 w-4 animate-spin" />}
              {scanning ? t("dockerCleanup.scan.working") : t("dockerCleanup.scan.button")}
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="docker-cleanup-last-scan">
              {scanResult ? t("dockerCleanup.scan.last", { date: formatDateTime(scanResult.scannedAt) }) : t("dockerCleanup.scan.never")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("dockerCleanup.scan.desc")}</p>
          {scanMessage && (
            <p role="alert" className="text-destructive">
              {scanMessage.text}
            </p>
          )}
          {state.warning && (
            <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="docker-cleanup-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("dockerCleanup.scan.warning")}
            </p>
          )}
          {scanResult && (
            <div className="flex flex-col gap-3" data-testid="docker-cleanup-result">
              <dl className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <dt className="text-xs text-muted-foreground">{t("dockerCleanup.scan.cache")}</dt>
                  <dd className="font-medium">{t("dockerCleanup.scan.cacheValue", { size: size(scanResult.buildCache.bytes), count: scanResult.buildCache.entries })}</dd>
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-xs text-muted-foreground">{t("dockerCleanup.scan.images")}</dt>
                  <dd className="font-medium">{t("dockerCleanup.scan.imagesValue", { size: size(scanResult.images.bytes), count: scanResult.images.candidates.length })}</dd>
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-xs text-muted-foreground">{t("dockerCleanup.scan.total")}</dt>
                  <dd className="font-medium" data-testid="docker-cleanup-total">
                    {t("dockerCleanup.scan.totalValue", { size: size(scanResult.totalBytes) })}
                    {scanResult.totalPercentOfDisk !== null && <span className="text-muted-foreground"> · {t("dockerCleanup.scan.totalPercent", { percent: formatPercent(scanResult.totalPercentOfDisk) ?? "0" })}</span>}
                  </dd>
                </div>
              </dl>
              {scanResult.disk && (
                <p className="text-xs text-muted-foreground">
                  {t("dockerCleanup.scan.disk", { percent: formatPercent(scanResult.disk.usedPercent) ?? "0", used: size(scanResult.disk.usedBytes), total: size(scanResult.disk.totalBytes) })}
                </p>
              )}
              {scanResult.totalBytes === 0 ? (
                <p className="text-muted-foreground">{t("dockerCleanup.scan.nothing", { days: scanResult.minAgeDays })}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("dockerCleanup.scan.estimate", { days: scanResult.minAgeDays })}</p>
              )}
              <details className="rounded-md border px-3 py-2" data-testid="docker-cleanup-remove-list">
                <summary className="cursor-pointer font-medium">{t("dockerCleanup.list.remove", { count: scanResult.images.candidates.length })}</summary>
                {scanResult.images.candidates.length === 0 ? <p className="py-2 text-xs text-muted-foreground">{t("dockerCleanup.list.none")}</p> : <ul className="mt-2">{scanResult.images.candidates.map(imageRow)}</ul>}
              </details>
              <details className="rounded-md border px-3 py-2" data-testid="docker-cleanup-protected-list">
                <summary className="cursor-pointer font-medium">{t("dockerCleanup.list.protected", { count: scanResult.images.protected.length })}</summary>
                {scanResult.images.protected.length === 0 ? <p className="py-2 text-xs text-muted-foreground">{t("dockerCleanup.list.none")}</p> : <ul className="mt-2">{scanResult.images.protected.map(imageRow)}</ul>}
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dockerCleanup.run.title")}</CardTitle>
          <CardDescription>{t("dockerCleanup.run.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {blockedText && (
            <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="docker-cleanup-blocked">
              {blockedText}
            </p>
          )}
          {!scanResult && <p className="text-xs text-muted-foreground">{t("dockerCleanup.run.needScan")}</p>}
          {confirming && scanResult ? (
            <div role="alertdialog" aria-label={t("dockerCleanup.run.confirmTitle")} className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="docker-cleanup-confirm">
              <p className="font-medium">{t("dockerCleanup.run.confirmTitle")}</p>
              <p>
                {t("dockerCleanup.run.confirmText", {
                  cache: size(scanResult.buildCache.bytes),
                  count: scanResult.images.candidates.length,
                  images: size(scanResult.images.bytes),
                  total: size(scanResult.totalBytes),
                })}
              </p>
              <ul className="max-h-48 overflow-y-auto">{scanResult.images.candidates.map(imageRow)}</ul>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="destructive" onClick={() => void run()} disabled={cleaning}>
                  {cleaning && <Loader2 className="h-4 w-4 animate-spin" />}
                  {cleaning ? t("dockerCleanup.run.working") : t("dockerCleanup.run.confirmButton")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={cleaning}>
                  {t("dockerCleanup.run.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button type="button" onClick={() => setConfirming(true)} disabled={!canClean}>
                {t("dockerCleanup.run.button")}
              </Button>
            </div>
          )}
          {runMessage && (
            <p role={runMessage.tone === "error" ? "alert" : "status"} className={runMessage.tone === "error" ? "text-destructive" : "text-emerald-400"}>
              {runMessage.text}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dockerCleanup.auto.title")}</CardTitle>
          <CardDescription>{t("dockerCleanup.auto.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={(e) => void save(e)} className="flex max-w-lg flex-col gap-4 text-sm">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => {
                  setDraft({ ...draft, enabled: e.target.checked });
                  setSaveMessage(null);
                }}
              />
              {t("dockerCleanup.auto.enabled")}
            </label>
            <p className="text-xs text-muted-foreground" data-testid="docker-cleanup-auto-state">
              {state.settings.enabled ? (state.nextRunAt ? t("dockerCleanup.auto.next", { date: formatDateTime(state.nextRunAt) }) : "") : t("dockerCleanup.auto.off")}
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-freq`} className="font-medium">
                {t("dockerCleanup.auto.frequency")}
              </label>
              <select
                id={`${base}-freq`}
                value={draft.frequency}
                onChange={(e) => {
                  setDraft({ ...draft, frequency: e.target.value as DockerCleanupFrequency });
                  setSaveMessage(null);
                }}
                className="h-9 rounded-md border bg-background px-2"
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {t(f.key)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-age`} className="font-medium">
                {t("dockerCleanup.auto.minAge")}
              </label>
              {field(`${base}-age`, draft.minAgeDays, limits.minAgeDays.min, limits.minAgeDays.max, (v) => setDraft({ ...draft, minAgeDays: v }))}
              <p className="text-xs text-muted-foreground">{t("dockerCleanup.auto.minAgeHelp", { min: limits.minAgeDays.min, max: limits.minAgeDays.max, def: defaults.minAgeDays })}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={draft.diskTriggerPercent !== null}
                  onChange={(e) => {
                    setDraft({ ...draft, diskTriggerPercent: e.target.checked ? 90 : null });
                    setSaveMessage(null);
                  }}
                />
                {t("dockerCleanup.auto.diskTrigger")}
              </label>
              {draft.diskTriggerPercent !== null && (
                <>
                  <label htmlFor={`${base}-trigger`} className="text-xs">
                    {t("dockerCleanup.auto.diskTriggerPercent")}
                  </label>
                  {field(`${base}-trigger`, draft.diskTriggerPercent, limits.diskTriggerPercent.min, limits.diskTriggerPercent.max, (v) => setDraft({ ...draft, diskTriggerPercent: v }))}
                  <p className="text-xs text-muted-foreground">{t("dockerCleanup.auto.diskTriggerHelp", { min: limits.diskTriggerPercent.min, max: limits.diskTriggerPercent.max })}</p>
                </>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-warn-gain`} className="font-medium">
                {t("dockerCleanup.auto.warnGain")}
              </label>
              {field(`${base}-warn-gain`, draft.warnGainGb, limits.warnGainGb.min, limits.warnGainGb.max, (v) => setDraft({ ...draft, warnGainGb: v }))}
              <p className="text-xs text-muted-foreground">{t("dockerCleanup.auto.warnGainHelp", { min: limits.warnGainGb.min, max: limits.warnGainGb.max, def: defaults.warnGainGb })}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-warn-disk`} className="font-medium">
                {t("dockerCleanup.auto.warnDisk")}
              </label>
              {field(`${base}-warn-disk`, draft.warnDiskPercent, limits.warnDiskPercent.min, limits.warnDiskPercent.max, (v) => setDraft({ ...draft, warnDiskPercent: v }))}
              <p className="text-xs text-muted-foreground">{t("dockerCleanup.auto.warnDiskHelp", { min: limits.warnDiskPercent.min, max: limits.warnDiskPercent.max, def: defaults.warnDiskPercent })}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t("dockerCleanup.auto.safety")}</p>
            {saveMessage && (
              <p role={saveMessage.tone === "error" ? "alert" : "status"} className={saveMessage.tone === "error" ? "text-destructive" : "text-emerald-400"}>
                {saveMessage.text}
              </p>
            )}
            <div>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("dockerCleanup.auto.save")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dockerCleanup.history.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {state.history.length === 0 ? (
            <p className="text-muted-foreground">{t("dockerCleanup.history.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="docker-cleanup-history">
              {state.history.map((r) => (
                <li key={r.id} className="rounded-md border p-3">
                  <p className="font-medium">
                    {formatDateTime(r.at)} · {t(TRIGGER_KEY[r.trigger])} · {t(RESULT_KEY[r.result])}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("dockerCleanup.history.row", { size: size(r.freedBytes), cache: size(r.buildCacheBytes), images: size(r.imagesBytes), count: r.removedImages.length })}
                    {r.trigger === "manual" && <> {t("dockerCleanup.history.by", { actor: r.actor })}</>}
                  </p>
                  {r.removedImages.length > 0 && (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer">{t("dockerCleanup.history.removed")}</summary>
                      <p className="mt-1 break-all font-mono">{r.removedImages.join(", ")}</p>
                    </details>
                  )}
                  {r.errors.length > 0 && (
                    <details className="mt-1 text-xs text-destructive">
                      <summary className="cursor-pointer">{t("dockerCleanup.history.errors")}</summary>
                      <ul className="mt-1 break-all font-mono">
                        {r.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
