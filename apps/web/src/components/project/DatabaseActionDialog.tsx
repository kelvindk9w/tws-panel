import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { DatabaseBackupChoice, DatabaseJob, DatabaseJobStarted } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { dbErrorText } from "@/lib/database";
import { useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";
import { DatabaseJobRunner } from "@/components/project/DatabaseJobRunner";

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
  /** Pergunta sobre o backup antes (padrão: esvaziar e zerar). */
  askBackup?: boolean;
  /** Pede o nome do projeto digitado (padrão: zerar; também o comando que apaga tudo). */
  askName?: boolean;
  /** Executa na hora, sem perguntar nada (console SQL com a edição liberada). */
  auto?: boolean;
}

/**
 * Diálogo das ações que alteram dados do banco, com a edição já liberada (a senha + 2FA foi pedida uma vez, ao
 * liberar). Só pergunta o que é leve: a escolha do backup (esvaziar e zerar) e o nome do projeto digitado (zerar e o
 * comando que apaga tudo). Depois de enviado, mostra o andamento do trabalho até o fim. O servidor repete todas as
 * conferências; aqui só se impede o envio incompleto.
 */
export function DatabaseActionDialog({
  projectId,
  projectName,
  development,
  action,
  onClose,
  onFinished,
  onLocked,
  pollMs = 1500,
}: {
  projectId: string;
  projectName: string;
  development: boolean;
  action: DatabaseActionSpec;
  onClose: () => void;
  /** Chamado quando o trabalho termina (ok ou não), para a tela recarregar. */
  onFinished: () => void;
  /** O servidor disse que a edição está bloqueada (a liberação acabou). */
  onLocked?: () => void;
  pollMs?: number;
}) {
  const { t } = useI18n();
  const askBackup = action.askBackup ?? (action.kind === "truncate" || action.kind === "reset");
  const askName = action.askName ?? action.kind === "reset";
  const [backup, setBackup] = useState<DatabaseBackupChoice>(development ? "none" : "full");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ job: DatabaseJob; alertWarning: string | null } | null>(null);
  // Comando do framework com mais de um container com artisan: a pessoa escolhe onde rodar
  const [services, setServices] = useState<{ list: string[]; suggested: string | null } | null>(null);
  const [service, setService] = useState("");
  const autoRef = useRef(false);

  const title = t(`database.action.title.${action.kind}` as Key);

  async function send(chosenService: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<DatabaseJobStarted>(`/api/projects/${projectId}/database/${action.path}`, {
        method: "POST",
        body: JSON.stringify({
          ...action.payload,
          ...(chosenService ? { service: chosenService } : {}),
          ...(askBackup ? { backup } : {}),
          ...(askName ? { confirm } : {}),
        }),
      });
      setStarted({ job: res.job, alertWarning: res.alertWarning ?? null });
    } catch (err) {
      const data = err instanceof ApiRequestError && err.code === "app_ambiguous" ? err.data : undefined;
      const list = data?.services;
      if (Array.isArray(list) && list.every((x) => typeof x === "string") && list.length > 0) {
        const suggested = typeof data?.suggested === "string" ? data.suggested : null;
        setServices({ list: list as string[], suggested });
        setService(suggested ?? (list as string[])[0]!);
      }
      if (err instanceof ApiRequestError && err.code === "unlock_required") onLocked?.();
      setError(dbErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (action.auto && !autoRef.current) {
      autoRef.current = true;
      void send(service);
    }
    // só na abertura
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(service);
  }

  const canSubmit = !busy && (!askName || confirm === projectName);

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

        {!started && action.auto && !error && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("database.action.working")}
          </p>
        )}
        {!started && action.auto && error && (
          <div className="flex flex-col gap-3">
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t("database.action.close")}
              </Button>
            </div>
          </div>
        )}

        {!started && !action.auto && (
          <form onSubmit={submit} className="flex flex-col gap-4">
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

            {askBackup && (
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
            )}

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

            {askName && (
              <ConfirmWordInput
                id="db-confirm"
                word={projectName}
                value={confirm}
                onChange={setConfirm}
                labelKey="database.action.confirm.label"
                hintKey="database.action.confirm.hint"
              />
            )}

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
