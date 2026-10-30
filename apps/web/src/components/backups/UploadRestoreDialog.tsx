import { useEffect, useRef, useState } from "react";
import {
  BACKUP_ENGINE_LABELS,
  UPLOAD_RESTORE_ACCEPT,
  type UploadRestoreBackupChoice,
  type UploadRestoreCheckResponse,
  type UploadRestoreFormat,
  type UploadRestoreJob,
  type UploadRestoreOptions,
  type UploadRestoreUploaded,
} from "@paas/core";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";
import { CopyButton } from "@/components/mail/CopyButton";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PasswordInput } from "@/components/ui/password-input";
import { errorText, formatBytes } from "@/components/backups/backup-ui";
import { useI18n, type Key } from "@/i18n";
import { apiFetch } from "@/lib/api";
import { PRECHECK_BYTES, UploadAborted, percentOf, putRaw, readHead, type UploadHandle } from "@/lib/upload-restore";
import { AlertTriangle, CheckCircle2, Loader2, Upload, XCircle } from "lucide-react";

const FORMAT_KEYS = {
  pg_custom: "backups.uploadRestore.format.pg_custom",
  sql: "backups.uploadRestore.format.sql",
  mongo_archive: "backups.uploadRestore.format.mongo_archive",
  panel_backup: "backups.uploadRestore.format.panel_backup",
} as const satisfies Record<UploadRestoreFormat, Key>;

const STATUS_KEYS = {
  validating: "backups.uploadRestore.status.validating",
  waiting_backup: "backups.uploadRestore.status.waiting_backup",
  restoring: "backups.uploadRestore.status.restoring",
  success: "backups.uploadRestore.status.success",
  failed: "backups.uploadRestore.status.failed",
} as const satisfies Record<UploadRestoreJob["status"], Key>;

type Phase = "form" | "uploading" | "validating" | "ready" | "running";

/** Quantas consultas seguidas ao trabalho podem falhar antes de desistir de acompanhar. */
const MAX_POLL_ERRORS = 30;

/**
 * Aba Backups do projeto → "Restaurar de um arquivo": escolhe o banco, envia o dump (com progresso e cancelar),
 * confere o formato, pede o nome do projeto, o backup antes e a senha + código, e acompanha a restauração.
 * O envio é só um arquivo parado no servidor; a reautenticação vale ao começar a restaurar.
 */
export function UploadRestoreDialog({
  projectId,
  projectName,
  onClose,
  onFinished,
  pollMs = 2000,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onFinished?: (job: UploadRestoreJob) => void;
  /** Intervalo do acompanhamento (testes usam um curto). */
  pollMs?: number;
}) {
  const { t } = useI18n();
  const base = `/api/backups/projects/${projectId}/upload-restore`;
  const [options, setOptions] = useState<UploadRestoreOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [database, setDatabase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [uploaded, setUploaded] = useState<UploadRestoreUploaded | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [panelNote, setPanelNote] = useState<string | null>(null);
  const [clean, setClean] = useState(false);
  const [backup, setBackup] = useState<UploadRestoreBackupChoice>("full");
  const [confirm, setConfirm] = useState("");
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [job, setJob] = useState<UploadRestoreJob | null>(null);
  const [lost, setLost] = useState(false);
  const handle = useRef<UploadHandle<UploadRestoreUploaded> | null>(null);
  const pollErrors = useRef(0);
  const finished = useRef(false);

  useEffect(() => {
    apiFetch<UploadRestoreOptions>(base)
      .then((o) => {
        setOptions(o);
        setBackup(o.development ? "none" : "full");
        const first = o.services[0];
        if (first) {
          setService(first.service);
          setDatabase(first.defaultDatabase ?? first.databases[0] ?? "");
        }
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [base]);

  // Fechar com um envio em andamento cancela o envio (o servidor apaga o que recebeu).
  useEffect(() => () => handle.current?.abort(), []);

  const target = options?.services.find((s) => s.service === service) ?? null;
  const family = target?.engine === "mariadb" ? "mysql" : target?.engine;
  const needsDatabase = family === "postgres" || family === "mysql";
  const sql = uploaded?.format === "sql";
  const cleanApplies = uploaded?.format === "pg_custom" || target?.engine === "mongo";
  const formatText = (format: UploadRestoreFormat, gzip: boolean) =>
    gzip ? t("backups.uploadRestore.format.gzip", { format: t(FORMAT_KEYS[format]) }) : t(FORMAT_KEYS[format]);

  function pickService(next: string) {
    const s = options?.services.find((x) => x.service === next);
    setService(next);
    setDatabase(s?.defaultDatabase ?? s?.databases[0] ?? "");
    setFile(null);
    setFileNote(null);
    setFileError(null);
  }

  async function pickFile(chosen: File | null) {
    setFile(null);
    setFileNote(null);
    setFileError(null);
    if (!chosen || !options) return;
    if (/\.zip$/i.test(chosen.name)) return setFileError(t("backups.uploadRestore.error.zip"));
    if (chosen.size > options.maxBytes) {
      return setFileError(t("backups.uploadRestore.error.tooBig", { size: formatBytes(chosen.size), max: formatBytes(options.maxBytes) }));
    }
    setChecking(true);
    try {
      const head = await readHead(chosen, PRECHECK_BYTES);
      const q = new URLSearchParams({ service, name: chosen.name });
      const r = await apiFetch<{ format: UploadRestoreFormat; gzip: boolean }>(`${base}/precheck?${q.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: head,
      });
      setFile(chosen);
      setFileNote(t("backups.uploadRestore.fileOk", { format: formatText(r.format, r.gzip) }));
    } catch (err) {
      setFileError(errorText(err));
    } finally {
      setChecking(false);
    }
  }

  async function upload() {
    if (!file) return;
    setError(null);
    setNotice(null);
    setProgress({ loaded: 0, total: file.size });
    setPhase("uploading");
    const q = new URLSearchParams({ service, name: file.name });
    const h = putRaw<UploadRestoreUploaded>(`${base}/files?${q.toString()}`, file, (loaded, total) => {
      setProgress({ loaded, total });
      if (loaded >= total) setPhase("validating");
    });
    handle.current = h;
    try {
      const done = await h.promise;
      setUploaded(done);
      setPhase("ready");
    } catch (err) {
      setPhase("form");
      if (err instanceof UploadAborted) setNotice(t("backups.uploadRestore.upload.cancelled"));
      else setError(errorText(err));
    } finally {
      handle.current = null;
    }
  }

  async function checkPanelBackup() {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    setPanelNote(null);
    try {
      const r = await apiFetch<UploadRestoreCheckResponse>(`${base}/files/${uploaded.uploadId}/check`, {
        method: "POST",
        body: JSON.stringify({ service, ...(needsDatabase && database ? { database } : {}), password: backupPassword || undefined }),
      });
      setUploaded({ ...uploaded, needsPassword: false });
      setPanelNote(r.databases.length > 0 ? t("backups.uploadRestore.panelPassword.ok", { databases: r.databases.join(", ") }) : t("backups.uploadRestore.panelPassword.okNoList"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (uploaded) await apiFetch(`${base}/files/${uploaded.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  }

  async function start() {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    try {
      const started = await apiFetch<UploadRestoreJob>(base, {
        method: "POST",
        body: JSON.stringify({
          uploadId: uploaded.uploadId,
          service,
          ...(needsDatabase && database ? { database } : {}),
          clean: cleanApplies && clean,
          backup,
          confirm,
          ...(backupPassword ? { backupPassword } : {}),
          ...reauthPayload(reauth),
        }),
      });
      setJob(started);
      setPhase("running");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // Acompanha a restauração até terminar.
  useEffect(() => {
    if (!job || lost) return;
    if (job.status === "success" || job.status === "failed") {
      if (!finished.current) {
        finished.current = true;
        onFinished?.(job);
      }
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<UploadRestoreJob>(`${base}/jobs/${job.id}`, { onUnauthorized: "ignore" })
        .then((j) => {
          pollErrors.current = 0;
          setJob(j);
        })
        .catch(() => {
          pollErrors.current++;
          if (pollErrors.current >= MAX_POLL_ERRORS) setLost(true);
          else setJob({ ...job });
        });
    }, pollMs);
    return () => clearTimeout(timer);
  }, [job, lost, base, pollMs, onFinished]);

  const done = job !== null && (job.status === "success" || job.status === "failed");
  const running = phase === "running" && !done && !lost;
  const wordOk = confirm.trim().toLowerCase() === projectName.trim().toLowerCase();
  const reauthOk = reauth.password.length > 0 && reauth.code.trim().length > 0;
  const canStart = phase === "ready" && uploaded !== null && !uploaded.needsPassword && wordOk && reauthOk && !busy && (!needsDatabase || database.length > 0 || family === "mysql");
  const percent = percentOf(progress.loaded, progress.total);

  const footer = (() => {
    if (job || lost) {
      return (
        <div className="flex justify-end">
          <Button data-testid="upload-close" onClick={onClose} disabled={running}>
            {t("backups.uploadRestore.close")}
          </Button>
        </div>
      );
    }
    if (phase === "uploading" || phase === "validating") {
      return (
        <div className="flex justify-end">
          <Button variant="outline" data-testid="upload-cancel" disabled={phase === "validating"} onClick={() => handle.current?.abort()}>
            {t("backups.uploadRestore.upload.cancel")}
          </Button>
        </div>
      );
    }
    if (phase === "ready") {
      return (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" data-testid="upload-discard" onClick={() => void discard()} disabled={busy}>
            {t("backups.uploadRestore.discard")}
          </Button>
          <Button variant="destructive" data-testid="upload-start" onClick={() => void start()} disabled={!canStart}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {busy ? t("backups.uploadRestore.starting") : t("backups.uploadRestore.start")}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("backups.action.cancel")}
        </Button>
        <Button onClick={() => void upload()} disabled={!file || checking || !target?.running || options?.busy === true}>
          <Upload className="h-4 w-4" /> {t("backups.uploadRestore.upload.start")}
        </Button>
      </div>
    );
  })();

  return (
    <Modal
      title={t("backups.uploadRestore.title", { name: projectName })}
      onClose={() => (phase === "ready" ? void discard() : onClose())}
      busy={phase === "uploading" || phase === "validating" || running || busy}
      footer={footer}
    >
      <div data-testid="upload-restore-dialog" className="flex flex-col gap-4 text-sm">
        {phase === "form" && (
          <>
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t("backups.uploadRestore.intro")}
            </p>
            {loadError && <p className="text-destructive">{loadError}</p>}
            {!options && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {options && options.services.length === 0 && <p className="text-muted-foreground">{t("backups.uploadRestore.noDatabase")}</p>}
            {options?.busy && <p className="text-amber-300">{t("backups.uploadRestore.busy")}</p>}
            {options && options.services.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">{t("backups.uploadRestore.formats")}</p>
                <p className="text-xs text-muted-foreground">
                  {options.freeBytes === null
                    ? t("backups.uploadRestore.limitsNoFree", { max: formatBytes(options.maxBytes) })
                    : t("backups.uploadRestore.limits", { max: formatBytes(options.maxBytes), free: formatBytes(options.freeBytes) })}
                </p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="ur-service" className="font-medium">
                    {t("backups.uploadRestore.service")}
                  </label>
                  <select
                    id="ur-service"
                    className="h-9 rounded-md border border-input bg-background px-2"
                    value={service}
                    onChange={(e) => pickService(e.target.value)}
                  >
                    {options.services.map((s) => (
                      <option key={s.service} value={s.service}>
                        {s.service} ({BACKUP_ENGINE_LABELS[s.engine]})
                      </option>
                    ))}
                  </select>
                  {target && !target.running && <p className="text-amber-300">{t("backups.uploadRestore.serviceStopped", { service: target.service })}</p>}
                </div>
                {needsDatabase && target && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ur-database" className="font-medium">
                      {t("backups.uploadRestore.database")}
                    </label>
                    {target.databases.length > 0 ? (
                      <select id="ur-database" className="h-9 rounded-md border border-input bg-background px-2" value={database} onChange={(e) => setDatabase(e.target.value)}>
                        {target.databases.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input id="ur-database" value={database} onChange={(e) => setDatabase(e.target.value)} autoComplete="off" spellCheck={false} />
                    )}
                    <p className="text-xs text-muted-foreground">{t("backups.uploadRestore.databaseHint")}</p>
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="ur-file" className="font-medium">
                    {t("backups.uploadRestore.file")}
                  </label>
                  <input
                    id="ur-file"
                    type="file"
                    accept={UPLOAD_RESTORE_ACCEPT}
                    className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5"
                    onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
                  />
                  {checking && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> {t("backups.uploadRestore.checking")}
                    </p>
                  )}
                  {fileNote && (
                    <p role="status" className="text-emerald-400">
                      {fileNote}
                    </p>
                  )}
                  {fileError && (
                    <p role="alert" className="text-destructive">
                      {fileError}
                    </p>
                  )}
                </div>
              </>
            )}
            {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
          </>
        )}

        {(phase === "uploading" || phase === "validating") && (
          <div className="flex flex-col gap-2" data-testid="upload-progress">
            <p className="flex items-center gap-2 font-medium">
              <Loader2 className="h-4 w-4 animate-spin" />
              {phase === "uploading" ? t("backups.uploadRestore.upload.uploading", { percent }) : t("backups.uploadRestore.upload.validating")}
            </p>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{t("backups.uploadRestore.upload.progress", { loaded: formatBytes(progress.loaded), total: formatBytes(progress.total) })}</p>
          </div>
        )}

        {phase === "ready" && uploaded && !job && (
          <>
            <p data-testid="upload-ready" className="flex items-center gap-2 font-medium text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> {t("backups.uploadRestore.ready.title")}
              <span className="font-normal text-muted-foreground">
                {t("backups.uploadRestore.ready.summary", { format: formatText(uploaded.format, uploaded.gzip), size: formatBytes(uploaded.sizeBytes) })}
              </span>
            </p>
            {(uploaded.needsPassword || panelNote) && uploaded.format === "panel_backup" && (
              <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="upload-panel-password">
                {uploaded.needsPassword && <p className="text-muted-foreground">{t("backups.uploadRestore.panelPassword.hint")}</p>}
                {uploaded.needsPassword && (
                  <>
                    <label htmlFor="ur-backup-password" className="font-medium">
                      {t("backups.uploadRestore.panelPassword.label")}
                    </label>
                    <PasswordInput id="ur-backup-password" autoComplete="off" value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} />
                    <div>
                      <Button variant="outline" data-testid="upload-panel-check" onClick={() => void checkPanelBackup()} disabled={busy || backupPassword.length === 0}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.uploadRestore.panelPassword.check")}
                      </Button>
                    </div>
                  </>
                )}
                {panelNote && <p role="status" className="text-emerald-400">{panelNote}</p>}
              </div>
            )}
            {cleanApplies ? (
              <label className="flex items-start gap-2">
                <input type="checkbox" data-testid="upload-clean" className="mt-1 h-4 w-4 accent-sky-600" checked={clean} onChange={(e) => setClean(e.target.checked)} />
                <span>
                  <span className="font-medium">{t("backups.uploadRestore.clean.label")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(target?.engine === "mongo" ? "backups.uploadRestore.clean.hint.mongo" : "backups.uploadRestore.clean.hint.pg_custom")}
                  </span>
                </span>
              </label>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="upload-clean-note">
                {sql || uploaded.format === "panel_backup" ? t("backups.uploadRestore.clean.sqlNote") : null}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium">{t("backups.uploadRestore.backup.legend")}</legend>
              <label className="flex items-start gap-2 rounded-md border p-2">
                <input type="radio" data-testid="upload-backup-none" name="ur-backup" className="mt-1 accent-sky-600" checked={backup === "none"} onChange={() => setBackup("none")} />
                <span>
                  <span className="font-medium">{t("backups.uploadRestore.backup.none")}</span>
                  <span className="block text-xs text-muted-foreground">{t("backups.uploadRestore.backup.noneHint")}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border p-2">
                <input type="radio" name="ur-backup" className="mt-1 accent-sky-600" checked={backup === "full"} onChange={() => setBackup("full")} />
                <span>
                  <span className="font-medium">{t("backups.uploadRestore.backup.full")}</span>
                  <span className="block text-xs text-muted-foreground">{t("backups.uploadRestore.backup.fullHint")}</span>
                </span>
              </label>
              {options?.development && <p className="text-xs text-muted-foreground">{t("backups.uploadRestore.backup.devDefault")}</p>}
            </fieldset>
            <ConfirmWordInput
              id="ur-confirm"
              word={projectName}
              value={confirm}
              onChange={setConfirm}
              labelKey="backups.uploadRestore.confirm.label"
              hintKey="backups.uploadRestore.confirm.hint"
            />
            <p className="text-xs text-muted-foreground">{t("backups.uploadRestore.reauth.hint")}</p>
            <ReauthFields idPrefix="ur" action="backups.upload-restore" value={reauth} onChange={setReauth} />
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
          </>
        )}

        {(job || lost) && (
          <div className="flex flex-col gap-3" data-testid="upload-job">
            {job && (
              <p
                role="status"
                className={
                  job.status === "failed"
                    ? "flex items-start gap-2 font-medium text-destructive"
                    : job.status === "success"
                      ? "flex items-start gap-2 font-medium text-emerald-400"
                      : "flex items-start gap-2 font-medium"
                }
              >
                {job.status === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : job.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />}
                {t(STATUS_KEYS[job.status])}
              </p>
            )}
            {job?.backupFileName && <p className="text-muted-foreground">{t("backups.uploadRestore.job.backupFile", { file: job.backupFileName })}</p>}
            {job?.error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">{job.error.message}</p>}
            {lost && <p role="alert" data-testid="upload-lost" className="text-amber-300">{t("backups.uploadRestore.job.lost")}</p>}
            {job?.output && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t("backups.uploadRestore.job.output")}</span>
                  <CopyButton text={job.output} label={t("backups.uploadRestore.job.copy")} />
                </div>
                <pre data-testid="upload-output" className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-black/60 p-2 font-mono text-xs">
                  {job.output}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
