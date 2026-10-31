import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, DatabaseBackup, KeyRound, Loader2, Lock, RefreshCw, Terminal, Trash2, Unlock } from "lucide-react";
import {
  BACKUP_ENGINE_LABELS,
  DATABASE_READ_TIMEOUT_SEC,
  DATABASE_SQL_MAX_LENGTH,
  DATABASE_SQL_MAX_STATEMENTS,
  DATABASE_SQL_ROW_CAP,
  analyzeSqlScript,
  isDatabaseSqlEngine,
  type DatabaseCommandInfo,
  type DatabaseOverview,
  type DatabaseSqlRun,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { formatCountdown, useDatabaseUnlock } from "@/lib/database-unlock";
import { dbErrorText, tableId, tableLabel, toRef } from "@/lib/database";
import { formatNumber, useI18n, type Key } from "@/i18n";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatabaseActionDialog, type DatabaseActionSpec } from "@/components/project/DatabaseActionDialog";
import { DatabaseRunView } from "@/components/project/DatabaseRunView";
import { DatabaseUnlockDialog } from "@/components/project/DatabaseUnlockDialog";

const SQL_ERROR_KEYS = {
  empty: "database.sql.error.empty",
  multiple: "database.sql.error.multiple",
  client_command: "database.sql.error.client_command",
  executable_comment: "database.sql.error.executable_comment",
  unterminated: "database.sql.error.unterminated",
  too_many: "database.sql.error.limit",
  ambiguous: "database.sql.error.ambiguous",
  dollar_quote: "database.sql.error.dollar_quote",
} as const satisfies Record<string, Key>;

const COMMAND_KEYS = {
  "laravel-migrate-fresh-seed": "database.commands.laravel-migrate-fresh-seed",
  "laravel-migrate": "database.commands.laravel-migrate",
  "laravel-seed": "database.commands.laravel-seed",
} as const satisfies Record<DatabaseCommandInfo["id"], Key>;

/**
 * Aba Banco: motor, versão, tabelas (com linhas e tamanho aproximados), esvaziar tabelas, zerar o banco, atalho para
 * restaurar backup, comandos do framework e console SQL. Leitura com a sessão normal; tudo que altera dados passa
 * pelo DatabaseActionDialog (senha + 2FA, nome do projeto e escolha do backup).
 */
export function ProjectDatabaseSection({ projectId, projectName, pollMs, tickMs }: { projectId: string; projectName: string; pollMs?: number; tickMs?: number }) {
  const { t } = useI18n();
  const unlock = useDatabaseUnlock(projectId, tickMs);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [transaction, setTransaction] = useState(true);
  const [lockError, setLockError] = useState(false);
  const [view, setView] = useState<DatabaseOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cascade, setCascade] = useState(false);
  const [dialog, setDialog] = useState<DatabaseActionSpec | null>(null);
  const [sql, setSql] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlRun, setSqlRun] = useState<DatabaseSqlRun | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await apiFetch<DatabaseOverview>(`/api/projects/${projectId}/database`);
      setView(next);
      // a seleção só guarda tabelas que ainda existem
      const alive = new Set(next.tables.map(tableId));
      setSelected((cur) => new Set([...cur].filter((id) => alive.has(id))));
    } catch (err) {
      setLoadError(dbErrorText(err, "database.loadError"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tables = view?.tables ?? [];
  const engine = view?.engine ?? null;
  const sqlEngine = isDatabaseSqlEngine(engine) ? engine : null;
  const chosen = useMemo(() => tables.filter((x) => selected.has(tableId(x))), [tables, selected]);
  const allSelected = tables.length > 0 && chosen.length === tables.length;

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Com a edição bloqueada, o botão leva à liberação em vez de abrir a ação. */
  function open(spec: DatabaseActionSpec) {
    if (unlock.unlocked) setDialog(spec);
    else setUnlockOpen(true);
  }

  function askTruncate() {
    const names = chosen.map(tableLabel);
    open({
      kind: "truncate",
      path: "truncate",
      payload: { tables: chosen.map(toRef), ...(engine === "postgres" && cascade ? { cascade: true } : {}) },
      description: t("database.action.desc.truncate", { count: names.length, names: names.join(", ") }),
      ...(engine === "postgres" && cascade ? { warning: t("database.tables.cascadeWarn") } : {}),
    });
  }

  function askReset() {
    open({ kind: "reset", path: "reset", payload: {}, description: t("database.action.desc.reset") });
  }

  function askCommand(c: DatabaseCommandInfo) {
    open({
      kind: "command",
      path: "command",
      payload: { command: c.id },
      askBackup: false,
      askName: c.dropsData,
      description: t("database.action.desc.command", { command: c.display }),
      preview: c.display,
      ...(c.dropsData ? { warning: t("database.commands.dropsData") } : {}),
    });
  }

  // O que a pessoa escreveu: o painel avisa antes de enviar se é leitura ou escrita (o servidor decide de verdade).
  const analysis = sqlEngine && sql.trim() ? analyzeSqlScript(sql, sqlEngine) : null;
  const tooLong = sql.length > DATABASE_SQL_MAX_LENGTH;
  const refusalText =
    analysis && !analysis.ok
      ? analysis.code === "too_many"
        ? t("database.sql.error.limit", { max: DATABASE_SQL_MAX_STATEMENTS })
        : t(SQL_ERROR_KEYS[analysis.code])
      : null;
  const sqlRefusal = tooLong
    ? t("database.sql.error.too_long", { max: DATABASE_SQL_MAX_LENGTH })
    : analysis && !analysis.ok && refusalText
      ? analysis.index !== null
        ? t("database.sql.error.at", { n: analysis.index, message: refusalText })
        : refusalText
      : null;
  const kind = analysis?.ok && !tooLong ? analysis.kind : null;

  async function runRead() {
    setSqlBusy(true);
    setSqlError(null);
    setSqlRun(null);
    try {
      setSqlRun(await apiFetch<DatabaseSqlRun>(`/api/projects/${projectId}/database/sql/read`, { method: "POST", body: JSON.stringify({ sql }) }));
    } catch (err) {
      const at = err instanceof ApiRequestError && typeof err.data?.statement === "number" ? ` ${t("database.sql.failedAt", { n: err.data.statement })}` : "";
      setSqlError(`${dbErrorText(err)}${at}`);
    } finally {
      setSqlBusy(false);
    }
  }

  function askWrite() {
    setDialog({
      kind: "sql",
      path: "sql/write",
      payload: { sql, ...(engine === "postgres" ? { transaction } : {}) },
      description: t("database.action.desc.sql"),
      preview: sql.trim(),
      auto: true,
    });
  }

  const ok = view?.state === "ok";

  return (
    <div className="flex flex-col gap-4" data-testid="project-database">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("database.title")}</CardTitle>
            <CardDescription>{t("database.desc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t("database.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {loading && !view && <p className="text-muted-foreground">{t("database.loading")}</p>}
          {loadError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              {loadError}
            </p>
          )}
          {view && !ok && (
            <div
              role="status"
              data-testid={`database-${view.state}`}
              className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200"
            >
              <strong>{t(view.state === "unsupported" ? "database.state.unsupported.title" : "database.state.unavailable.title")}</strong>
              <span>{view.message}</span>
              <span className="text-xs text-amber-200/80">{t("database.state.hint")}</span>
            </div>
          )}
          {view && ok && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4" data-testid="database-overview">
              <Fact label={t("database.overview.engine")} value={engine ? BACKUP_ENGINE_LABELS[engine] : "—"} />
              <Fact label={t("database.overview.version")} value={view.version ?? "—"} />
              <Fact label={t("database.overview.database")} value={view.database ?? "—"} />
              <Fact label={t("database.overview.size")} value={view.sizeBytes === null ? "—" : formatBytes(view.sizeBytes)} />
            </dl>
          )}
          {view?.development && ok && <Badge variant="secondary" className="self-start">{t("database.overview.dev")}</Badge>}
        </CardContent>
      </Card>

      {view && ok && (
        <div
          data-testid={unlock.unlocked ? "database-unlocked" : "database-locked"}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${unlock.unlocked ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"}`}
        >
          {unlock.unlocked ? (
            <>
              <span className="flex items-center gap-2 font-medium text-emerald-300" role="status">
                <Unlock className="h-4 w-4" />
                {unlock.remainingMs === null ? t("database.unlock.badgeSession") : t("database.unlock.badge", { time: formatCountdown(unlock.remainingMs) })}
              </span>
              <Button variant="outline" size="sm" onClick={() => void unlock.lock().catch(() => setLockError(true))}>
                <Lock className="h-3.5 w-3.5" /> {t("database.unlock.lockNow")}
              </Button>
            </>
          ) : (
            <>
              <span className="flex min-w-0 flex-col gap-0.5 text-amber-200">
                <span className="flex items-center gap-2 font-medium">
                  <Lock className="h-4 w-4" /> {t("database.unlock.lockedTitle")}
                </span>
                <span className="text-xs">{unlock.ended ? t("database.unlock.expired") : t("database.unlock.lockedHint")}</span>
              </span>
              <Button size="sm" onClick={() => setUnlockOpen(true)}>
                <KeyRound className="h-3.5 w-3.5" /> {t("database.unlock.button")}
              </Button>
            </>
          )}
        </div>
      )}
      {lockError && (
        <p role="alert" className="text-xs text-destructive">
          {t("database.unlock.lockError")}
        </p>
      )}

      {view && ok && (
        <Card>
          <CardHeader className="space-y-1.5">
            <CardTitle className="text-base">
              {t("database.tables.title")} <span className="text-sm font-normal text-muted-foreground">({t("database.tables.count", { count: tables.length })})</span>
            </CardTitle>
            <CardDescription>{t("database.tables.rowsHint")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {tables.length === 0 ? (
              <p className="text-muted-foreground" data-testid="database-no-tables">{t("database.tables.empty")}</p>
            ) : (
              <div className="max-h-96 overflow-auto rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-muted text-xs">
                    <tr>
                      <th className="w-8 px-2 py-1">
                        <input
                          type="checkbox"
                          aria-label={t("database.tables.selectAll")}
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(tables.map(tableId)))}
                          className="h-4 w-4"
                        />
                      </th>
                      <th scope="col" className="px-2 py-1 font-medium">{t("database.tables.name")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("database.tables.rows")}</th>
                      <th scope="col" className="px-2 py-1 text-right font-medium">{t("database.tables.size")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((tb) => (
                      <tr key={tableId(tb)} className="border-t" data-testid={`db-table-${tableLabel(tb)}`}>
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            aria-label={t("database.tables.select", { name: tableLabel(tb) })}
                            checked={selected.has(tableId(tb))}
                            onChange={() => toggle(tableId(tb))}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="break-all px-2 py-1 font-mono text-xs">{tableLabel(tb)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{tb.rows === null ? t("database.tables.noEstimate") : `~${formatNumber(tb.rows)}`}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{tb.sizeBytes === null ? t("database.tables.noEstimate") : formatBytes(tb.sizeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {engine === "postgres" && tables.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} className="h-4 w-4" />
                  {t("database.tables.cascade")}
                </label>
                {cascade && (
                  <p role="alert" className="flex items-start gap-2 text-xs text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("database.tables.cascadeWarn")}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="sm" disabled={chosen.length === 0} onClick={askTruncate}>
                <Trash2 className="h-3.5 w-3.5" /> {t("database.tables.truncate", { count: chosen.length })}
              </Button>
              <Button variant="destructive" size="sm" onClick={askReset}>
                <AlertTriangle className="h-3.5 w-3.5" /> {t("database.tables.reset")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseBackup className="h-4 w-4" /> {t("database.restore.title")}
          </CardTitle>
          <CardDescription>{t("database.restore.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link to={`/projects/${projectId}/backups`}>{t("database.restore.link")}</Link>
          </Button>
        </CardContent>
      </Card>

      {view && (
        <Card>
          <CardHeader className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal className="h-4 w-4" /> {t("database.commands.title")}
            </CardTitle>
            <CardDescription>{t("database.commands.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {view.commands.length === 0 ? (
              <p className="text-muted-foreground" data-testid="database-no-commands">{t("database.commands.none")}</p>
            ) : (
              <>
                <Badge variant="secondary" className="self-start">{t("database.commands.framework.laravel")}</Badge>
                {view.commands.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2" data-testid={`db-command-${c.id}`}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">{t(COMMAND_KEYS[c.id])}</span>
                      <code className="break-all text-xs text-muted-foreground">{c.display}</code>
                      <span className={c.dropsData ? "text-xs text-amber-300" : "text-xs text-muted-foreground"}>
                        {t(c.dropsData ? "database.commands.dropsData" : "database.commands.changesData")}
                      </span>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => askCommand(c)}>
                      {t("database.commands.run")}
                    </Button>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {view && ok && sqlEngine && (
        <Card>
          <CardHeader className="space-y-1.5">
            <CardTitle className="text-base">{t("database.sql.title")}</CardTitle>
            <CardDescription>
              {t("database.sql.desc", { seconds: DATABASE_READ_TIMEOUT_SEC, rows: DATABASE_SQL_ROW_CAP })} {t("database.sql.limits")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <label htmlFor="db-sql" className="text-xs text-muted-foreground">{t("database.sql.label")}</label>
            <textarea
              id="db-sql"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={5}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("database.sql.placeholder")}
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {sqlRefusal && (
              <p role="alert" data-testid="sql-refusal" className="text-xs text-amber-300">
                {sqlRefusal}
              </p>
            )}
            {kind && (
              <p data-testid="sql-kind" className={kind === "write" ? "text-xs text-amber-300" : "text-xs text-muted-foreground"}>
                {t(kind === "write" ? "database.sql.kind.write" : "database.sql.kind.read")}
              </p>
            )}
            {kind === "write" && engine === "postgres" && (
              <div className="flex flex-col gap-0.5">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={transaction} onChange={(e) => setTransaction(e.target.checked)} className="h-4 w-4" />
                  {t("database.sql.transaction")}
                </label>
                <p className="text-xs text-muted-foreground">{t("database.sql.transactionHint")}</p>
              </div>
            )}
            {kind === "write" && engine !== "postgres" && (
              <p data-testid="sql-ddl-hint" className="text-xs text-muted-foreground">
                {t("database.sql.mysqlDdlHint")}
              </p>
            )}
            {kind === "write" && !unlock.unlocked && (
              <p role="status" data-testid="sql-locked" className="text-xs text-amber-300">
                {t("database.sql.lockedWrite")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {kind === "write" && !unlock.unlocked ? (
                <Button size="sm" onClick={() => setUnlockOpen(true)}>
                  <KeyRound className="h-3.5 w-3.5" /> {t("database.unlock.button")}
                </Button>
              ) : kind === "write" ? (
                <Button variant="destructive" size="sm" onClick={askWrite}>
                  {t("database.sql.runWrite")}
                </Button>
              ) : (
                <Button size="sm" disabled={sqlBusy || kind === null} onClick={() => void runRead()}>
                  {sqlBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {sqlBusy ? t("database.sql.running") : t("database.sql.runRead")}
                </Button>
              )}
            </div>
            {sqlError && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {sqlError}
              </p>
            )}
            {sqlRun && <DatabaseRunView run={sqlRun} />}
          </CardContent>
        </Card>
      )}

      {dialog && (
        <DatabaseActionDialog
          projectId={projectId}
          projectName={projectName}
          development={view?.development === true}
          action={dialog}
          {...(pollMs !== undefined ? { pollMs } : {})}
          onClose={() => setDialog(null)}
          onFinished={() => {
            void load();
            void unlock.refresh();
          }}
          onLocked={() => void unlock.refresh()}
        />
      )}
      {unlockOpen && (
        <DatabaseUnlockDialog
          projectId={projectId}
          development={view?.development === true}
          {...(pollMs !== undefined ? { pollMs } : {})}
          onClose={() => setUnlockOpen(false)}
          onFinished={() => void unlock.refresh()}
        />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}
