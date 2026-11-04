import type { DatabaseJob, DatabaseSqlRun } from "@paas/core";
import { useI18n } from "@/i18n";
import { DatabaseResultTable } from "@/components/project/DatabaseResultTable";

/** Número da instrução que falhou, lido do motivo que o servidor manda ("Instrução 3: …"). */
export function failedStatement(error: DatabaseJob["error"]): number | null {
  const m = error?.detail ? /Instru[cç][aã]o (\d+)|Statement (\d+)/i.exec(error.detail) : null;
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Resultado de uma execução do console: uma seção por instrução, com tabela ou linhas afetadas. */
export function DatabaseRunView({ run, error = null }: { run: DatabaseSqlRun; error?: DatabaseJob["error"] }) {
  const { t } = useI18n();
  const failed = failedStatement(error);
  return (
    <div className="flex flex-col gap-3" data-testid="sql-run">
      {run.statements.length < run.total && (
        <p role="status" className="text-xs text-amber-300" data-testid="sql-run-partial">
          {t("database.sql.run.partial", { done: run.statements.length, total: run.total })}
        </p>
      )}
      {run.transaction && <p className="text-xs text-muted-foreground">{t("database.sql.run.transaction")}</p>}
      {run.statements.map((s) => (
        <section
          key={s.index}
          data-testid={`sql-statement-${s.index}`}
          className={failed === s.index ? "flex flex-col gap-1 rounded-md border border-destructive/50 p-2" : "flex flex-col gap-1"}
        >
          <h4 className="text-xs font-medium">{t("database.sql.statement.title", { n: s.index, verb: s.verb.toUpperCase() })}</h4>
          {s.affected !== null && (
            <p className="text-xs text-muted-foreground" data-testid={`sql-affected-${s.index}`}>
              {t("database.sql.statement.affected", { count: s.affected })}
            </p>
          )}
          {s.result && !s.result.empty ? (
            <DatabaseResultTable result={s.result} />
          ) : (
            s.affected === null && <p className="text-xs text-muted-foreground">{t("database.sql.statement.noRows")}</p>
          )}
        </section>
      ))}
      {failed !== null && !run.statements.some((s) => s.index === failed) && (
        <p role="alert" className="text-xs text-destructive" data-testid="sql-failed-at">
          {t("database.sql.failedAt", { n: failed })}
        </p>
      )}
      {run.truncated && (
        <p role="status" className="text-xs text-amber-300">
          {t("database.sql.run.truncated")}
        </p>
      )}
    </div>
  );
}
