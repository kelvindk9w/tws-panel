import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import type { DatabaseJob, DatabaseJobStarted, DatabaseUnlockRequest } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { dbErrorText } from "@/lib/database";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { DatabaseJobRunner } from "@/components/project/DatabaseJobRunner";

/**
 * Liberar a edição do banco: a reautenticação de sempre (senha + código do app, + e-mail se ligado), feita UMA vez,
 * e a escolha de fazer o backup completo do projeto agora (marcado, exceto em projeto de desenvolvimento). Se o backup
 * falhar, a edição não é liberada.
 */
export function DatabaseUnlockDialog({
  projectId,
  development,
  onClose,
  onFinished,
  pollMs = 1500,
}: {
  projectId: string;
  development: boolean;
  onClose: () => void;
  /** O trabalho terminou (ok ou não): a tela consulta o estado da liberação. */
  onFinished: (job: DatabaseJob | null) => void;
  pollMs?: number;
}) {
  const { t } = useI18n();
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [backup, setBackup] = useState(!development);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ job: DatabaseJob; alertWarning: string | null } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: DatabaseUnlockRequest = { ...reauthPayload(reauth), backup: backup ? "full" : "none" };
      const res = await apiFetch<DatabaseJobStarted>(`/api/projects/${projectId}/database/unlock`, { method: "POST", body: JSON.stringify(body) });
      setStarted({ job: res.job, alertWarning: res.alertWarning ?? null });
    } catch (err) {
      setError(dbErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !busy && reauth.password.length > 0 && reauth.code.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("database.unlock.dialog.title")}
        data-testid="database-unlock-dialog"
        className="flex max-h-[95vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-amber-500/40 bg-background p-6 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-5 w-5" /> {t("database.unlock.dialog.title")}
        </h2>
        {!started && (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("database.unlock.dialog.desc")}</p>
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <ReauthFields idPrefix="dbunlock" action="database.write" value={reauth} onChange={setReauth} />
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} className="h-4 w-4" />
                {t("database.unlock.dialog.backup")}
              </label>
              <p className="text-xs text-muted-foreground">{t("database.unlock.dialog.backupHint")}</p>
              {development && <p className="text-xs text-muted-foreground">{t("database.unlock.dialog.backupDev")}</p>}
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t("database.action.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("database.unlock.dialog.submit")}
              </Button>
            </div>
          </form>
        )}
        {started && (
          <DatabaseJobRunner
            projectId={projectId}
            initial={started.job}
            alertWarning={started.alertWarning}
            pollMs={pollMs}
            onClose={onClose}
            onFinished={onFinished}
          />
        )}
      </div>
    </div>
  );
}
