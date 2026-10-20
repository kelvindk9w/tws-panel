import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  BACKUP_PASSWORD_REMINDER_DAYS,
  BACKUP_ROOT_FOLDER,
  type BackupApplyDefaultsResult,
  type BackupCatalog,
  type BackupProvider,
  type BackupRecord,
  type BackupsStatus,
  type BackupTargetStatus,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Trans, t, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CopyButton } from "@/components/CopyButton";
import {
  BackupTimezoneNote,
  Feedback,
  HistoryList,
  PasswordSetup,
  RecordBadge,
  RestoreDialog,
  TargetSettings,
  VerifyAllButton,
  downloadRecoveryKit,
  errorText,
  when,
  type RestoreTarget,
} from "@/components/backups/backup-ui";
import { AlertTriangle, CloudUpload, Download, HardDrive, KeyRound, Loader2, Lock, Mail, PlugZap, RotateCcw, Server, ShieldCheck } from "lucide-react";

/**
 * Configurações → Backups: onde os backups ficam (VPS e armazenamento externo
 * S3/R2), a criptografia da cópia externa e a senha, o painel e o e-mail
 * (frequência, cópias, fazer agora, restaurar), o padrão dos projetos (com
 * "Aplicar também nestes projetos"), os projetos (cada um tem a sua aba Backups), "Restaurar de outro servidor" e os últimos backups.
 */

type OnStatus = (s: BackupsStatus) => void;

// ---------------------------------------------------------------------------
// Armazenamento externo
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<BackupProvider, Key> = { r2: "backups.provider.r2", s3: "backups.provider.s3" };

const R2_STEPS: Key[] = [
  "backups.destination.r2Step1",
  "backups.destination.r2Step2",
  "backups.destination.r2Step3",
  "backups.destination.r2Step4",
  "backups.destination.r2Step5",
  "backups.destination.r2Step6",
];

function DestinationCard({ status, onStatus }: { status: BackupsStatus; onStatus: OnStatus }) {
  const { t } = useI18n();
  const d = status.destination;
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<BackupProvider>(d?.provider ?? "r2");
  const [endpoint, setEndpoint] = useState(d?.endpoint ?? "");
  const [region, setRegion] = useState(d?.region ?? "auto");
  const [bucket, setBucket] = useState(d?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function run(key: string, path: string, init: RequestInit, ok?: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      onStatus(await apiFetch<BackupsStatus>(path, init));
      if (ok) setNotice(ok);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const body: Record<string, string> = {
      provider,
      endpoint: endpoint.trim(),
      region: region.trim(),
      bucket: bucket.trim(),
      accessKeyId: accessKeyId.trim(),
    };
    if (secret) body.secretAccessKey = secret;
    const ok = await run("save", "/api/backups/destination", { method: "PUT", body: JSON.stringify(body) }, t("backups.destination.saved"));
    if (ok) {
      setSecret("");
      setEditing(false);
    }
  }

  const showForm = !d || editing;
  return (
    <Card data-testid="destination-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudUpload className="h-4 w-4 text-sky-400" /> {t("backups.destination.title")}
        </CardTitle>
        <CardDescription>{t("backups.destination.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {d && !editing && (
          <>
            <p className="break-words">
              <Trans
                k="backups.destination.connected"
                params={{ provider: t(PROVIDER_LABEL[d.provider]), bucket: d.bucket, endpoint: d.endpoint, hint: d.accessKeyHint }}
                components={{ b: <strong />, endpoint: <span className="break-all text-muted-foreground" /> }}
              />
            </p>
            <p className="text-muted-foreground">
              <Trans k="backups.destination.files" params={{ root: BACKUP_ROOT_FOLDER }} components={{ code: <code className="text-foreground" /> }} />
            </p>
            <div>
              {d.testedAt ? (
                <Badge variant="success">{t("backups.destination.tested", { when: when(d.testedAt) })}</Badge>
              ) : (
                <Badge variant="warning">{t("backups.destination.untested")}</Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="info"
                onClick={() => void run("test", "/api/backups/destination/test", { method: "POST" }, t("backups.destination.testOk"))}
                disabled={busy !== null}
              >
                {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} {t("backups.destination.testButton")}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setProvider(d.provider);
                  setEndpoint(d.endpoint);
                  setRegion(d.region);
                  setBucket(d.bucket);
                  setEditing(true);
                }}
                disabled={busy !== null}
              >
                {t("backups.destination.edit")}
              </Button>
              {!confirmRemove ? (
                <Button variant="outline" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                  {t("backups.destination.disconnect")}
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{t("backups.destination.disconnectConfirm")}</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmRemove(false);
                      void run("rm", "/api/backups/destination", { method: "DELETE" });
                    }}
                  >
                    {t("backups.destination.disconnectYes")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
                    {t("backups.action.no")}
                  </Button>
                </span>
              )}
            </div>
          </>
        )}

        {showForm && (
          <>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="bk-provider"
                  className="accent-sky-600"
                  checked={provider === "r2"}
                  onChange={() => {
                    setProvider("r2");
                    setRegion("auto");
                  }}
                />
                {t("backups.provider.r2")} <Badge variant="success">{t("backups.destination.recommended")}</Badge>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="bk-provider"
                  className="accent-sky-600"
                  checked={provider === "s3"}
                  onChange={() => {
                    setProvider("s3");
                    if (region === "auto") setRegion("");
                  }}
                />
                {t("backups.destination.otherS3")}
              </label>
            </div>
            {provider === "r2" ? (
              <>
                <p className="text-muted-foreground">{t("backups.destination.r2Names")}</p>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  {R2_STEPS.map((k) => (
                    <li key={k}>
                      <Trans k={k} components={{ b: <strong className="text-foreground" /> }} />
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-muted-foreground">{t("backups.destination.s3Help")}</p>
            )}
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label htmlFor="bk-endpoint" className="font-medium">
                  {t("backups.destination.endpoint")}
                </label>
                <Input
                  id="bk-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={provider === "r2" ? t("backups.destination.endpointPlaceholderR2") : t("backups.destination.endpointPlaceholderS3")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-bucket" className="font-medium">
                  {t("backups.destination.bucket")}
                </label>
                <Input id="bk-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="tws-backups" autoComplete="off" spellCheck={false} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-region" className="font-medium">
                  {t("backups.destination.region")}
                </label>
                <Input id="bk-region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder={provider === "r2" ? "auto" : "us-east-1"} autoComplete="off" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-access" className="font-medium">
                  {t("backups.destination.accessKey")}
                </label>
                <Input
                  id="bk-access"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-secret" className="font-medium">
                  {t("backups.destination.secretKey")}
                </label>
                <PasswordInput
                  id="bk-secret"
                  revealLabel={t("backups.destination.secretReveal")}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={d ? t("backups.destination.secretPlaceholder") : ""}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy !== null || !endpoint.trim() || !bucket.trim() || !accessKeyId.trim() || (!secret && !d)}>
                  {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.destination.testAndSave")}
                </Button>
                {editing && (
                  <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                    {t("backups.action.cancel")}
                  </Button>
                )}
              </div>
            </form>
            <p className="text-xs text-muted-foreground">{t("backups.destination.note")}</p>
          </>
        )}
        <Feedback error={error} notice={notice} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Criptografia e senha
// ---------------------------------------------------------------------------

function reminderDue(status: BackupsStatus): boolean {
  const e = status.encryption;
  if (!e.passwordSet || !status.destination) return false;
  if (e.lastTestOk === false) return true;
  const ref = Math.max(e.passwordSetAt ? Date.parse(e.passwordSetAt) : 0, e.lastTestOk && e.lastTestAt ? Date.parse(e.lastTestAt) : 0);
  return Date.now() - ref > BACKUP_PASSWORD_REMINDER_DAYS * 24 * 3_600_000;
}

function TestPassword({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setResult(null);
        apiFetch<{ ok: boolean; message: string }>("/api/backups/password/test", { method: "POST", body: JSON.stringify({ password: pw }) })
          .then((r) => {
            setResult(r);
            if (r.ok) setPw("");
            onDone();
          })
          .catch((err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="bk-test-pw" className="font-medium">
        {t("backups.testPassword.label")}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <PasswordInput id="bk-test-pw" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} containerClassName="min-w-0 flex-1" />
        <Button type="submit" variant="outline" disabled={!pw || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.testPassword.button")}
        </Button>
      </div>
      {result && <p className={result.ok ? "text-emerald-400" : "text-amber-400"}>{result.message}</p>}
      <Feedback error={error} notice={null} />
    </form>
  );
}

function RevealPassword({ status }: { status: BackupsStatus }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <KeyRound className="h-4 w-4" /> {t("backups.reveal.button")}
        </Button>
      </div>
    );
  }
  if (revealed) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="revealed-password">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-muted px-2 py-1 font-mono text-sm">{revealed}</code>
          <CopyButton text={revealed} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="info" size="sm" onClick={() => downloadRecoveryKit(revealed, status)}>
            <Download className="h-4 w-4" /> {t("backups.password.downloadKit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRevealed(null);
              setOpen(false);
            }}
          >
            {t("backups.reveal.hide")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        apiFetch<{ password: string }>("/api/backups/password/reveal", { method: "POST", body: JSON.stringify({ loginPassword: login }) })
          .then((r) => {
            setRevealed(r.password);
            setLogin("");
          })
          .catch((err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="bk-login-pw" className="font-medium">
        {t("backups.reveal.label")}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <PasswordInput id="bk-login-pw" autoComplete="current-password" value={login} onChange={(e) => setLogin(e.target.value)} containerClassName="min-w-0 flex-1" />
        <Button type="submit" disabled={!login || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.reveal.button")}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          {t("backups.action.cancel")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("backups.reveal.note")}</p>
      <Feedback error={error} notice={null} />
    </form>
  );
}

function EncryptionCard({ status, onStatus, reload }: { status: BackupsStatus; onStatus: OnStatus; reload: () => void }) {
  const { t } = useI18n();
  const e = status.encryption;
  const [changing, setChanging] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      onStatus(await apiFetch<BackupsStatus>("/api/backups/encryption", { method: "PUT", body: JSON.stringify({ enabled }) }));
      setConfirmOff(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="encryption-card" className={e.enabled && !e.passwordSet ? "border-amber-500/50" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4 text-emerald-400" /> {t("backups.encryption.title")}
        </CardTitle>
        <CardDescription>{t("backups.encryption.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {e.enabled ? <Badge variant="success">{t("backups.encryption.on")}</Badge> : <Badge variant="warning">{t("backups.encryption.off")}</Badge>}
          {e.enabled && e.passwordSet && e.passwordSetAt && <span className="text-muted-foreground">{t("backups.encryption.passwordSetAt", { when: when(e.passwordSetAt) })}</span>}
          {e.lastTestAt && (
            <Badge variant={e.lastTestOk ? "success" : "warning"}>
              {e.lastTestOk
                ? t("backups.encryption.testedAt", { when: when(e.lastTestAt) })
                : t("backups.encryption.testFailedAt", { when: when(e.lastTestAt) })}
            </Badge>
          )}
        </div>

        {e.enabled && !e.passwordSet && (
          <PasswordSetup status={status} changing={false} onSaved={onStatus} />
        )}
        {e.enabled && e.passwordSet && changing && (
          <PasswordSetup
            status={status}
            changing
            onSaved={(s) => {
              setChanging(false);
              onStatus(s);
            }}
            onCancel={() => setChanging(false)}
          />
        )}
        {e.enabled && e.passwordSet && !changing && (
          <>
            {!status.destination && (
              <p className="text-muted-foreground">{t("backups.encryption.connectFirst")}</p>
            )}
            {status.destination && <TestPassword onDone={reload} />}
            <RevealPassword status={status} />
            <div>
              <Button variant="outline" onClick={() => setChanging(true)}>
                {t("backups.password.change")}
              </Button>
            </div>
          </>
        )}

        {!e.enabled && (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-2 text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t("backups.encryption.offWarning")}
            </p>
            <div>
              <Button onClick={() => void setEnabled(true)} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.encryption.turnOn")}
              </Button>
            </div>
          </div>
        )}
        {e.enabled && !changing && (
          <div className="flex flex-wrap items-center gap-2">
            {!confirmOff ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
                {t("backups.encryption.turnOff")}
              </Button>
            ) : (
              <>
                <span className="text-muted-foreground">{t("backups.encryption.turnOffConfirm")}</span>
                <Button variant="danger" size="sm" onClick={() => void setEnabled(false)} disabled={busy}>
                  {t("backups.encryption.turnOffYes")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmOff(false)}>
                  {t("backups.action.no")}
                </Button>
              </>
            )}
          </div>
        )}
        <Feedback error={error} notice={null} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Painel e e-mail
// ---------------------------------------------------------------------------

function LastBackup({ target }: { target: BackupTargetStatus }) {
  const { t } = useI18n();
  const last = target.lastBackup;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{t("backups.lastBackup.label")}</span>
        {last ? (
          <>
            <RecordBadge record={last} />
            <span>{when(last.finishedAt ?? last.queuedAt)}</span>
          </>
        ) : (
          <span>{t("backups.lastBackup.none")}</span>
        )}
      </div>
      {last?.error && <p className="text-xs text-red-400">{last.error}</p>}
      {last?.remoteDetail && <p className="text-xs text-amber-400">{last.remoteDetail}</p>}
      {target.lastRemoteVerifiedAt && (
        <p className="text-xs text-muted-foreground">{t("backups.lastBackup.remoteVerified", { when: when(target.lastRemoteVerifiedAt) })}</p>
      )}
      {target.nextRunAt && <p className="text-xs text-muted-foreground">{t("backups.lastBackup.next", { when: when(target.nextRunAt) })}</p>}
    </div>
  );
}

function RunNowButton({ targetId, onQueued, disabled }: { targetId: string; onQueued: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="info"
        disabled={busy || disabled}
        onClick={() => {
          setBusy(true);
          setError(null);
          apiFetch<BackupRecord>(`/api/backups/targets/${targetId}/run`, { method: "POST" })
            .then(onQueued)
            .catch((err: unknown) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} {t("backups.action.backupNow")}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function TargetCard({
  target,
  status,
  reload,
  onRestore,
  description,
  icon,
}: {
  target: BackupTargetStatus;
  status: BackupsStatus;
  reload: () => void;
  onRestore: (t: RestoreTarget) => void;
  description: string;
  icon: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card data-testid={`target-${target.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {target.name}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!target.available ? (
          <p className="text-sm text-muted-foreground">
            {t("backups.target.mailMissing")}{" "}
            <Link to="/mail" className="underline underline-offset-2">
              {t("backups.target.openMail")}
            </Link>
          </p>
        ) : (
          <>
            <TargetSettings
              key={`${target.enabled}-${target.frequencyHours}-${target.localKeep}-${target.remoteKeep}`}
              target={target}
              remote={status.destination !== null}
              timezone={status.timezone}
              backupHour={status.backupHour}
              onSaved={reload}
            />
            <LastBackup target={target} />
            <div className="flex flex-wrap gap-2">
              <RunNowButton targetId={target.id} onQueued={reload} disabled={!status.archiverAvailable} />
              <Button variant="outline" onClick={() => onRestore({ id: target.id, kind: target.kind, name: target.name })}>
                <RotateCcw className="h-4 w-4" /> {t("backups.action.restore")}
              </Button>
              <VerifyAllButton target={target.id} onQueued={reload} disabled={!status.archiverAvailable || !target.lastBackup} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function settingsText(target: BackupTargetStatus): string {
  if (target.followsDefaults !== false) return t("backups.settings.followsDefaults");
  const frequency = target.enabled ? t("backups.settings.freqEvery", { hours: target.frequencyHours }) : t("backups.settings.off");
  return t("backups.settings.own", { frequency, local: target.localKeep, remote: target.remoteKeep });
}

/**
 * "Padrão dos projetos": com o que um projeto novo nasce. Quem segue o padrão
 * muda junto. "Aplicar também nestes projetos" copia o padrão para os marcados,
 * que passam a seguir o padrão. Itens marcados no backup não mudam.
 */
function DefaultsCard({ status, reload }: { status: BackupsStatus; reload: () => void }) {
  const { t } = useI18n();
  const projects = status.targets.filter((t) => t.kind === "project");
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setMarked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function save(settings: BackupsStatus["projectDefaults"], changed: boolean): Promise<string> {
    const parts: string[] = [];
    if (changed) {
      await apiFetch("/api/backups/defaults", { method: "PUT", body: JSON.stringify(settings) });
      parts.push(t("backups.defaults.saved"));
    }
    if (marked.size > 0) {
      const ids = projects.filter((p) => marked.has(p.id)).map((p) => p.id.slice("project:".length));
      const r = await apiFetch<BackupApplyDefaultsResult>("/api/backups/defaults/apply", {
        method: "POST",
        body: JSON.stringify({ projectIds: ids }),
      });
      const names = r.applied.map((a) => a.name).join(", ");
      parts.push(changed ? t("backups.defaults.appliedAlso", { names }) : t("backups.defaults.applied", { names }));
      setMarked(new Set());
    }
    return parts.join(" ");
  }

  const list =
    projects.length > 0 ? (
      <fieldset className="flex flex-col gap-2" data-testid="defaults-projects">
        <legend className="mb-1 font-medium">{t("backups.defaults.applyTitle")}</legend>
        <p className="text-xs text-muted-foreground">{t("backups.defaults.applyHint")}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setMarked(new Set(projects.map((p) => p.id)))}>
            {t("backups.defaults.markAll")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMarked(new Set())}>
            {t("backups.defaults.markNone")}
          </Button>
        </div>
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={marked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                <span className="min-w-0 break-words">
                  {p.name} <span className="text-xs text-muted-foreground">{t("backups.defaults.today", { settings: settingsText(p) })}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    ) : undefined;

  return (
    <Card data-testid="defaults-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4 text-sky-400" /> {t("backups.defaults.title")}
        </CardTitle>
        <CardDescription>{t("backups.defaults.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <TargetSettings
          target={{ id: "defaults", ...status.projectDefaults }}
          remote={status.destination !== null}
          timezone={status.timezone}
          backupHour={status.backupHour}
          onSaved={reload}
          onSave={save}
          extra={list}
          extraDirty={marked.size > 0}
        />
      </CardContent>
    </Card>
  );
}

function ProjectsCard({ status }: { status: BackupsStatus }) {
  const { t } = useI18n();
  const projects = status.targets.filter((t) => t.kind === "project");
  return (
    <Card data-testid="projects-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4 text-violet-400" /> {t("backups.projects.title")}
        </CardTitle>
        <CardDescription>{t("backups.projects.description")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {projects.length === 0 ? (
          <p className="text-muted-foreground">{t("backups.projects.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 font-medium">{p.name}</span>
                {!p.enabled && <Badge variant="secondary">{t("backups.projects.off")}</Badge>}
                {p.lastBackup ? <RecordBadge record={p.lastBackup} /> : <span className="text-muted-foreground">{t("backups.projects.noBackup")}</span>}
                <Button asChild variant="outline" size="sm">
                  <Link to={`/projects/${p.id.slice("project:".length)}/backups`}>{t("backups.action.open")}</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Restaurar de outro servidor (VPS nova)
// ---------------------------------------------------------------------------

function OtherServerCard({ status, onStatus, onRestore }: { status: BackupsStatus; onStatus: OnStatus; onRestore: (t: RestoreTarget, opts: { points: BackupCatalog["panel"]; redeploy?: boolean }) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noCheckFile, setNoCheckFile] = useState(false);
  const [catalog, setCatalog] = useState<BackupCatalog | null>(null);
  const needsPassword = status.encryption.enabled && !status.encryption.passwordSet;

  async function savePassword(skipTest: boolean) {
    setBusy("pw");
    setError(null);
    try {
      if (!skipTest) {
        const r = await apiFetch<{ ok: boolean; message: string }>("/api/backups/password/test", { method: "POST", body: JSON.stringify({ password: pw }) });
        if (!r.ok) {
          setError(t("backups.other.wrongPassword"));
          return;
        }
      }
      onStatus(await apiFetch<BackupsStatus>("/api/backups/password", { method: "PUT", body: JSON.stringify({ password: pw, acknowledged: true }) }));
      setPw("");
      setNoCheckFile(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "no_check_file") setNoCheckFile(true);
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function list() {
    setBusy("list");
    setError(null);
    try {
      setCatalog(await apiFetch<BackupCatalog>("/api/backups/catalog"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="other-server-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-sky-400" /> {t("backups.other.title")}
        </CardTitle>
        <CardDescription>{t("backups.other.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!open ? (
          <div>
            <Button variant="outline" onClick={() => setOpen(true)}>
              {t("backups.other.start")}
            </Button>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            <li className="flex flex-col gap-1">
              <span className="font-medium">{t("backups.other.step1")}</span>
              {status.destination ? (
                <span className="text-emerald-400">{t("backups.other.connected", { bucket: status.destination.bucket })}</span>
              ) : (
                <span className="text-muted-foreground">{t("backups.other.connectAbove")}</span>
              )}
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-medium">{t("backups.other.step2")}</span>
              {!needsPassword ? (
                <span className="text-muted-foreground">
                  {status.encryption.enabled ? t("backups.other.passwordSet") : t("backups.other.encryptionOff")}
                </span>
              ) : (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void savePassword(false);
                  }}
                >
                  <label htmlFor="bk-old-pw" className="text-muted-foreground">
                    {t("backups.other.oldPasswordLabel")}
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <PasswordInput id="bk-old-pw" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} containerClassName="min-w-0 flex-1" />
                    <Button type="submit" disabled={!pw || !status.destination || busy !== null}>
                      {busy === "pw" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.other.checkAndUse")}
                    </Button>
                  </div>
                  {noCheckFile && (
                    <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void savePassword(true)}>
                      {t("backups.other.useAnyway")}
                    </Button>
                  )}
                </form>
              )}
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-medium">{t("backups.other.step3")}</span>
              <div>
                <Button variant="info" onClick={() => void list()} disabled={!status.destination || busy !== null}>
                  {busy === "list" && <Loader2 className="h-4 w-4 animate-spin" />} {t("backups.other.listStorage")}
                </Button>
              </div>
              {catalog && (
                <div className="flex flex-col gap-3" data-testid="catalog">
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">
                      {t("backups.target.panelName")}{" "}
                      {catalog.panel.length > 0 && (
                        <span className="text-muted-foreground">
                          {t("backups.other.panelDates", { count: catalog.panel.length, when: when(catalog.panel[0]!.at) })}
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground">{t("backups.other.panelHelp")}</p>
                    {catalog.panel.length > 0 ? (
                      <Button size="sm" className="mt-2" onClick={() => onRestore({ id: "panel", kind: "panel", name: t("backups.target.panelName") }, { points: catalog.panel })}>
                        {t("backups.other.restorePanel")}
                      </Button>
                    ) : (
                      <p className="text-amber-400">{t("backups.other.noPanel")}</p>
                    )}
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">{t("backups.projects.title")}</p>
                    <p className="text-muted-foreground">{t("backups.other.projectsHelp")}</p>
                    {catalog.projects.length === 0 && <p className="text-amber-400">{t("backups.other.noProjects")}</p>}
                    <ul className="mt-2 flex flex-col gap-2">
                      {catalog.projects.map((p) => (
                        <li key={p.folder} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {p.projectName ?? p.folder} <span className="text-muted-foreground">{t("backups.other.projectDates", { count: p.points.length })}</span>
                          </span>
                          {p.projectId ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                onRestore({ id: `project:${p.projectId}`, kind: "project", name: p.projectName ?? p.folder }, { points: p.points, redeploy: true })
                              }
                            >
                              {t("backups.action.restore")}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("backups.other.notRegistered")}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">{t("backups.target.emailName")}</p>
                    <p className="text-muted-foreground">{t("backups.other.emailHelp")}</p>
                    {catalog.email.length > 0 ? (
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => onRestore({ id: "email", kind: "email", name: t("backups.target.emailName") }, { points: catalog.email })}>
                        {t("backups.other.restoreEmail")}
                      </Button>
                    ) : (
                      <p className="text-muted-foreground">{t("backups.other.noEmail")}</p>
                    )}
                  </div>
                </div>
              )}
            </li>
          </ol>
        )}
        <Feedback error={error} notice={null} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export function BackupSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BackupsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ target: RestoreTarget; points?: BackupCatalog["panel"]; redeploy?: boolean } | null>(null);

  const load = useCallback(() => {
    apiFetch<BackupsStatus>("/api/backups")
      .then((s) => {
        setStatus(s);
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  useEffect(load, [load]);

  // Com algo rodando ou na fila, acompanha a cada 3 s.
  const busy = Boolean(status && (status.running || status.queued.length > 0));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const panel = status?.targets.find((t) => t.id === "panel");
  const email = status?.targets.find((t) => t.id === "email");

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("backups.page.intro")}</p>
      {loadError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            {t("backups.action.retry")}
          </Button>
        </div>
      )}
      {!status && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {status && (
        <>
          {!status.archiverAvailable && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t("backups.page.noArchiver")}
            </p>
          )}
          {reminderDue(status) && (
            <p data-testid="reminder" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> {t("backups.page.reminder")}
            </p>
          )}
          {status.running && (
            <p className="flex items-center gap-2 text-sm text-sky-300">
              <Loader2 className="h-4 w-4 animate-spin" />{" "}
              {status.running.operation === "restore"
                ? t("backups.running.restore", { name: status.running.targetName })
                : status.running.operation === "verify"
                  ? status.running.target === "all"
                    ? t("backups.running.verifyAll")
                    : t("backups.running.verify", { name: status.running.targetName })
                  : t("backups.running.backup", { name: status.running.targetName })}
              {status.queued.length > 0 && t("backups.running.queued", { count: status.queued.length })}.
            </p>
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <DestinationCard status={status} onStatus={setStatus} />
            <EncryptionCard status={status} onStatus={setStatus} reload={load} />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            {panel && (
              <TargetCard
                target={panel}
                status={status}
                reload={load}
                onRestore={(target) => setRestore({ target })}
                icon={<ShieldCheck className="h-4 w-4 text-sky-400" />}
                description={t("backups.target.panelDescription")}
              />
            )}
            {email && (
              <TargetCard
                target={email}
                status={status}
                reload={load}
                onRestore={(target) => setRestore({ target })}
                icon={<Mail className="h-4 w-4 text-violet-400" />}
                description={t("backups.target.emailDescription")}
              />
            )}
          </div>
          <DefaultsCard status={status} reload={load} />
          <ProjectsCard status={status} />
          <OtherServerCard
            status={status}
            onStatus={setStatus}
            onRestore={(target, opts) => setRestore({ target, points: opts.points, redeploy: opts.redeploy })}
          />
          <Card data-testid="backup-history">
            <CardHeader>
              <CardTitle className="text-base">{t("backups.history.title")}</CardTitle>
              <CardDescription>
                <Trans k="backups.history.description" params={{ localPath: status.localPath }} components={{ path: <span className="break-all" /> }} />
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <VerifyAllButton target="all" onQueued={load} label={t("backups.history.verifyAll")} disabled={!status.archiverAvailable} />
              </div>
              <BackupTimezoneNote status={status} />
              <HistoryList records={status.history.slice(0, 30)} empty={t("backups.history.empty")} onVerify={load} />
            </CardContent>
          </Card>
        </>
      )}
      {restore && (
        <RestoreDialog
          target={restore.target}
          points={restore.points}
          allowRedeploy={restore.target.kind === "project"}
          defaultRedeploy={restore.redeploy}
          onClose={() => setRestore(null)}
          onFinished={load}
        />
      )}
    </div>
  );
}
