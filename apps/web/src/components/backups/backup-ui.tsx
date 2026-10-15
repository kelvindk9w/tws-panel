/**
 * Peças da tela de backups usadas em Configurações → Backups e na aba Backups
 * do projeto: situação de cada backup, histórico, frequência e cópias
 * guardadas, a janela de restauração (com progresso) e a criação da senha.
 */
import { useEffect, useRef, useState } from "react";
import {
  BACKUP_FREQUENCIES,
  MAX_BACKUP_KEEP,
  MIN_BACKUP_PASSWORD_LENGTH,
  backupCoverageHours,
  backupPasswordStrength,
  buildRecoveryKit,
  formatBackupCoverage,
  type BackupFrequencyHours,
  type BackupPoint,
  type BackupRecord,
  type BackupRemoteState,
  type BackupsStatus,
  type BackupTargetStatus,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Download, Loader2, RotateCcw, Sparkles } from "lucide-react";

export function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : "Não foi possível concluir agora. Tente de novo em instantes.";
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "tamanho desconhecido";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
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

const STATUS_BADGE: Record<BackupRecord["status"], { label: string; variant: "success" | "destructive" | "warning" | "secondary" }> = {
  queued: { label: "Na fila", variant: "secondary" },
  running: { label: "Rodando", variant: "secondary" },
  success: { label: "Concluído", variant: "success" },
  warning: { label: "Concluído com avisos", variant: "warning" },
  failed: { label: "Falhou", variant: "destructive" },
};

const REMOTE_TEXT: Record<BackupRemoteState, string | null> = {
  none: null,
  uploading: "enviando para fora",
  uploaded: "enviado, conferindo",
  verified: "cópia externa conferida",
  failed: "cópia externa falhou",
  skipped: "cópia externa não feita",
};

export function RecordBadge({ record }: { record: BackupRecord }) {
  const b = STATUS_BADGE[record.status];
  return (
    <Badge variant={b.variant}>
      {(record.status === "running" || record.status === "queued") && <Loader2 className="h-3 w-3 animate-spin" />}
      {b.label}
    </Badge>
  );
}

/** Uma linha do histórico: o que, quando, onde ficou e o motivo de falha/aviso. */
export function RecordLine({ record, showTarget = true }: { record: BackupRecord; showTarget?: boolean }) {
  const remote = REMOTE_TEXT[record.remote];
  const where = [record.local && record.operation === "backup" ? "na VPS" : null, remote].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3" data-testid="backup-record">
      <span className="shrink-0 text-xs text-muted-foreground sm:w-28">{when(record.finishedAt ?? record.startedAt ?? record.queuedAt)}</span>
      <span className="min-w-0 flex-1 break-words">
        {showTarget && <strong className="font-medium">{record.targetName}: </strong>}
        {record.operation === "restore" ? "restauração" : record.trigger === "schedule" ? "backup agendado" : "backup feito agora"}
        {record.fileName && <span className="text-muted-foreground"> ({record.fileName}{record.sizeBytes ? `, ${formatBytes(record.sizeBytes)}` : ""})</span>}
        {where && <span className="block text-xs text-muted-foreground">{where}</span>}
        {record.error && <span className="block text-xs text-red-400">{record.error}</span>}
        {record.remoteDetail && <span className="block text-xs text-amber-400">{record.remoteDetail}</span>}
        {record.warnings.map((w, i) => (
          <span key={i} className="block text-xs text-amber-400">
            {w}
          </span>
        ))}
      </span>
      <span className="shrink-0">
        <RecordBadge record={record} />
      </span>
    </li>
  );
}

export function HistoryList({ records, showTarget = true, empty }: { records: BackupRecord[]; showTarget?: boolean; empty: string }) {
  if (records.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {records.map((r) => (
        <RecordLine key={r.id} record={r} showTarget={showTarget} />
      ))}
    </ul>
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

export function coverageText(t: Pick<BackupTargetStatus, "frequencyHours" | "localKeep" | "remoteKeep">, remote: boolean): string {
  const local = formatBackupCoverage(backupCoverageHours(t.frequencyHours, t.localKeep));
  if (!remote) return `Seus backups cobrem ${local} (cópias na VPS).`;
  const ext = formatBackupCoverage(backupCoverageHours(t.frequencyHours, t.remoteKeep));
  return `Seus backups cobrem ${ext} no armazenamento externo e ${local} na VPS.`;
}

export function TargetSettings({
  target,
  remote,
  timezone,
  backupHour,
  onSaved,
}: {
  target: BackupTargetStatus;
  remote: boolean;
  timezone: string;
  backupHour: number;
  onSaved: () => void;
}) {
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
      setError(`Informe de 1 a ${MAX_BACKUP_KEEP} cópias.`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/backups/targets/${target.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled, frequencyHours: frequency, localKeep: lk, remoteKeep: rk }),
      });
      setNotice("Salvo.");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const hh = String(backupHour).padStart(2, "0");
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
        Backup automático ligado
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`freq-${id}`} className="font-medium">
            Frequência
          </label>
          <select
            id={`freq-${id}`}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={frequency}
            onChange={(e) => setFrequency(Number(e.target.value) as BackupFrequencyHours)}
          >
            {BACKUP_FREQUENCIES.map((f) => (
              <option key={f} value={f} className="bg-background">
                {f === 24 ? "Uma vez por dia (24 h)" : `A cada ${f} horas`}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`lk-${id}`} className="font-medium">
            Cópias na VPS
          </label>
          <Input id={`lk-${id}`} type="number" min={1} max={MAX_BACKUP_KEEP} className="w-24" value={localKeep} onChange={(e) => setLocalKeep(e.target.value)} />
        </div>
        {remote && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`rk-${id}`} className="font-medium">
              Cópias fora da VPS
            </label>
            <Input id={`rk-${id}`} type="number" min={1} max={MAX_BACKUP_KEEP} className="w-24" value={remoteKeep} onChange={(e) => setRemoteKeep(e.target.value)} />
          </div>
        )}
        <Button onClick={() => void save()} disabled={busy || !dirty}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
        </Button>
      </div>
      <p className="text-muted-foreground">
        {enabled
          ? `Roda às ${hh}:00 (horário da VPS, ${timezone})${frequency === 24 ? "" : ` e depois a cada ${frequency} horas`}. `
          : "Desligado: só roda quando você clicar em Fazer backup agora. "}
        {coverageText(preview, remote)}
      </p>
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

function confirmWord(t: RestoreTarget): string {
  return t.kind === "panel" ? "painel" : t.kind === "email" ? "e-mail" : t.name;
}

const RESTORE_WARNING: Record<RestoreTarget["kind"], string> = {
  project:
    "Os bancos de dados e as pastas do projeto voltam ao estado daquela data. O que foi gravado depois se perde. O app fica parado durante a restauração.",
  email:
    "O e-mail para por alguns instantes e volta ao estado daquela data (caixas, mensagens, contas, regras e chaves DKIM). Mensagens recebidas depois se perdem.",
  panel:
    "O painel volta inteiro ao estado daquela data: usuários e senhas de login, projetos cadastrados e configurações. Ele reinicia sozinho no fim. O estado atual fica guardado numa pasta de segurança.",
};

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
}: {
  target: RestoreTarget;
  onClose: () => void;
  onFinished?: (record: BackupRecord) => void;
  allowRedeploy?: boolean;
  defaultRedeploy?: boolean;
  /** Datas já conhecidas (catálogo de outro servidor); sem elas, busca. */
  points?: BackupPoint[];
}) {
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
  const finished = useRef(false);

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

  // Acompanha a restauração até terminar.
  useEffect(() => {
    if (!record || record.status === "success" || record.status === "warning" || record.status === "failed") {
      if (record && !finished.current) {
        finished.current = true;
        onFinished?.(record);
      }
      return;
    }
    const t = setTimeout(() => {
      apiFetch<BackupRecord>(`/api/backups/records/${record.id}`)
        .then(setRecord)
        .catch(() => setRecord({ ...record }));
    }, 2000);
    return () => clearTimeout(t);
  }, [record, onFinished]);

  const chosen = points?.find((p) => p.fileName === fileName) ?? null;
  const word = confirmWord(target);
  const confirmed = confirm.trim().toLocaleLowerCase("pt-BR") === word.toLocaleLowerCase("pt-BR");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { fileName, source, confirm: confirm.trim() };
      if (allowRedeploy && redeploy) body.redeploy = true;
      if (oldPassword) body.password = oldPassword;
      setRecord(await apiFetch<BackupRecord>(`/api/backups/targets/${target.id}/restore`, { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const done = record && (record.status === "success" || record.status === "warning" || record.status === "failed");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Restaurar ${target.name}`}
        data-testid="restore-dialog"
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <RotateCcw className="h-5 w-5" /> Restaurar {target.name}
        </h2>

        {!record && (
          <>
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {RESTORE_WARNING[target.kind]}
            </p>
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {!points && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {points && points.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há backups para restaurar.</p>}
            {points && points.length > 0 && (
              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="mb-1 font-medium">Escolha a data</legend>
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
                    {p.local && <Badge variant="secondary">Na VPS</Badge>}
                    {p.remote && <Badge variant="secondary">Externo</Badge>}
                  </label>
                ))}
              </fieldset>
            )}
            {chosen && chosen.local && chosen.remote && (
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-muted-foreground">Usar a cópia:</span>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="restore-source" className="accent-sky-600" checked={source === "local"} onChange={() => setSource("local")} /> da
                  VPS (mais rápido)
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="restore-source" className="accent-sky-600" checked={source === "remote"} onChange={() => setSource("remote")} />{" "}
                  do armazenamento externo
                </label>
              </div>
            )}
            {allowRedeploy && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-sky-600" checked={redeploy} onChange={(e) => setRedeploy(e.target.checked)} />
                <span>
                  Publicar do GitHub antes de restaurar
                  <span className="block text-muted-foreground">Para VPS nova, quando o projeto ainda não tem containers aqui.</span>
                </span>
              </label>
            )}
            {source === "remote" && (
              <div className="text-sm">
                {!showOld ? (
                  <button type="button" className="text-sky-400 underline underline-offset-2" onClick={() => setShowOld(true)}>
                    Este backup é de antes de uma troca de senha?
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="restore-old-pw" className="font-medium">
                      Senha usada na época (deixe vazio para usar a atual)
                    </label>
                    <PasswordInput id="restore-old-pw" autoComplete="off" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1.5 text-sm">
              <label htmlFor="restore-confirm" className="font-medium">
                Para confirmar, digite <strong>{word}</strong>
              </label>
              <Input id="restore-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Feedback error={error} notice={null} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button variant="danger" onClick={() => void submit()} disabled={!chosen || !confirmed || busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Restaurar
              </Button>
            </div>
          </>
        )}

        {record && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <RecordBadge record={record} />
              <span className="text-muted-foreground">{record.fileName}</span>
            </div>
            <StepList record={record} />
            {record.error && <p className="text-sm text-destructive">{record.error}</p>}
            {record.warnings.map((w, i) => (
              <p key={i} className="text-sm text-amber-400">
                {w}
              </p>
            ))}
            {!done && <p className="text-xs text-muted-foreground">Pode fechar esta janela: a restauração continua no servidor.</p>}
            <div className="flex justify-end gap-2">
              {done && target.kind === "panel" && record.status !== "failed" && (
                <Button onClick={() => window.location.reload()}>Recarregar a página</Button>
              )}
              <Button variant="outline" onClick={onClose}>
                Fechar
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
        Sem esta senha, ninguém, nem a TWS, consegue abrir seus backups.
      </p>
      <p className="text-muted-foreground">
        Ela cifra as cópias que saem da VPS. Guarde num gerenciador de senhas ou no kit de recuperação. O painel guarda uma cópia cifrada
        para fazer os backups sozinho, e você pode vê-la depois confirmando a sua senha de login.
      </p>
      {changing && (
        <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-sky-200">
          Ao trocar, os backups novos usam a senha nova. Os antigos continuam abrindo só com a senha antiga: guarde as duas enquanto eles existirem.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="bk-password" className="font-medium">
          {changing ? "Senha nova" : "Senha dos backups"} (mínimo {MIN_BACKUP_PASSWORD_LENGTH} caracteres)
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
            {busy === "suggest" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Sugerir uma frase forte
          </Button>
        </div>
        {password && (
          <div className="flex items-center gap-2" data-testid="password-strength">
            <div className="flex h-1.5 w-32 overflow-hidden rounded bg-muted">
              <div className={cn("h-full", STRENGTH_COLOR[strength.score])} style={{ width: `${(strength.score / 4) * 100}%` }} />
            </div>
            <span className={strength.ok ? "text-emerald-400" : "text-amber-400"}>{strength.label}</span>
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
          <Download className="h-4 w-4" /> Baixar kit de recuperação
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          Um arquivo .txt com a senha, onde os backups ficam e como restaurar com ou sem o painel (7-Zip, Keka, arquivos .sql).
          {kitDone && <span className="text-emerald-400"> Kit baixado.</span>}
        </p>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-sky-600" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span className="font-medium">Guardei a senha em lugar seguro</span>
      </label>
      <Feedback error={error} notice={null} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={!strength.ok || !ack || busy !== null}>
          {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} {changing ? "Trocar a senha" : "Ativar a criptografia"}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </div>
  );
}
