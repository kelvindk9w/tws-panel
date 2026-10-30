import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { DatabaseBackupChoice, DatabaseJob, DatabaseJobStarted } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { dbErrorText, jobErrorText } from "@/lib/database";
import { useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";
import { CopyButton } from "@/components/mail/CopyButton";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { DatabaseResultTable } from "@/components/project/DatabaseResultTable";

const STEP_KEYS = { backup: "database.action.step.backup", action: "database.action.step.action" } as const satisfies Record<string, Key>;
const STEP_STATUS_KEYS = {
  pending: "database.action.stepStatus.pending",
  running: "database.action.stepStatus.running",
  done: "database.action.stepStatus.done",
  failed: "database.action.stepStatus.failed",
  skipped: "database.action.stepStatus.skipped",
} as const satisfies Record<DatabaseJob["steps"][number]["status"], Key>;

export interface DatabaseActionSpec {
  kind: "truncate" | "reset" | "sql" | "command";
  /** Final da rota: `truncate`, `reset`, `sql/write` ou `command`. */
  path: "truncate" | "reset" | "sql/write" | "command";
  /** Campos específicos da ação (tabelas, SQL, comando). */
  payload: Record<string, unknown>;
  /** Texto do que vai acontecer (já traduzido). */
  description: ReactNode;
  /** Mostra o comando/SQL que vai rodar, com a fonte de código. */
  preview?: string;
  /** Aviso extra em destaque (ex.: CASCADE). */
  warning?: string;
}

/**
 * Diálogo das ações que alteram dados do banco: escolha do backup, senha + código do app (+ e-mail se ligado), nome
 * do projeto digitado e, depois de enviado, o andamento do trabalho (backup e ação) até o fim, com a saída e o
 * resultado. O servidor repete todas as conferências; aqui só se impede o envio incompleto.
 */
export function DatabaseActionDialog({
  projectId,
  projectName,
  development,
  action,
  onClose,
  onFinished,
  pollMs = 1500,
}: {
  projectId: string;
  projectName: string;
  development: boolean;
  action: DatabaseActionSpec;
  onClose: () => void;
  /** Chamado quando o trabalho termina (ok ou não), para a tela recarregar. */
  onFinished: () => void;
  pollMs?: number;
}) {
  const { t } = useI18n();
  const [backup, setBackup] = useState<DatabaseBackupChoice>(development ? "none" : "full");
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<DatabaseJob | null>(null);
  const [alertWarning, setAlertWarning] = useState<string | null>(null);
  const [pollProblem, setPollProblem] = useState(false);
  // O painel reiniciou e a lista de trabalhos foi zerada (404): para de consultar e avisa
  const [jobGone, setJobGone] = useState(false);
  // Comando do framework com mais de um container com artisan: a pessoa escolhe onde rodar
  const [services, setServices] = useState<{ list: string[]; suggested: string | null } | null>(null);
  const [service, setService] = useState("");
  const finishedRef = useRef(false);

  const running = job?.status === "running" && !jobGone;
  const title = t(`database.action.title.${action.kind}` as Key);

  useEffect(() => {
    if (!job || job.status !== "running" || jobGone) return;
    let alive = true;
    const timer = setTimeout(() => {
      apiFetch<DatabaseJob>(`/api/projects/${projectId}/database/jobs/${job.id}`)
        .then((next) => {
          if (!alive) return;
          setPollProblem(false);
          setJob(next);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (err instanceof ApiRequestError && err.code === "job_not_found") {
            setJobGone(true);
            return;
          }
          setPollProblem(true);
          // continua tentando: o efeito roda de novo quando o estado muda
          setJob((cur) => (cur ? { ...cur } : cur));
        });
    }, pollMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job, jobGone, projectId, pollMs]);

  useEffect(() => {
    if (job && (job.status !== "running" || jobGone) && !finishedRef.current) {
      finishedRef.current = true;
      onFinished();
    }
  }, [job, jobGone, onFinished]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<DatabaseJobStarted>(`/api/projects/${projectId}/database/${action.path}`, {
        method: "POST",
        body: JSON.stringify({ ...action.payload, ...(service ? { service } : {}), ...reauthPayload(reauth), confirm, backup }),
      });
      setAlertWarning(res.alertWarning ?? null);
      setJob(res.job);
    } catch (err) {
      const data = err instanceof ApiRequestError && err.code === "app_ambiguous" ? err.data : undefined;
      const list = data?.services;
      if (Array.isArray(list) && list.every((x) => typeof x === "string") && list.length > 0) {
        const suggested = typeof data?.suggested === "string" ? data.suggested : null;
        setServices({ list: list as string[], suggested });
        setService(suggested ?? (list as string[])[0]!);
      }
      setError(dbErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !busy && reauth.password.length > 0 && reauth.code.trim().length > 0 && confirm === projectName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="database-action-dialog"
        className="flex max-h-[95vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl border border-red-500/40 bg-background p-6 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold text-red-300">
          <AlertTriangle className="h-5 w-5" /> {title}
        </h2>

        {!job && (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="text-sm text-muted-foreground">{action.description}</div>
            {action.preview && (
              <pre data-testid="database-action-preview" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 font-mono text-xs">
                {action.preview}
              </pre>
            )}
            {action.warning && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                {action.warning}
              </p>
            )}
            <p className="text-sm font-medium text-red-300">{t("database.action.irreversible")}</p>

            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1 font-medium">{t("database.action.backup.title")}</legend>
              {(["none", "full"] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-2">
                  <input type="radio" name="db-backup" value={choice} checked={backup === choice} onChange={() => setBackup(choice)} className="h-4 w-4" />
                  {t(choice === "none" ? "database.action.backup.none" : "database.action.backup.full")}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">{t("database.action.backup.hint")}</p>
              {development && <p className="text-xs text-muted-foreground">{t("database.action.backup.devDefault")}</p>}
            </fieldset>

            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-sm font-medium">{t("database.action.reauth.title")}</p>
              <p className="text-xs text-muted-foreground">{t("database.action.reauth.hint")}</p>
              <ReauthFields idPrefix="dbact" action="database.write" value={reauth} onChange={setReauth} />
            </div>

            {services && (
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="db-service" className="font-medium">{t("database.action.service.label")}</label>
                <select id="db-service" value={service} onChange={(e) => setService(e.target.value)} className="h-9 rounded-md border bg-background px-2">
                  {services.list.map((name) => (
                    <option key={name} value={name}>
                      {name === services.suggested ? t("database.action.service.suggested", { service: name }) : name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">{t("database.action.service.hint")}</p>
              </div>
            )}

            <ConfirmWordInput
              id="db-confirm"
              word={projectName}
              value={confirm}
              onChange={setConfirm}
              labelKey="database.action.confirm.label"
              hintKey="database.action.confirm.hint"
            />

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t("database.action.cancel")}
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={!canSubmit}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("database.action.submit")}
              </Button>
            </div>
          </form>
        )}

        {job && (
          <div className="flex flex-col gap-3 text-sm" data-testid="database-job">
            {alertWarning && (
              <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300">
                {t("database.action.alertWarning", { message: alertWarning })}
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {job.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2" data-testid={`database-step-${step.id}`}>
                  {step.status === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : step.status === "done" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : step.status === "failed" ? (
                    <XCircle className="h-4 w-4 text-red-400" />
                  ) : (
                    <span className="inline-block h-4 w-4" />
                  )}
                  <span>{t(STEP_KEYS[step.id])}</span>
                  <span className="text-xs text-muted-foreground">{t(STEP_STATUS_KEYS[step.status])}</span>
                </li>
              ))}
            </ul>
            {job.backupFileName && <p className="text-xs text-muted-foreground">{t("database.action.backupFile", { file: job.backupFileName })}</p>}
            {job.backupValidation && (
              <p className="text-xs text-muted-foreground" data-testid="database-validation">
                {t(job.backupValidation === "passed" ? "database.action.validation.passed" : "database.action.validation.notRun")}
              </p>
            )}
            {running && (
              <p role="status" className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("database.action.working")}
              </p>
            )}
            {pollProblem && running && <p className="text-xs text-amber-300">{t("database.action.pollError")}</p>}
            {jobGone && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300" data-testid="database-job-gone">
                {t("database.action.jobGone")}
              </p>
            )}
            {job.status === "success" && (
              <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-400">
                {t("database.action.done")}
              </p>
            )}
            {job.status === "failed" && job.error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                <strong>{t("database.action.failed")}.</strong> {jobErrorText(job.error)}
              </p>
            )}
            {job.output !== null && (
              <div className="flex flex-col gap-1" data-testid="database-output">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t("database.action.output")}</span>
                  <CopyButton text={job.output} label={t("common.copy")} />
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 font-mono text-xs">{job.output || t("database.action.noOutput")}</pre>
              </div>
            )}
            {job.result && !job.result.empty && <DatabaseResultTable result={job.result} />}
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={onClose} disabled={running}>
                {t("database.action.close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
