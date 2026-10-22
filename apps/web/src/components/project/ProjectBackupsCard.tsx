import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { BACKUP_ENGINE_LABELS, type BackupRecord, type BackupsStatus, type ProjectBackupView, type ProjectEmailResponse } from "@paas/core";
import { Trans, useI18n } from "@/i18n";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Feedback,
  BackupTimezoneNote,
  HistoryList,
  RecordBadge,
  RestoreDialog,
  TargetSettings,
  VerifyAllButton,
  errorText,
  formatBytes,
  when,
} from "@/components/backups/backup-ui";
import { AlertTriangle, Database, FolderPlus, HardDrive, Loader2, Mail, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

/**
 * Aba Backups do projeto: o que o painel encontrou depois do deploy (bancos,
 * volumes e pastas, com tamanho e o motivo de vir marcado ou não), as pastas
 * adicionadas à mão, o aviso de arquivos gravados fora de volume, frequência
 * e cópias, "Fazer backup agora", o histórico e "Restaurar".
 */
export function ProjectBackupsCard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useI18n();
  const [view, setView] = useState<ProjectBackupView | null>(null);
  const [status, setStatus] = useState<BackupsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [extras, setExtras] = useState<Array<{ service: string; path: string }>>([]);
  const [newService, setNewService] = useState("");
  const [newPath, setNewPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // O e-mail do projeto está ligado? (o backup dele é o do servidor de e-mail, não o deste projeto)
  const [emailOn, setEmailOn] = useState(false);

  const load = useCallback(() => {
    Promise.all([apiFetch<ProjectBackupView>(`/api/backups/projects/${projectId}`), apiFetch<BackupsStatus>("/api/backups")])
      .then(([v, s]) => {
        setView(v);
        setStatus(s);
        setChoices(v.choices);
        setExtras(v.extraFolders.map((f) => ({ service: f.service, path: f.path })));
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [projectId]);

  useEffect(load, [load]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email`)
      .then((r) => !cancelled && setEmailOn(r.email?.enabled === true))
      .catch(() => !cancelled && setEmailOn(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const last = view?.target.lastBackup ?? null;
  const running = last !== null && (last.status === "running" || last.status === "queued");
  // conferências também entram na fila: acompanha enquanto houver algo andando
  const active = running || Boolean(view?.history.some((r) => r.status === "running" || r.status === "queued"));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  if (loadError) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-destructive">{loadError}</span>
        <Button variant="outline" size="sm" onClick={load}>
          {t("backups.action.retry")}
        </Button>
      </div>
    );
  }
  if (!view || !status) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const d = view.detection;
  const emailTarget = status.targets?.find((x) => x.id === "email") ?? null;
  const nothingToCopy =
    d !== null && d.databases.length === 0 && d.mounts.length === 0 && d.sourceFolder === null && d.unsavedWrites.length === 0 && extras.length === 0;
  const chosen = (id: string, def: boolean) => choices[id] ?? def;
  const services = [...new Set([...(d?.databases.map((x) => x.service) ?? []), ...(d?.mounts.map((x) => x.service) ?? []), ...(d?.unsavedWrites.map((x) => x.service) ?? [])])];
  const dirty =
    JSON.stringify(choices) !== JSON.stringify(view.choices) ||
    JSON.stringify(extras) !== JSON.stringify(view.extraFolders.map((f) => ({ service: f.service, path: f.path })));

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const saveItems = () =>
    act(
      "save",
      () => apiFetch(`/api/backups/targets/project:${projectId}`, { method: "PUT", body: JSON.stringify({ choices, extraFolders: extras }) }),
      t("backups.project.itemsSaved"),
    );

  return (
    <div className="flex flex-col gap-6" data-testid="project-backups">
      {emailOn && (
        <section data-testid="project-email-backup" aria-labelledby="bk-email-title" className="flex flex-col gap-3 rounded-lg border p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="bk-email-title" className="flex items-center gap-2 text-base font-semibold">
              <Mail className="h-4 w-4 text-violet-400" aria-hidden /> {t("backups.project.email.title")}
            </h2>
            {emailTarget && (
              <Badge data-testid="project-email-backup-badge" variant={emailTarget.enabled ? "success" : "outline"}>
                {emailTarget.enabled ? t("backups.project.email.badgeOn") : t("backups.project.email.badgeOff")}
              </Badge>
            )}
          </div>
          <p>{t("backups.project.email.scope")}</p>
          <p>
            <Trans k="backups.project.email.note" components={{ link: <Link to="/settings/backups" className="underline underline-offset-2" /> }} />
          </p>
          {emailTarget?.enabled === true && (
            <ul data-testid="project-email-backup-details" className="flex flex-col gap-0.5 text-muted-foreground">
              <li>{t("backups.project.email.frequency", { hours: emailTarget.frequencyHours })}</li>
              <li>{emailTarget.lastSuccessAt ? t("backups.project.email.last", { when: when(emailTarget.lastSuccessAt) }) : t("backups.project.email.lastNever")}</li>
              <li>
                {emailTarget.lastRemoteVerifiedAt
                  ? t("backups.project.email.remoteChecked", { when: when(emailTarget.lastRemoteVerifiedAt) })
                  : t("backups.project.email.remoteNever")}
              </li>
            </ul>
          )}
          {emailTarget && !emailTarget.enabled && (
            <p data-testid="project-email-backup-off" role="note" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <Trans k="backups.project.email.off" components={{ link: <Link to="/settings/backups" className="underline underline-offset-2" /> }} />
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/settings/backups">{t("backups.project.email.open")}</Link>
            </Button>
            {emailTarget?.available && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !status.archiverAvailable}
                onClick={() => void act("email-run", () => apiFetch("/api/backups/targets/email/run", { method: "POST" }), t("backups.project.email.queued"))}
              >
                {busy === "email-run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} {t("backups.project.email.runNow")}
              </Button>
            )}
          </div>
        </section>
      )}
      <section data-testid="project-backup-section" aria-labelledby="bk-project-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="bk-project-title" className="text-base font-semibold">
            {t("backups.project.projectSection.title")}
          </h2>
          <Badge data-testid="project-backup-badge" variant={view.target.enabled ? "success" : "outline"}>
            {view.target.enabled ? t("backups.project.projectSection.on") : t("backups.project.projectSection.off")}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("backups.project.projectSection.description")}
          {emailOn && <> {t("backups.project.projectSection.emailNote")}</>}
        </p>
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-sky-400" /> {t("backups.project.items.title")}
          </CardTitle>
          <CardDescription>{t("backups.project.items.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {!d && <p className="text-muted-foreground">{t("backups.project.notDetected")}</p>}
          {nothingToCopy && (
            <p data-testid="project-nothing-to-copy" className="text-muted-foreground">
              {t(emailOn ? "backups.project.nothingToCopyEmail" : "backups.project.nothingToCopy")}
            </p>
          )}
          {d?.error && (
            <p className="flex items-start gap-2 text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {d.error}
            </p>
          )}
          {d && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">{t("backups.project.databases")}</h3>
                {d.databases.length === 0 && <p className="text-muted-foreground">{t("backups.project.noDatabases")}</p>}
                {d.databases.map((db) => (
                  <label key={db.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      checked={chosen(db.id, db.defaultSelected)}
                      onChange={(e) => setChoices({ ...choices, [db.id]: e.target.checked })}
                    />
                    <span className="min-w-0">
                      <span className="font-medium">
                        {t("backups.project.dbService", { engine: BACKUP_ENGINE_LABELS[db.engine], service: db.service })}
                      </span>
                      {db.databaseName && <span className="text-muted-foreground">{t("backups.project.dbName", { name: db.databaseName })}</span>}
                      <span className="block text-muted-foreground">{db.method}</span>
                      {db.engine === "redis" && (
                        <span className="block text-muted-foreground">{t("backups.project.redisHint")}</span>
                      )}
                    </span>
                  </label>
                ))}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="font-medium">{t("backups.project.mounts")}</h3>
                {d.mounts.length === 0 && !d.sourceFolder && <p className="text-muted-foreground">{t("backups.project.noMounts")}</p>}
                {d.sourceFolder && (
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      checked={chosen("src", true)}
                      onChange={(e) => setChoices({ ...choices, src: e.target.checked })}
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{t("backups.project.sourceCode")}</span> <span className="text-muted-foreground">· {formatBytes(d.sourceFolder.sizeBytes)}</span>
                      <span className="block text-muted-foreground">{t("backups.project.sourceHint")}</span>
                    </span>
                  </label>
                )}
                {d.mounts.map((m) => (
                  <label key={m.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      disabled={m.coveredByDump}
                      checked={m.coveredByDump ? false : chosen(m.id, m.defaultSelected)}
                      onChange={(e) => setChoices({ ...choices, [m.id]: e.target.checked })}
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{m.destination}</span>{" "}
                      <span className="text-muted-foreground">
                        {t(m.type === "volume" ? "backups.project.mountVolume" : "backups.project.mountFolder", {
                          service: m.service,
                          source: m.source,
                          size: formatBytes(m.sizeBytes),
                        })}
                      </span>
                      <span className="block text-muted-foreground">{m.reason}</span>
                    </span>
                  </label>
                ))}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="font-medium">{t("backups.project.extras")}</h3>
                {extras.length === 0 && <p className="text-muted-foreground">{t("backups.project.noExtras")}</p>}
                {extras.map((x, i) => (
                  <div key={`${x.service}:${x.path}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      <code>{x.path}</code> <span className="text-muted-foreground">{t("backups.project.extraService", { service: x.service })}</span>
                    </span>
                    <Button variant="ghost" size="sm" aria-label={t("backups.project.removeExtra", { path: x.path })} onClick={() => setExtras(extras.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {services.length > 0 && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="bk-extra-service" className="text-muted-foreground">
                        {t("backups.project.service")}
                      </label>
                      <select
                        id="bk-extra-service"
                        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                        value={newService || services[0]}
                        onChange={(e) => setNewService(e.target.value)}
                      >
                        {services.map((s) => (
                          <option key={s} value={s} className="bg-background">
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <label htmlFor="bk-extra-path" className="text-muted-foreground">
                        {t("backups.project.containerPath")}
                      </label>
                      <Input id="bk-extra-path" placeholder="/app/storage" value={newPath} onChange={(e) => setNewPath(e.target.value)} spellCheck={false} />
                    </div>
                    <Button
                      variant="outline"
                      disabled={!newPath.trim().startsWith("/")}
                      onClick={() => {
                        setExtras([...extras, { service: newService || services[0]!, path: newPath.trim() }]);
                        setNewPath("");
                      }}
                    >
                      <FolderPlus className="h-4 w-4" /> {t("backups.project.addFolder")}
                    </Button>
                  </div>
                )}
              </section>

              {d.unsavedWrites.length > 0 && (
                <div data-testid="unsaved-writes" className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
                  <p className="flex items-start gap-2 font-medium">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t("backups.project.unsavedTitle")}
                  </p>
                  {d.unsavedWrites.map((u) => (
                    <p key={u.service}>
                      <Trans
                        k="backups.project.unsavedLine"
                        params={{ service: u.service, count: u.count, samples: u.samples.slice(0, 3).join(", ") }}
                        components={{ code: <code /> }}
                      />
                    </p>
                  ))}
                  <p className="text-amber-200/80">{t("backups.project.unsavedHint")}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("backups.project.detectedAt", { when: when(d.detectedAt) })}</p>
            </>
          )}
          <Feedback error={error} notice={notice} />
          <div className="flex flex-wrap gap-2">
            {d && (
              <Button onClick={() => void saveItems()} disabled={!dirty || busy !== null}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.project.saveItems")}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void act("detect", () => apiFetch(`/api/backups/projects/${projectId}/detect`, { method: "POST" }), t("backups.project.detectionUpdated"))}
              disabled={busy !== null}
            >
              {busy === "detect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("backups.project.detectAgain")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-violet-400" /> {t("backups.project.frequency.title")}
          </CardTitle>
          <CardDescription>
            {view.destinationConnected ? (
              t("backups.project.frequency.connected")
            ) : (
              <>
                {t("backups.project.frequency.vpsOnly")}{" "}
                <Link to="/settings/backups" className="underline underline-offset-2">
                  {t("backups.project.frequency.connect")}
                </Link>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {view.target.pausedReason && (
            <p className="text-xs text-amber-400" data-testid="project-paused">
              {view.target.pausedReason}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2" data-testid="project-settings-source">
            {view.target.followsDefaults !== false ? (
              <>
                <Badge variant="secondary">{t("backups.project.followsDefaults")}</Badge>
                <span className="text-muted-foreground">
                  <Trans
                    k="backups.project.followsDefaultsHelp"
                    components={{
                      link: (children) => (
                        <Link to="/settings/backups" className="underline underline-offset-2">
                          {children}
                        </Link>
                      ),
                    }}
                  />
                </span>
              </>
            ) : (
              <>
                <Badge variant="outline">{t("backups.project.ownSettings")}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      "defaults",
                      () => apiFetch(`/api/backups/targets/project:${projectId}/use-defaults`, { method: "POST" }),
                      t("backups.project.backToDefaultsDone"),
                    )
                  }
                >
                  {busy === "defaults" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.project.backToDefaults")}
                </Button>
              </>
            )}
          </div>
          <TargetSettings
            key={`${view.target.enabled}-${view.target.frequencyHours}-${view.target.localKeep}-${view.target.remoteKeep}`}
            target={view.target}
            remote={view.destinationConnected}
            timezone={status.timezone}
            backupHour={status.backupHour}
            onSaved={load}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("backups.lastBackup.label")}</span>
            {last ? (
              <>
                <RecordBadge record={last} /> <span>{when(last.finishedAt ?? last.queuedAt)}</span>
              </>
            ) : (
              <span>{t("backups.lastBackup.none")}</span>
            )}
            {view.target.lastRemoteVerifiedAt && <Badge variant="success">{t("backups.project.remoteVerifiedAt", { when: when(view.target.lastRemoteVerifiedAt) })}</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="info"
              disabled={busy !== null || running || !status.archiverAvailable}
              onClick={() =>
                void act("run", () => apiFetch<BackupRecord>(`/api/backups/targets/project:${projectId}/run`, { method: "POST" }), t("backups.project.queued"))
              }
            >
              {busy === "run" || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} {t("backups.action.backupNow")}
            </Button>
            <Button variant="outline" onClick={() => setRestoring(true)}>
              <RotateCcw className="h-4 w-4" /> {t("backups.action.restore")}
            </Button>
            <VerifyAllButton target={`project:${projectId}`} onQueued={load} disabled={!status.archiverAvailable || !last} />
          </div>
          <BackupTimezoneNote status={status} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("backups.project.history")}</CardTitle>
        </CardHeader>
        <CardContent>
          <HistoryList records={view.history} showTarget={false} empty={t("backups.project.historyEmpty")} onVerify={load} />
        </CardContent>
      </Card>

      {restoring && (
        <RestoreDialog
          target={{ id: `project:${projectId}`, kind: "project", name: projectName }}
          allowRedeploy
          onClose={() => setRestoring(false)}
          onFinished={load}
        />
      )}
    </div>
  );
}
