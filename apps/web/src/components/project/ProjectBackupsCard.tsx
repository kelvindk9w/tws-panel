import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { BACKUP_ENGINE_LABELS, type BackupRecord, type BackupsStatus, type ProjectBackupView } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Feedback,
  HistoryList,
  RecordBadge,
  RestoreDialog,
  TargetSettings,
  errorText,
  formatBytes,
  when,
} from "@/components/backups/backup-ui";
import { AlertTriangle, Database, FolderPlus, HardDrive, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

/**
 * Aba Backups do projeto: o que o painel encontrou depois do deploy (bancos,
 * volumes e pastas, com tamanho e o motivo de vir marcado ou não), as pastas
 * adicionadas à mão, o aviso de arquivos gravados fora de volume, frequência
 * e cópias, "Fazer backup agora", o histórico e "Restaurar".
 */
export function ProjectBackupsCard({ projectId, projectName }: { projectId: string; projectName: string }) {
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

  const last = view?.target.lastBackup ?? null;
  const running = last !== null && (last.status === "running" || last.status === "queued");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  if (loadError) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-destructive">{loadError}</span>
        <Button variant="outline" size="sm" onClick={load}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  if (!view || !status) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const d = view.detection;
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
      "Itens salvos. Valem a partir do próximo backup.",
    );

  return (
    <div className="flex flex-col gap-6" data-testid="project-backups">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-sky-400" /> O que entra no backup
          </CardTitle>
          <CardDescription>
            O painel olha os containers depois de cada deploy. O código vem do GitHub e não entra; entram os bancos e as pastas com dados.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {!d && <p className="text-muted-foreground">Ainda não detectado. Isso acontece sozinho depois do deploy; dá para fazer agora também.</p>}
          {d?.error && (
            <p className="flex items-start gap-2 text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {d.error}
            </p>
          )}
          {d && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Bancos de dados</h3>
                {d.databases.length === 0 && <p className="text-muted-foreground">Nenhum banco encontrado (PostgreSQL, MySQL, MariaDB, MongoDB ou Redis).</p>}
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
                        {BACKUP_ENGINE_LABELS[db.engine]} · serviço {db.service}
                      </span>
                      {db.databaseName && <span className="text-muted-foreground"> · banco {db.databaseName}</span>}
                      <span className="block text-muted-foreground">{db.method}</span>
                      {db.engine === "redis" && (
                        <span className="block text-muted-foreground">Costuma ser cache. Marque só se ele guarda dados que não dá para recriar.</span>
                      )}
                    </span>
                  </label>
                ))}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Volumes e pastas</h3>
                {d.mounts.length === 0 && !d.sourceFolder && <p className="text-muted-foreground">Nenhuma pasta montada nos containers.</p>}
                {d.sourceFolder && (
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                      checked={chosen("src", true)}
                      onChange={(e) => setChoices({ ...choices, src: e.target.checked })}
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-medium">Código do projeto</span> <span className="text-muted-foreground">· {formatBytes(d.sourceFolder.sizeBytes)}</span>
                      <span className="block text-muted-foreground">Este projeto não vem do GitHub: sem o backup, o código só existe nesta VPS.</span>
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
                        · serviço {m.service} · {m.type === "volume" ? `volume ${m.source}` : `pasta ${m.source}`} · {formatBytes(m.sizeBytes)}
                      </span>
                      <span className="block text-muted-foreground">{m.reason}</span>
                    </span>
                  </label>
                ))}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Pastas adicionadas</h3>
                {extras.length === 0 && <p className="text-muted-foreground">Nenhuma. Use para uma pasta dentro do container que não é volume.</p>}
                {extras.map((x, i) => (
                  <div key={`${x.service}:${x.path}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      <code>{x.path}</code> <span className="text-muted-foreground">· serviço {x.service}</span>
                    </span>
                    <Button variant="ghost" size="sm" aria-label={`Remover ${x.path}`} onClick={() => setExtras(extras.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {services.length > 0 && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="bk-extra-service" className="text-muted-foreground">
                        Serviço
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
                        Caminho dentro do container
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
                      <FolderPlus className="h-4 w-4" /> Adicionar pasta
                    </Button>
                  </div>
                )}
              </section>

              {d.unsavedWrites.length > 0 && (
                <div data-testid="unsaved-writes" className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
                  <p className="flex items-start gap-2 font-medium">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Arquivos gravados fora de volume
                  </p>
                  {d.unsavedWrites.map((u) => (
                    <p key={u.service}>
                      Serviço {u.service}: {u.count} arquivo(s), por exemplo <code>{u.samples.slice(0, 3).join(", ")}</code>.
                    </p>
                  ))}
                  <p className="text-amber-200/80">
                    Eles somem no próximo deploy e não entram no backup. Declare um volume no compose ou use Adicionar pasta.
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Detectado em {when(d.detectedAt)}.</p>
            </>
          )}
          <Feedback error={error} notice={notice} />
          <div className="flex flex-wrap gap-2">
            {d && (
              <Button onClick={() => void saveItems()} disabled={!dirty || busy !== null}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Salvar itens
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void act("detect", () => apiFetch(`/api/backups/projects/${projectId}/detect`, { method: "POST" }), "Detecção atualizada.")}
              disabled={busy !== null}
            >
              {busy === "detect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Detectar de novo
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-violet-400" /> Frequência e cópias
          </CardTitle>
          <CardDescription>
            {view.destinationConnected ? (
              "Cada backup fica na VPS e vai também para o armazenamento externo."
            ) : (
              <>
                Por enquanto os backups ficam só na VPS.{" "}
                <Link to="/settings/backups" className="underline underline-offset-2">
                  Conectar um armazenamento externo
                </Link>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <TargetSettings
            key={`${view.target.enabled}-${view.target.frequencyHours}-${view.target.localKeep}-${view.target.remoteKeep}`}
            target={view.target}
            remote={view.destinationConnected}
            timezone={status.timezone}
            backupHour={status.backupHour}
            onSaved={load}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Último backup:</span>
            {last ? (
              <>
                <RecordBadge record={last} /> <span>{when(last.finishedAt ?? last.queuedAt)}</span>
              </>
            ) : (
              <span>nenhum ainda</span>
            )}
            {view.target.lastRemoteVerifiedAt && <Badge variant="success">Externo conferido em {when(view.target.lastRemoteVerifiedAt)}</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="info"
              disabled={busy !== null || running || !status.archiverAvailable}
              onClick={() =>
                void act("run", () => apiFetch<BackupRecord>(`/api/backups/targets/project:${projectId}/run`, { method: "POST" }), "Backup na fila. Acompanhe abaixo.")
              }
            >
              {busy === "run" || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} Fazer backup agora
            </Button>
            <Button variant="outline" onClick={() => setRestoring(true)}>
              <RotateCcw className="h-4 w-4" /> Restaurar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico</CardTitle>
        </CardHeader>
        <CardContent>
          <HistoryList records={view.history} showTarget={false} empty="Nenhum backup deste projeto ainda." />
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
