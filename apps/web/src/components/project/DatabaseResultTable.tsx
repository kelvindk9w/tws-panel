import { DATABASE_SQL_ROW_CAP, type DatabaseSqlResult } from "@paas/core";
import { useI18n } from "@/i18n";

/** Resultado de uma consulta do console: tabela com rolagem, NULL em destaque e aviso de corte. */
export function DatabaseResultTable({ result }: { result: DatabaseSqlResult }) {
  const { t } = useI18n();
  if (result.empty || result.columns.length === 0) {
    return (
      <p data-testid="sql-result-empty" className="text-sm text-muted-foreground">
        {t("database.sql.result.empty")}
      </p>
    );
  }
  return (
    <div data-testid="sql-result" className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{t("database.sql.result.rows", { count: result.rows.length })}</p>
      <div className="max-h-96 overflow-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} scope="col" className="whitespace-nowrap px-2 py-1 font-mono font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r} className="border-t">
                {result.columns.map((_c, i) => (
                  <td key={i} className="max-w-xs truncate whitespace-pre px-2 py-1 font-mono" title={row[i] ?? undefined}>
                    {row[i] === null || row[i] === undefined ? <span className="italic text-muted-foreground">{t("database.sql.result.null")}</span> : row[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.truncated && (
        <p role="status" className="text-xs text-amber-300">
          {t("database.sql.result.truncated", { rows: DATABASE_SQL_ROW_CAP })}
        </p>
      )}
    </div>
  );
}
