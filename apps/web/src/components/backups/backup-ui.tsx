/**
 * Peças da tela de backups usadas em Configurações → Backups e na aba Backups
 * do projeto: situação de cada backup, histórico, frequência e cópias
 * guardadas, a janela de restauração (com progresso) e a criação da senha.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BACKUP_FREQUENCIES,
  MAX_BACKUP_KEEP,
  MIN_BACKUP_PASSWORD_LENGTH,
  backupCoverageHours,
  backupPasswordStrength,
  buildRecoveryKit,
  type BackupCheckResult,
  type BackupFrequencyHours,
  type BackupPoint,
  type BackupRecord,
  type BackupRemoteState,
  type BackupsStatus,
  type BackupTargetSettings,
  type BackupTargetStatus,
  type BackupVerifyRequest,
  type BackupVerifySummary,
} from "@paas/core";
import { Link } from "react-router";
import { apiErrorText, formatDateTime, formatNumber, lowerCase, t, Trans, useI18n, type Key } from "@/i18n";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Download, Loader2, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";

export function errorText(err: unknown): string {
  return apiErrorText(err, "backups.error.generic");
}

export function when(iso: string): string {
  return formatDateTime(iso, { dateStyle: "short", timeStyle: "short" });
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return t("backups.size.unknown");
  if (n >= 1024 ** 3) return `${formatNumber(n / 1024 ** 3, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadRecoveryKit(password: string, status: Pick<BackupsStatus, "destination" | "localPath">): void {
  const d = status.destination;
  downloadText(
    "tws-panel-kit-de-recuperacao-dos-backups.txt",
    buildRecoveryKit({
      password,
      generatedAt: new Date(),
      destination: d ? { provider: d.provider, endpoint: d.endpoint, bucket: d.bucket } : null,
      localPath: status.localPath,
    }),
  );
}

export function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
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

// ---------------------------------------------------------------------------
// Situação de um backup
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<BackupRecord["status"], { label: Key; variant: "success" | "destructive" | "warning" | "secondary" }> = {
  queued: { label: "backups.status.queued", variant: "secondary" },
  running: { label: "backups.status.running", variant: "secondary" },
  success: { label: "backups.status.success", variant: "success" },
  warning: { label: "backups.status.warning", variant: "warning" },
  failed: { label: "backups.status.failed", variant: "destructive" },
};

const REMOTE_TEXT: Record<BackupRemoteState, Key | null> = {
  none: null,
  uploading: "backups.remoteText.uploading",
  uploaded: "backups.remoteText.uploaded",
  verified: "backups.remoteText.verified",
  failed: "backups.remoteText.failed",
  skipped: "backups.remoteText.skipped",
};

export function RecordBadge({ record }: { record: BackupRecord }) {
  const { t } = useI18n();
  const b = STATUS_BADGE[record.status];
  return (
    <Badge variant={b.variant}>
      {(record.status === "running" || record.status === "queued") && <Loader2 className="h-3 w-3 animate-spin" />}
      {t(b.label)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Conferir backups
// ---------------------------------------------------------------------------

/** "Íntegro — conferido em …", "Falhou: …" e os outros resultados de uma cópia. */
export function checkText(c: BackupCheckResult | null | undefined): string {
  if (!c) return t("backups.check.none");
  switch (c.status) {
    case "ok":
      return t("backups.check.ok", { when: when(c.at) });
    case "failed":
      return t("backups.check.failed", { reason: c.reason ?? t("backups.check.reasonUnknown") });
    case "missing":
      return c.reason ? t("backups.check.missingReason", { reason: c.reason }) : t("backups.check.missing");
    default:
      return t("backups.check.needsPassword");
  }
}

const CHECK_COLOR: Record<BackupCheckResult["status"], string> = {
  ok: "text-emerald-400",
  failed: "text-red-400",
  missing: "text-muted-foreground",
  needs_password: "text-amber-400",
};

/** Resumo de uma conferência: "3 íntegras · 1 com problema". */
export function verifySummaryText(s: BackupVerifySummary): string {
  const parts = [
    s.ok ? t("backups.verify.summary.ok", { count: s.ok }) : null,
    s.failed ? t("backups.verify.summary.failed", { count: s.failed }) : null,
    s.missing ? t("backups.verify.summary.missing", { count: s.missing }) : null,
    s.needsPassword ? t("backups.verify.summary.needsPassword", { count: s.needsPassword }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("backups.verify.summary.nothing");
}

function postVerify(target: string, body: BackupVerifyRequest): Promise<BackupRecord> {
  const url = target === "all" ? "/api/backups/verify" : `/api/backups/targets/${target}/verify`;
  return apiFetch<BackupRecord>(url, { method: "POST", body: JSON.stringify(body) });
}

/** "Conferir todos": de um item (target) ou de tudo ("all"). */
export function VerifyAllButton({
  target,
  onQueued,
  label,
  disabled,
}: {
  target: string;
  onQueued: () => void;
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="outline"
        disabled={busy || disabled}
        onClick={() => {
          setBusy(true);
          setError(null);
          postVerify(target, {})
            .then(onQueued)
            .catch((err: unknown) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {label ?? t("backups.verifyAll.button")}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** Situação de cada cópia de um backup, o botão Conferir e a senha da época quando falta. */
function BackupChecks({ record, onVerify }: { record: BackupRecord; onVerify: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [queued, setQueued] = useState(false);
  const hasRemote = record.remote === "uploaded" || record.remote === "verified" || record.remote === "failed";
  const localGone = record.local && record.localExists === false;
  const needsPassword = record.remoteCheck?.status === "needs_password";
  const fileName = record.fileName ?? "";

  function run(body: BackupVerifyRequest) {
    setBusy(true);
    setError(null);
    postVerify(record.target, body)
      .then(() => {
        setQueued(true);
        setPassword("");
        onVerify();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }

  // A cópia externa já é baixada e testada logo depois do envio.
  const verifiedOnUpload = record.remote === "verified";
  if (!record.local && !hasRemote) return null;
  return (
    <span className="mt-1 flex flex-col gap-1 text-xs" data-testid="backup-checks">
      {record.local && (
        <span className={localGone || !record.localCheck ? "text-muted-foreground" : CHECK_COLOR[record.localCheck.status]}>
          {t("backups.checks.vpsCopy", { state: localGone ? t("backups.checks.vpsGone") : checkText(record.localCheck) })}
        </span>
      )}
      {hasRemote && (
        <span className={record.remoteCheck ? CHECK_COLOR[record.remoteCheck.status] : verifiedOnUpload ? "text-emerald-400" : "text-muted-foreground"}>
          {t("backups.checks.externalCopy", {
            state: !record.remoteCheck && verifiedOnUpload ? t("backups.checks.verifiedOnUpload") : checkText(record.remoteCheck),
          })}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7" disabled={busy || (localGone && !hasRemote)} onClick={() => run({ fileName })}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} {t("backups.checks.check")}
        </Button>
        {queued && !busy && <span className="text-muted-foreground">{t("backups.checks.queued")}</span>}
      </span>
      {needsPassword && (
        <span className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t("backups.checks.otherPassword")}</span>
          <span className="flex flex-wrap items-center gap-2">
            <PasswordInput
              aria-label={t("backups.checks.passwordLabel")}
              className="h-8 w-56"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
            <Button size="sm" variant="outline" className="h-8" disabled={busy || !password} onClick={() => run({ fileName, where: "remote", password })}>
              {t("backups.checks.checkWithPassword")}
            </Button>
          </span>
        </span>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** Andamento e resultado de uma conferência. */
function VerifyDetail({ record }: { record: BackupRecord }) {
  const { t } = useI18n();
  const v = record.verify;
  if (!v) return null;
  const done = v.items.filter((i) => i.status !== "pending" && i.status !== "running").length;
  const active = record.status === "running" || record.status === "queued";
  const problems = v.items.filter((i) => i.status === "failed" || i.status === "needs_password");
  const copy = (w: "local" | "remote") => (w === "local" ? t("backups.verifyDetail.vpsCopy") : t("backups.verifyDetail.externalCopy"));
  return (
    <span className="block text-xs" data-testid="verify-detail">
      {active ? (
        <span className="text-sky-300">{t("backups.verifyDetail.progress", { done, total: v.items.length })}</span>
      ) : (
        <span className="text-muted-foreground">{verifySummaryText(v.summary)}</span>
      )}
      {problems.map((i, n) => (
        <span key={n} className={cn("block", i.status === "failed" ? "text-red-400" : "text-amber-400")}>
          {record.target === "all" ? `${i.targetName} · ` : ""}
          {i.fileName} · {copy(i.where)}: {i.status === "failed" ? t("backups.check.failed", { reason: i.reason ?? "" }) : i.reason}
        </span>
      ))}
    </span>
  );
}

type BadgeVariant = "success" | "destructive" | "warning" | "secondary";

/**
 * Selo da cópia externa ao lado do "Concluído": o resultado da última
 * conferência manda (Conferir), senão a situação do envio.
 */
export function remoteBadge(record: BackupRecord): { label: string; variant: BadgeVariant } | null {
  if (record.operation !== "backup" || record.status === "queued") return null;
  // backup que falhou antes do envio: o selo "Falhou" já diz tudo
  if (record.status === "failed" && record.remote === "none") return null;
  const c = record.remoteCheck;
  if (c && record.remote !== "none" && record.remote !== "skipped") {
    if (c.status === "ok") return { label: t("backups.badge.remoteVerified"), variant: "success" };
    if (c.status === "failed") return { label: t("backups.badge.remoteFailed"), variant: "destructive" };
    if (c.status === "needs_password") return { label: t("backups.badge.remoteNeedsPassword"), variant: "warning" };
    return { label: t("backups.badge.remoteGone"), variant: "secondary" };
  }
  switch (record.remote) {
    case "verified":
      return { label: t("backups.badge.remoteVerified"), variant: "success" };
    case "uploading":
      return { label: t("backups.badge.uploading"), variant: "warning" };
    case "uploaded":
      return { label: t("backups.badge.checking"), variant: "warning" };
    case "failed":
      return { label: t("backups.badge.remoteFailed"), variant: "destructive" };
    case "skipped":
      return { label: t("backups.badge.remoteSkipped"), variant: "warning" };
    default:
      return record.local ? { label: t("backups.badge.vpsOnly"), variant: "secondary" } : null;
  }
}

function operationText(record: BackupRecord): string {
  if (record.operation === "restore") return t("backups.operation.restore");
  if (record.operation === "verify") return record.fileName ? t("backups.operation.verify") : t("backups.operation.verifyAll");
  return record.trigger === "schedule" ? t("backups.operation.scheduled") : t("backups.operation.manual");
}

/** Uma linha do histórico: o que, quando, onde ficou e o motivo de falha/aviso. */
export function RecordLine({ record, showTarget = true, onVerify }: { record: BackupRecord; showTarget?: boolean; onVerify?: () => void }) {
  const { t } = useI18n();
  const remoteKey = REMOTE_TEXT[record.remote];
  const remote = remoteKey ? t(remoteKey) : null;
  const where = record.operation === "verify" ? "" : [record.local && record.operation === "backup" ? t("backups.record.onVps") : null, remote].filter(Boolean).join(" · ");
  const checkable = onVerify && record.operation === "backup" && record.fileName && (record.status === "success" || record.status === "warning");
  const rb = remoteBadge(record);
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3" data-testid="backup-record">
      <span className="shrink-0 text-xs text-muted-foreground sm:w-28">{when(record.finishedAt ?? record.startedAt ?? record.queuedAt)}</span>
      <span className="min-w-0 flex-1 break-words">
        {showTarget && <strong className="font-medium">{record.targetName}: </strong>}
        {operationText(record)}
        {record.fileName && <span className="text-muted-foreground"> ({record.fileName}{record.sizeBytes ? `, ${formatBytes(record.sizeBytes)}` : ""})</span>}
        {where && <span className="block text-xs text-muted-foreground">{where}</span>}
        {record.operation === "verify" && <VerifyDetail record={record} />}
        {record.error && <span className="block text-xs text-red-400">{record.error}</span>}
        {record.remoteDetail && <span className="block text-xs text-amber-400">{record.remoteDetail}</span>}
        {record.warnings.map((w, i) => (
          <span key={i} className="block text-xs text-amber-400">
            {w}
          </span>
        ))}
        {checkable && <BackupChecks record={record} onVerify={onVerify} />}
      </span>
      <span className="flex shrink-0 flex-wrap items-start gap-1 sm:justify-end">
        <RecordBadge record={record} />
        {rb && (
          <Badge variant={rb.variant} data-testid="remote-badge">
            {rb.label}
          </Badge>
        )}
      </span>
    </li>
  );
}

export function HistoryList({
  records,
  showTarget = true,
  empty,
  onVerify,
}: {
  records: BackupRecord[];
  showTarget?: boolean;
  empty: string;
  /** Com isto, cada backup ganha o botão Conferir (e o que fazer depois: recarregar). */
  onVerify?: () => void;
}) {
  if (records.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {records.map((r) => (
        <RecordLine key={r.id} record={r} showTarget={showTarget} onVerify={onVerify} />
      ))}
    </ul>
  );
}

/** Fuso usado pela agenda dos backups, com o caminho para trocar. */
export function BackupTimezoneNote({ status }: { status: Pick<BackupsStatus, "timezone" | "timezoneName"> }) {
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted-foreground" data-testid="backup-timezone">
      {t("backups.timezone.note", { zone: status.timezoneName ? `${status.timezoneName} (${status.timezone})` : status.timezone })}{" "}
      <Link to="/settings/timezone" className="underline underline-offset-2">
        {t("backups.timezone.change")}
      </Link>
    </p>
  );
}

/** Etapas de um backup ou restauração em andamento. */
export function StepList({ record }: { record: BackupRecord }) {
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {record.steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2">
          {s.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
          ) : s.status === "done" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : s.status === "failed" ? (
            <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
          ) : (
            <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />
          )}
          <span className={cn(s.status === "pending" || s.status === "skipped" ? "text-muted-foreground" : "")}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Frequência, cópias guardadas e "seus backups cobrem…"
// ---------------------------------------------------------------------------

/** "os últimos 5 dias", "as últimas 12 horas"…: o mesmo cálculo de formatBackupCoverage, no idioma da interface. */
function coverageLabel(hours: number): string {
  if (hours <= 0) return t("backups.coverage.none");
  if (hours === 1) return t("backups.coverage.lastHour");
  if (hours <= 24 || (hours < 48 && hours % 24 !== 0)) return t("backups.coverage.hours", { hours });
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? t("backups.coverage.days", { days }) : t("backups.coverage.daysHours", { days, hours: rest, count: rest });
}

export function coverageText(target: Pick<BackupTargetStatus, "frequencyHours" | "localKeep" | "remoteKeep">, remote: boolean): string {
  const local = coverageLabel(backupCoverageHours(target.frequencyHours, target.localKeep));
  if (!remote) return t("backups.coverage.local", { local });
  const external = coverageLabel(backupCoverageHours(target.frequencyHours, target.remoteKeep));
  return t("backups.coverage.both", { external, local });
}

/**
 * Ligado, frequência e cópias de um item. Sem `onSave`, grava em
 * /api/backups/targets/:id. Com `onSave` (o "Padrão dos projetos"), quem usa
 * decide o que gravar e devolve o aviso; `extra` aparece antes do Salvar e
 * `extraDirty` libera o Salvar mesmo sem mudar os campos.
 */
export function TargetSettings({
  target,
  remote,
  timezone,
  backupHour,
  onSaved,
  onSave,
  extra,
  extraDirty = false,
}: {
  target: Pick<BackupTargetStatus, "id" | "enabled" | "frequencyHours" | "localKeep" | "remoteKeep">;
  remote: boolean;
  timezone: string;
  backupHour: number;
  onSaved: () => void;
  onSave?: (settings: BackupTargetSettings, changed: boolean) => Promise<string>;
  extra?: ReactNode;
  extraDirty?: boolean;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(target.enabled);
  const [frequency, setFrequency] = useState<BackupFrequencyHours>(target.frequencyHours);
  const [localKeep, setLocalKeep] = useState(String(target.localKeep));
  const [remoteKeep, setRemoteKeep] = useState(String(target.remoteKeep));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = target.id.replace(/[^a-z0-9]/gi, "-");
  const preview = { frequencyHours: frequency, localKeep: Number(localKeep) || 0, remoteKeep: Number(remoteKeep) || 0 };
  const dirty =
    enabled !== target.enabled ||
    frequency !== target.frequencyHours ||
    Number(localKeep) !== target.localKeep ||
    Number(remoteKeep) !== target.remoteKeep;

  async function save() {
    const lk = Number(localKeep);
    const rk = Number(remoteKeep);
    if (![lk, rk].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_BACKUP_KEEP)) {
      setError(t("backups.target.keepError", { max: MAX_BACKUP_KEEP }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const settings: BackupTargetSettings = { enabled, frequencyHours: frequency, localKeep: lk, remoteKeep: rk };
    try {
      if (onSave) {
        setNotice(await onSave(settings, dirty));
      } else {
        await apiFetch(`/api/backups/targets/${target.id}`, { method: "PUT", body: JSON.stringify(settings) });
        setNotice(t("backups.target.saved"));
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const hh = String(backupHour).padStart(2, "0");
  const saveButton = (
    <Button onClick={() => void save()} disabled={busy || !(dirty || extraDirty)}>
      {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.action.save")}
    </Button>
  );
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-sky-600"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid={`enabled-${id}`}
        />
        {t("backups.target.autoOn")}
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`freq-${id}`} className="font-medium">
            {t("backups.target.frequency")}
          </label>
          <select
            id={`freq-${id}`}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={frequency}
            onChange={(e) => setFrequency(Number(e.target.value) as BackupFrequencyHours)}
          >
            {BACKUP_FREQUENCIES.map((f) => (
              <option key={f} value={f} className="bg-background">
                {f === 24 ? t("backups.target.freqDaily") : t("backups.target.freqEvery", { hours: f })}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`lk-${id}`} className="font-medium">
            {t("backups.target.localKeep")}
          </label>
          <Input id={`lk-${id}`} type="number" min={1} max={MAX_BACKUP_KEEP} className="w-24" value={localKeep} onChange={(e) => setLocalKeep(e.target.value)} />
        </div>
        {remote && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`rk-${id}`} className="font-medium">
              {t("backups.target.remoteKeep")}
            </label>
            <Input id={`rk-${id}`} type="number" min={1} max={MAX_BACKUP_KEEP} className="w-24" value={remoteKeep} onChange={(e) => setRemoteKeep(e.target.value)} />
          </div>
        )}
        {!extra && saveButton}
      </div>
      <p className="text-muted-foreground">
        {enabled
          ? `${frequency === 24 ? t("backups.target.scheduleOnce", { hour: hh, timezone }) : t("backups.target.scheduleRepeat", { hour: hh, timezone, hours: frequency })} `
          : `${t("backups.target.scheduleOff")} `}
        {coverageText(preview, remote)}
      </p>
      {extra && (
        <>
          {extra}
          <div>{saveButton}</div>
        </>
      )}
      <Feedback error={error} notice={notice} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

export interface RestoreTarget {
  id: string;
  kind: "panel" | "email" | "project";
  name: string;
}

/**
 * Palavra que o servidor espera na confirmação (sempre em português: apps/server
 * BackupService.confirmText). É o que vai na requisição.
 */
function serverConfirmWord(target: RestoreTarget): string {
  return target.kind === "panel" ? "painel" : target.kind === "email" ? "e-mail" : target.name;
}

/** Palavra mostrada na interface, no idioma atual (o nome do projeto não muda). */
function confirmWord(target: RestoreTarget): string {
  return target.kind === "panel" ? t("backups.restore.confirmWord.panel") : target.kind === "email" ? t("backups.restore.confirmWord.email") : target.name;
}

const RESTORE_WARNING: Record<RestoreTarget["kind"], Key> = {
  project: "backups.restore.warning.project",
  email: "backups.restore.warning.email",
  panel: "backups.restore.warning.panel",
};

/**
 * Acompanhamento do reinício do painel depois de preparar a restauração
 * (achado 22 da revisão). A troca do estado só termina na subida seguinte;
 * durante o reinício a API some e, na volta, a sessão e o próprio registro
 * podem não existir mais (usuários e histórico voltam do backup).
 *  - waiting: o painel ainda vai reiniciar (prazo: restartTimeoutMs, desde
 *    `since`; passado o prazo sem reiniciar, vira timeout);
 *  - down: fora do ar (sem conexão ou 5xx) — reiniciando;
 *  - relogin: voltou e não reconhece a sessão (401, só depois de ter caído)
 *    ou o registro (404): o estado do backup está no lugar;
 *  - expired: 401 sem o painel ter caído antes — é a sessão que expirou, não
 *    prova reinício;
 *  - success / undone: voltou com a sessão valendo e o histórico diz como
 *    terminou a troca na subida;
 *  - back: voltou, mas sem registro da subida no histórico (confirmação
 *    parcial: aviso, não sucesso);
 *  - timeout: não reiniciou (neverRestarted) ou não voltou dentro do prazo.
 */
type PanelWatch =
  | { phase: "waiting"; since: number }
  | { phase: "down"; since: number; downSince: number }
  | { phase: "timeout"; neverRestarted: boolean }
  | { phase: "relogin" | "expired" | "success" | "back" }
  | { phase: "undone"; error: string | null };

/** Erros seguidos ao acompanhar uma restauração (que não é a do painel) antes de desistir. */
const MAX_POLL_ERRORS = 30;

function isFinal(record: BackupRecord): boolean {
  return record.status === "success" || record.status === "warning" || record.status === "failed";
}

/** O que a troca na subida registrou no histórico (o registro mais novo depois do pedido). */
async function bootOutcome(record: BackupRecord): Promise<PanelWatch> {
  try {
    const { history } = await apiFetch<{ history: BackupRecord[] }>("/api/backups");
    const since = record.startedAt ?? record.queuedAt;
    const boot = history.find(
      (h) =>
        h.id !== record.id &&
        h.target === "panel" &&
        h.operation === "restore" &&
        h.steps.some((st) => st.label.includes("na subida")) &&
        (h.finishedAt ?? "") >= since,
    );
    if (!boot) return { phase: "back" };
    return boot.status === "failed" ? { phase: "undone", error: boot.error } : { phase: "success" };
  } catch {
    return { phase: "back" };
  }
}

/**
 * Janela de restauração: escolhe a data, confirma digitando o nome e
 * acompanha as etapas até o fim.
 */
export function RestoreDialog({
  target,
  onClose,
  onFinished,
  allowRedeploy = false,
  defaultRedeploy = false,
  points: givenPoints,
  pollMs = 2000,
  restartTimeoutMs = 5 * 60_000,
}: {
  target: RestoreTarget;
  onClose: () => void;
  onFinished?: (record: BackupRecord) => void;
  allowRedeploy?: boolean;
  defaultRedeploy?: boolean;
  /** Datas já conhecidas (catálogo de outro servidor); sem elas, busca. */
  points?: BackupPoint[];
  /** Intervalo do acompanhamento (testes usam um curto). */
  pollMs?: number;
  /**
   * Prazo (padrão 5 min) para o painel reiniciar depois de preparada a troca,
   * e outro igual para ele voltar depois de cair, antes de desistir.
   */
  restartTimeoutMs?: number;
}) {
  const { t } = useI18n();
  const [points, setPoints] = useState<BackupPoint[] | null>(givenPoints ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [source, setSource] = useState<"local" | "remote">("local");
  const [confirm, setConfirm] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [redeploy, setRedeploy] = useState(defaultRedeploy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<BackupRecord | null>(null);
  const [watch, setWatch] = useState<PanelWatch | null>(null);
  const [lost, setLost] = useState(false);
  const finished = useRef(false);
  const pollErrors = useRef(0);

  useEffect(() => {
    if (givenPoints) return;
    apiFetch<{ points: BackupPoint[] }>(`/api/backups/targets/${target.id}/points`)
      .then((r) => setPoints(r.points))
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [givenPoints, target.id]);

  useEffect(() => {
    if (!points || fileName) return;
    const first = points[0];
    if (first) {
      setFileName(first.fileName);
      setSource(first.local ? "local" : "remote");
    }
  }, [points, fileName]);

  /** Próximo passo do acompanhamento do painel depois de um erro ao consultar. */
  const afterError = (err: unknown, current: PanelWatch): PanelWatch => {
    const status = err instanceof ApiRequestError ? err.status : 0;
    const fell = current.phase === "down";
    if (status === 404) return { phase: "relogin" };
    if (status === 401) return fell ? { phase: "relogin" } : { phase: "expired" };
    const since = current.phase === "waiting" || current.phase === "down" ? current.since : Date.now();
    const downSince = current.phase === "down" ? current.downSince : Date.now();
    if (Date.now() - downSince >= restartTimeoutMs) return { phase: "timeout", neverRestarted: false };
    return { phase: "down", since, downSince };
  };

  // Acompanha a restauração até terminar.
  useEffect(() => {
    if (!record || watch || lost) return;
    if (isFinal(record)) {
      if (!finished.current) {
        finished.current = true;
        onFinished?.(record);
      }
      // Painel: "vai reiniciar" ainda não é o fim — acompanha o reinício.
      if (target.kind === "panel" && record.status === "warning") setWatch({ phase: "waiting", since: Date.now() });
      return;
    }
    const t = setTimeout(() => {
      apiFetch<BackupRecord>(`/api/backups/records/${record.id}`, { onUnauthorized: "ignore" })
        .then((r) => {
          pollErrors.current = 0;
          setRecord(r);
        })
        .catch((err: unknown) => {
          if (target.kind === "panel") {
            setWatch(afterError(err, { phase: "waiting", since: Date.now() }));
            return;
          }
          pollErrors.current++;
          if (pollErrors.current >= MAX_POLL_ERRORS) setLost(true);
          else setRecord({ ...record });
        });
    }, pollMs);
    return () => clearTimeout(t);
    // afterError só depende de restartTimeoutMs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, watch, lost, onFinished, pollMs, target.kind]);

  // Painel: acompanha o reinício até ele voltar (ou desistir).
  useEffect(() => {
    if (!record || !watch || (watch.phase !== "waiting" && watch.phase !== "down")) return;
    const t = setTimeout(() => {
      apiFetch<BackupRecord>(`/api/backups/records/${record.id}`, { onUnauthorized: "ignore" })
        .then(async (r) => {
          if (watch.phase === "waiting") {
            // ainda não reiniciou: segue esperando até o prazo (ou volta ao acompanhamento normal)
            setRecord(r);
            if (r.status !== "warning") setWatch(null);
            else if (Date.now() - watch.since >= restartTimeoutMs) setWatch({ phase: "timeout", neverRestarted: true });
            else setWatch({ ...watch });
            return;
          }
          // voltou e a sessão ainda vale: o histórico diz como terminou a troca
          setRecord(r);
          setWatch(await bootOutcome(record));
        })
        .catch((err: unknown) => setWatch(afterError(err, watch)));
    }, pollMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, watch, pollMs]);

  const chosen = points?.find((p) => p.fileName === fileName) ?? null;
  const word = confirmWord(target);
  const serverWord = serverConfirmWord(target);
  const typed = lowerCase(confirm.trim());
  // vale a palavra do idioma atual e a que o servidor espera (português)
  const confirmed = typed === lowerCase(word) || typed === lowerCase(serverWord);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // o servidor só conhece a palavra em português: noutro idioma, vai a dele
      const sentConfirm = typed === lowerCase(serverWord) ? confirm.trim() : serverWord;
      const body: Record<string, unknown> = { fileName, source, confirm: sentConfirm };
      if (allowRedeploy && redeploy) body.redeploy = true;
      if (oldPassword) body.password = oldPassword;
      setRecord(await apiFetch<BackupRecord>(`/api/backups/targets/${target.id}/restore`, { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const done = record && isFinal(record);
  const watching = watch !== null && (watch.phase === "waiting" || watch.phase === "down");
  const concluded = watch !== null && !watching;
  // O registro de antes do reinício não sabe como a troca terminou: o acompanhamento sabe.
  const shown: BackupRecord | null =
    record && watch?.phase === "undone"
      ? { ...record, status: "failed" }
      : record && watch && (watch.phase === "relogin" || watch.phase === "success")
        ? { ...record, status: "success" }
        : record;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("backups.restore.title", { name: target.name })}
        data-testid="restore-dialog"
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <RotateCcw className="h-5 w-5" /> {t("backups.restore.title", { name: target.name })}
        </h2>

        {!record && (
          <>
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t(RESTORE_WARNING[target.kind])}
            </p>
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {!points && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {points && points.length === 0 && <p className="text-sm text-muted-foreground">{t("backups.restore.noBackups")}</p>}
            {points && points.length > 0 && (
              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="mb-1 font-medium">{t("backups.restore.chooseDate")}</legend>
                {points.map((p) => (
                  <label key={p.fileName} className="flex items-center gap-2 rounded-md border border-border p-2">
                    <input
                      type="radio"
                      name="restore-point"
                      className="accent-sky-600"
                      checked={fileName === p.fileName}
                      onChange={() => {
                        setFileName(p.fileName);
                        setSource(p.local ? "local" : "remote");
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      {when(p.at)} <span className="text-muted-foreground">· {formatBytes(p.sizeBytes)}</span>
                    </span>
                    {p.local && <Badge variant="secondary">{t("backups.restore.badgeVps")}</Badge>}
                    {p.remote && <Badge variant="secondary">{t("backups.restore.badgeExternal")}</Badge>}
                  </label>
                ))}
              </fieldset>
            )}
            {chosen && chosen.local && chosen.remote && (
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-muted-foreground">{t("backups.restore.useCopy")}</span>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="restore-source" className="accent-sky-600" checked={source === "local"} onChange={() => setSource("local")} />{" "}
                  {t("backups.restore.fromVps")}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="restore-source" className="accent-sky-600" checked={source === "remote"} onChange={() => setSource("remote")} />{" "}
                  {t("backups.restore.fromExternal")}
                </label>
              </div>
            )}
            {allowRedeploy && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-sky-600" checked={redeploy} onChange={(e) => setRedeploy(e.target.checked)} />
                <span>
                  {t("backups.restore.redeploy")}
                  <span className="block text-muted-foreground">{t("backups.restore.redeployHint")}</span>
                </span>
              </label>
            )}
            {source === "remote" && (
              <div className="text-sm">
                {!showOld ? (
                  <button type="button" className="text-sky-400 underline underline-offset-2" onClick={() => setShowOld(true)}>
                    {t("backups.restore.beforePasswordChange")}
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="restore-old-pw" className="font-medium">
                      {t("backups.restore.oldPassword")}
                    </label>
                    <PasswordInput id="restore-old-pw" autoComplete="off" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1.5 text-sm">
              <label htmlFor="restore-confirm" className="font-medium">
                <Trans k="backups.restore.confirmLabel" params={{ word }} components={{ b: <strong /> }} />
              </label>
              <Input id="restore-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Feedback error={error} notice={null} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t("backups.action.cancel")}
              </Button>
              <Button variant="danger" onClick={() => void submit()} disabled={!chosen || !confirmed || busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.action.restore")}
              </Button>
            </div>
          </>
        )}

        {record && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <RecordBadge record={shown ?? record} />
              <span className="text-muted-foreground">{record.fileName}</span>
            </div>
            <StepList record={record} />
            {record.error && <p className="text-sm text-destructive">{record.error}</p>}
            {record.warnings.map((w, i) => (
              <p key={i} className="text-sm text-amber-400">
                {w}
              </p>
            ))}
            {watch?.phase === "waiting" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="panel-restart">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("backups.restore.watch.waiting")}
              </p>
            )}
            {watch?.phase === "down" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="panel-restart">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("backups.restore.watch.down")}
              </p>
            )}
            {watch?.phase === "relogin" && (
              <p className="text-sm text-emerald-400" data-testid="panel-restart">
                {t("backups.restore.watch.relogin")}
              </p>
            )}
            {watch?.phase === "success" && (
              <p className="text-sm text-emerald-400" data-testid="panel-restart">
                {t("backups.restore.watch.success")}
              </p>
            )}
            {watch?.phase === "undone" && (
              <p className="text-sm text-destructive" data-testid="panel-restart">
                {t("backups.restore.watch.undone")}
                {watch.error ? ` ${t("backups.restore.watch.undoneReason", { reason: watch.error })}` : ""}
              </p>
            )}
            {watch?.phase === "back" && (
              <p className="text-sm text-amber-400" data-testid="panel-restart">
                {t("backups.restore.watch.back")}
              </p>
            )}
            {watch?.phase === "expired" && (
              <p className="text-sm text-amber-400" data-testid="panel-restart">
                {t("backups.restore.watch.expired")}
              </p>
            )}
            {watch?.phase === "timeout" && (
              <p className="text-sm text-destructive" data-testid="panel-restart">
                {t(watch.neverRestarted ? "backups.restore.watch.neverRestarted" : "backups.restore.watch.didNotReturn", {
                  minutes: Math.max(1, Math.round(restartTimeoutMs / 60_000)),
                  count: Math.max(1, Math.round(restartTimeoutMs / 60_000)),
                })}
              </p>
            )}
            {lost && <p className="text-sm text-amber-400">{t("backups.restore.lost")}</p>}
            {!done && !watch && !lost && <p className="text-xs text-muted-foreground">{t("backups.restore.canClose")}</p>}
            <div className="flex justify-end gap-2">
              {target.kind === "panel" && (concluded || (done && record.status !== "failed")) && (
                <Button onClick={() => window.location.reload()}>{t("backups.restore.reload")}</Button>
              )}
              <Button variant="outline" onClick={onClose}>
                {t("backups.action.close")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Senha dos backups (criar ou trocar)
// ---------------------------------------------------------------------------

const STRENGTH_COLOR = ["bg-red-500", "bg-red-500", "bg-amber-500", "bg-sky-500", "bg-emerald-500"];

/** O rótulo vem do @paas/core em português; a chave de cada um decide o texto na interface. */
const STRENGTH_LABEL: Record<ReturnType<typeof backupPasswordStrength>["label"], Key> = {
  "Curta demais": "backups.password.strength.tooShort",
  Fraca: "backups.password.strength.weak",
  Razoável: "backups.password.strength.fair",
  Boa: "backups.password.strength.good",
  Forte: "backups.password.strength.strong",
};

export function PasswordSetup({
  status,
  changing,
  onSaved,
  onCancel,
}: {
  status: BackupsStatus;
  changing: boolean;
  onSaved: (s: BackupsStatus) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [ack, setAck] = useState(false);
  const [kitDone, setKitDone] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const strength = backupPasswordStrength(password);

  async function suggest() {
    setBusy("suggest");
    setError(null);
    try {
      const r = await apiFetch<{ password: string }>("/api/backups/password/suggest");
      setPassword(r.password);
      setVisible(true);
      setKitDone(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      onSaved(await apiFetch<BackupsStatus>("/api/backups/password", { method: "PUT", body: JSON.stringify({ password, acknowledged: ack }) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="password-setup" className="flex flex-col gap-3 rounded-lg border-2 border-amber-500/60 bg-amber-500/5 p-4 text-sm">
      <p className="flex items-start gap-2 text-base font-semibold text-amber-300">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        {t("backups.password.warning")}
      </p>
      <p className="text-muted-foreground">{t("backups.password.explain")}</p>
      {changing && <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-sky-200">{t("backups.password.changing")}</p>}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="bk-password" className="font-medium">
          {t(changing ? "backups.password.labelNew" : "backups.password.labelDefault", { min: MIN_BACKUP_PASSWORD_LENGTH })}
        </label>
        <div className="flex flex-col gap-2">
          <PasswordInput
            id="bk-password"
            autoComplete="new-password"
            value={password}
            visible={visible}
            onVisibleChange={setVisible}
            onChange={(e) => {
              setPassword(e.target.value);
              setKitDone(false);
            }}
            className="font-mono"
          />
          <Button type="button" variant="outline" className="self-start" onClick={() => void suggest()} disabled={busy !== null}>
            {busy === "suggest" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {t("backups.password.suggest")}
          </Button>
        </div>
        {password && (
          <div className="flex items-center gap-2" data-testid="password-strength">
            <div className="flex h-1.5 w-32 overflow-hidden rounded bg-muted">
              <div className={cn("h-full", STRENGTH_COLOR[strength.score])} style={{ width: `${(strength.score / 4) * 100}%` }} />
            </div>
            <span className={strength.ok ? "text-emerald-400" : "text-amber-400"}>{t(STRENGTH_LABEL[strength.label])}</span>
          </div>
        )}
      </div>
      <div>
        <Button
          type="button"
          variant="info"
          disabled={!strength.ok}
          onClick={() => {
            downloadRecoveryKit(password, status);
            setKitDone(true);
          }}
        >
          <Download className="h-4 w-4" /> {t("backups.password.downloadKit")}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("backups.password.kitHelp")}
          {kitDone && <span className="text-emerald-400"> {t("backups.password.kitDone")}</span>}
        </p>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-sky-600" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span className="font-medium">{t("backups.password.ack")}</span>
      </label>
      <Feedback error={error} notice={null} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={!strength.ok || !ack || busy !== null}>
          {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} {t(changing ? "backups.password.change" : "backups.password.activate")}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            {t("backups.action.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
