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

const PROVIDER_LABEL: Record<BackupProvider, string> = { r2: "Cloudflare R2", s3: "Compatível com S3" };

function DestinationCard({ status, onStatus }: { status: BackupsStatus; onStatus: OnStatus }) {
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
    const ok = await run("save", "/api/backups/destination", { method: "PUT", body: JSON.stringify(body) }, "Conexão testada e salva.");
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
          <CloudUpload className="h-4 w-4 text-sky-400" /> Armazenamento externo
        </CardTitle>
        <CardDescription>
          Uma cópia fora da VPS: se o servidor for perdido, os backups continuam lá. A cópia na VPS é sempre feita, sem senha, com
          as mais recentes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {d && !editing && (
          <>
            <p className="break-words">
              Conectado ao <strong>{PROVIDER_LABEL[d.provider]}</strong>: bucket <strong>{d.bucket}</strong> em{" "}
              <span className="break-all text-muted-foreground">{d.endpoint}</span> (chave de acesso {d.accessKeyHint}).
            </p>
            <p className="text-muted-foreground">
              Os arquivos ficam em <code className="text-foreground">{BACKUP_ROOT_FOLDER}/</code>, uma pasta por projeto, mais{" "}
              <code className="text-foreground">_painel/</code> e <code className="text-foreground">_email/</code>.
            </p>
            <div>{d.testedAt ? <Badge variant="success">Testado em {when(d.testedAt)}</Badge> : <Badge variant="warning">Falta testar</Badge>}</div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="info"
                onClick={() => void run("test", "/api/backups/destination/test", { method: "POST" }, "Conexão funcionando: o painel gravou, leu e apagou um arquivo de teste.")}
                disabled={busy !== null}
              >
                {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Testar conexão
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
                Editar
              </Button>
              {!confirmRemove ? (
                <Button variant="outline" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                  Desconectar
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Parar de enviar para fora? Os backups que já estão lá continuam lá.</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmRemove(false);
                      void run("rm", "/api/backups/destination", { method: "DELETE" });
                    }}
                  >
                    Sim, desconectar
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
                    Não
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
                Cloudflare R2 <Badge variant="success">Recomendado</Badge>
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
                Outro compatível com S3 (Backblaze B2, Contabo, MinIO, Amazon S3…)
              </label>
            </div>
            {provider === "r2" ? (
              <>
                <p className="text-muted-foreground">
                  Os nomes aparecem em inglês ou em português, conforme o idioma da sua conta na Cloudflare: os dois vêm abaixo (inglês /
                  português).
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>
                    No painel da Cloudflare, abra <strong className="text-foreground">R2 Object Storage</strong> / <strong className="text-foreground">Armazenamento de objetos R2</strong>. Na primeira vez, ative o R2 (o plano
                    gratuito cobre 10 GB por mês).
                  </li>
                  <li>
                    Clique em <strong className="text-foreground">Create bucket</strong> / <strong className="text-foreground">Criar bucket</strong>, dê um nome (ex.: tws-backups) e crie.
                  </li>
                  <li>
                    Na página do R2, no canto direito, ache <strong className="text-foreground">API Tokens</strong> / <strong className="text-foreground">Tokens de API</strong> e clique em <strong className="text-foreground">Manage</strong> / <strong className="text-foreground">Gerenciar</strong>. Depois, em 
                    <strong className="text-foreground">Create Account API token</strong> / <strong className="text-foreground">Criar token de API da conta</strong> (ou o de usuário, se só ele aparecer).
                  </li>
                  <li>
                    No formulário: um nome (ex.: tws-panel-backups); em Permissions / Permissões, 
                    <strong className="text-foreground">Object Read &amp; Write</strong> / <strong className="text-foreground">Leitura e gravação de objetos</strong>; em Specify bucket(s) / Especificar bucket(s), 
                    <strong className="text-foreground">Apply to specific buckets only</strong> / <strong className="text-foreground">Aplicar somente a buckets específicos</strong> e escolha o bucket; TTL 
                    <strong className="text-foreground">Forever</strong> / <strong className="text-foreground">Para sempre</strong>. Confirme no botão de criar o token, no fim da página.
                  </li>
                  <li>
                    A tela seguinte mostra as chaves uma única vez. Copie a <strong className="text-foreground">Access Key ID</strong> / <strong className="text-foreground">ID da chave de acesso</strong>, a 
                    <strong className="text-foreground">Secret Access Key</strong> / <strong className="text-foreground">Chave de acesso secreta</strong> e o endpoint que termina em .r2.cloudflarestorage.com (o “Token value” /
                    “Valor do token” não é usado). Perdeu o endpoint? Ele fica no bucket → Settings / Configurações → S3 API.
                  </li>
                  <li>Cole tudo aqui, com a região auto, e clique em Testar e salvar.</li>
                </ol>
              </>
            ) : (
              <p className="text-muted-foreground">
                Use os dados do seu provedor: o endpoint (ex.: https://s3.us-west-004.backblazeb2.com ou https://eu2.contabostorage.com), a
                região (se ele pedir), o bucket e um par de chaves com permissão de ler e gravar nesse bucket.
              </p>
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
                  Endpoint
                </label>
                <Input
                  id="bk-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={provider === "r2" ? "https://<id-da-conta>.r2.cloudflarestorage.com" : "https://s3.exemplo.com"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-bucket" className="font-medium">
                  Bucket
                </label>
                <Input id="bk-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="tws-backups" autoComplete="off" spellCheck={false} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-region" className="font-medium">
                  Região
                </label>
                <Input id="bk-region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder={provider === "r2" ? "auto" : "us-east-1"} autoComplete="off" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="bk-access" className="font-medium">
                  Access Key ID
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
                  Secret Access Key
                </label>
                <PasswordInput
                  id="bk-secret"
                  revealLabel="chave secreta"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={d ? "deixe vazio para manter a guardada" : ""}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy !== null || !endpoint.trim() || !bucket.trim() || !accessKeyId.trim() || (!secret && !d)}>
                  {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Testar e salvar
                </Button>
                {editing && (
                  <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                )}
              </div>
            </form>
            <p className="text-xs text-muted-foreground">
              O painel testa a conexão antes de salvar (grava, lê e apaga um arquivo pequeno). A chave secreta fica guardada cifrada e não
              volta para a tela.
            </p>
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
        Testar minha senha
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <PasswordInput id="bk-test-pw" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} containerClassName="min-w-0 flex-1" />
        <Button type="submit" variant="outline" disabled={!pw || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Testar
        </Button>
      </div>
      {result && <p className={result.ok ? "text-emerald-400" : "text-amber-400"}>{result.message}</p>}
      <Feedback error={error} notice={null} />
    </form>
  );
}

function RevealPassword({ status }: { status: BackupsStatus }) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <KeyRound className="h-4 w-4" /> Ver a senha
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
            <Download className="h-4 w-4" /> Baixar kit de recuperação
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRevealed(null);
              setOpen(false);
            }}
          >
            Esconder
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
        Confirme a sua senha de login para ver a senha dos backups
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <PasswordInput id="bk-login-pw" autoComplete="current-password" value={login} onChange={(e) => setLogin(e.target.value)} containerClassName="min-w-0 flex-1" />
        <Button type="submit" disabled={!login || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ver a senha
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Fica registrado na Auditoria. Depois de várias tentativas erradas, espere 15 minutos.</p>
      <Feedback error={error} notice={null} />
    </form>
  );
}

function EncryptionCard({ status, onStatus, reload }: { status: BackupsStatus; onStatus: OnStatus; reload: () => void }) {
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
          <Lock className="h-4 w-4 text-emerald-400" /> Criptografia da cópia externa
        </CardTitle>
        <CardDescription>
          Seus backups podem ter dados pessoais de clientes. Cifrar a cópia que sai da VPS protege esses dados (LGPD) se alguém tiver
          acesso ao armazenamento. A cópia na VPS fica sem senha, para restaurar rápido.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {e.enabled ? <Badge variant="success">Ligada (AES-256)</Badge> : <Badge variant="warning">Desligada</Badge>}
          {e.enabled && e.passwordSet && e.passwordSetAt && <span className="text-muted-foreground">Senha definida em {when(e.passwordSetAt)}.</span>}
          {e.lastTestAt && (
            <Badge variant={e.lastTestOk ? "success" : "warning"}>
              {e.lastTestOk ? "Senha testada" : "Último teste não abriu"} em {when(e.lastTestAt)}
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
              <p className="text-muted-foreground">Conecte o armazenamento externo acima para os backups cifrados começarem a sair da VPS.</p>
            )}
            {status.destination && <TestPassword onDone={reload} />}
            <RevealPassword status={status} />
            <div>
              <Button variant="outline" onClick={() => setChanging(true)}>
                Trocar a senha
              </Button>
            </div>
          </>
        )}

        {!e.enabled && (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-2 text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> A cópia externa vai sem senha: quem tiver acesso ao armazenamento consegue
              abrir os backups.
            </p>
            <div>
              <Button onClick={() => void setEnabled(true)} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ligar a criptografia
              </Button>
            </div>
          </div>
        )}
        {e.enabled && !changing && (
          <div className="flex flex-wrap items-center gap-2">
            {!confirmOff ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
                Desligar a criptografia
              </Button>
            ) : (
              <>
                <span className="text-muted-foreground">Os próximos backups externos vão sem senha. Desligar mesmo assim?</span>
                <Button variant="danger" size="sm" onClick={() => void setEnabled(false)} disabled={busy}>
                  Sim, desligar
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmOff(false)}>
                  Não
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
  const last = target.lastBackup;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Último backup:</span>
        {last ? (
          <>
            <RecordBadge record={last} />
            <span>{when(last.finishedAt ?? last.queuedAt)}</span>
          </>
        ) : (
          <span>nenhum ainda</span>
        )}
      </div>
      {last?.error && <p className="text-xs text-red-400">{last.error}</p>}
      {last?.remoteDetail && <p className="text-xs text-amber-400">{last.remoteDetail}</p>}
      {target.lastRemoteVerifiedAt && (
        <p className="text-xs text-muted-foreground">Última cópia externa conferida: {when(target.lastRemoteVerifiedAt)}.</p>
      )}
      {target.nextRunAt && <p className="text-xs text-muted-foreground">Próximo: {when(target.nextRunAt)}.</p>}
    </div>
  );
}

function RunNowButton({ targetId, onQueued, disabled }: { targetId: string; onQueued: () => void; disabled?: boolean }) {
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
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />} Fazer backup agora
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
            O servidor de e-mail não está instalado nesta VPS.{" "}
            <Link to="/mail" className="underline underline-offset-2">
              Abrir E-mail
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
                <RotateCcw className="h-4 w-4" /> Restaurar
              </Button>
              <VerifyAllButton target={target.id} onQueued={reload} disabled={!status.archiverAvailable || !target.lastBackup} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function settingsText(t: BackupTargetStatus): string {
  if (t.followsDefaults !== false) return "segue o padrão";
  const freq = t.enabled ? `a cada ${t.frequencyHours} h` : "desligado";
  return `configuração própria (${freq}, ${t.localKeep} na VPS, ${t.remoteKeep} fora)`;
}

/**
 * "Padrão dos projetos": com o que um projeto novo nasce. Quem segue o padrão
 * muda junto. "Aplicar também nestes projetos" copia o padrão para os marcados,
 * que passam a seguir o padrão. Itens marcados no backup não mudam.
 */
function DefaultsCard({ status, reload }: { status: BackupsStatus; reload: () => void }) {
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
      parts.push("Padrão salvo.");
    }
    if (marked.size > 0) {
      const ids = projects.filter((p) => marked.has(p.id)).map((p) => p.id.slice("project:".length));
      const r = await apiFetch<BackupApplyDefaultsResult>("/api/backups/defaults/apply", {
        method: "POST",
        body: JSON.stringify({ projectIds: ids }),
      });
      const names = r.applied.map((a) => a.name).join(", ");
      parts.push(changed ? `Aplicado em: ${names}.` : `Padrão aplicado em: ${names}.`);
      setMarked(new Set());
    }
    return parts.join(" ");
  }

  const list =
    projects.length > 0 ? (
      <fieldset className="flex flex-col gap-2" data-testid="defaults-projects">
        <legend className="mb-1 font-medium">Aplicar também nestes projetos</legend>
        <p className="text-xs text-muted-foreground">
          Os marcados recebem o padrão e passam a segui-lo. Os outros mantêm o que têm.
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setMarked(new Set(projects.map((p) => p.id)))}>
            Marcar todos
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMarked(new Set())}>
            Nenhum
          </Button>
        </div>
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={marked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                <span className="min-w-0 break-words">
                  {p.name} <span className="text-xs text-muted-foreground">— hoje: {settingsText(p)}</span>
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
          <Server className="h-4 w-4 text-sky-400" /> Padrão dos projetos
        </CardTitle>
        <CardDescription>
          Projeto novo nasce com este padrão. Quem segue o padrão muda junto. Um projeto passa a ter configuração própria quando você salva
          na aba Backups dele. Os bancos e as pastas escolhidos não mudam.
        </CardDescription>
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
  const projects = status.targets.filter((t) => t.kind === "project");
  return (
    <Card data-testid="projects-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4 text-violet-400" /> Projetos
        </CardTitle>
        <CardDescription>
          Cada projeto tem a sua aba Backups: lá você escolhe os bancos e as pastas, a frequência e restaura. O código vem do GitHub e não
          entra no backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {projects.length === 0 ? (
          <p className="text-muted-foreground">Nenhum projeto ainda.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 font-medium">{p.name}</span>
                {!p.enabled && <Badge variant="secondary">Desligado</Badge>}
                {p.lastBackup ? <RecordBadge record={p.lastBackup} /> : <span className="text-muted-foreground">sem backup ainda</span>}
                <Button asChild variant="outline" size="sm">
                  <Link to={`/projects/${p.id.slice("project:".length)}/backups`}>Abrir</Link>
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
          setError("Essa senha não abre os backups deste armazenamento. Confira o kit de recuperação da VPS antiga.");
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
          <ShieldCheck className="h-4 w-4 text-sky-400" /> Restaurar de outro servidor
        </CardTitle>
        <CardDescription>Para quando você instalou o painel numa VPS nova e quer trazer tudo da antiga, a partir do armazenamento externo.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!open ? (
          <div>
            <Button variant="outline" onClick={() => setOpen(true)}>
              Começar
            </Button>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            <li className="flex flex-col gap-1">
              <span className="font-medium">1. Conecte o mesmo armazenamento</span>
              {status.destination ? (
                <span className="text-emerald-400">
                  Conectado: bucket {status.destination.bucket}. Se for outro bucket, use Editar no cartão Armazenamento externo.
                </span>
              ) : (
                <span className="text-muted-foreground">
                  No cartão Armazenamento externo, acima, informe o mesmo endpoint, bucket e chaves que a VPS antiga usava.
                </span>
              )}
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-medium">2. Informe a senha dos backups</span>
              {!needsPassword ? (
                <span className="text-muted-foreground">
                  {status.encryption.enabled ? "Senha já definida neste painel." : "Criptografia desligada: os backups abrem sem senha."}
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
                    A mesma senha da VPS antiga (está no kit de recuperação).
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <PasswordInput id="bk-old-pw" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} containerClassName="min-w-0 flex-1" />
                    <Button type="submit" disabled={!pw || !status.destination || busy !== null}>
                      {busy === "pw" && <Loader2 className="h-4 w-4 animate-spin" />} Conferir e usar
                    </Button>
                  </div>
                  {noCheckFile && (
                    <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void savePassword(true)}>
                      Usar esta senha mesmo assim
                    </Button>
                  )}
                </form>
              )}
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-medium">3. Restaure na ordem: painel, projetos, e-mail</span>
              <div>
                <Button variant="info" onClick={() => void list()} disabled={!status.destination || busy !== null}>
                  {busy === "list" && <Loader2 className="h-4 w-4 animate-spin" />} Ver o que existe no armazenamento
                </Button>
              </div>
              {catalog && (
                <div className="flex flex-col gap-3" data-testid="catalog">
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">Painel {catalog.panel.length > 0 && <span className="text-muted-foreground">({catalog.panel.length} data(s), a mais recente em {when(catalog.panel[0]!.at)})</span>}</p>
                    <p className="text-muted-foreground">
                      Primeiro. Traz usuários, projetos cadastrados e configurações. O painel reinicia; entre de novo com o usuário e a senha da
                      VPS antiga e volte aqui.
                    </p>
                    {catalog.panel.length > 0 ? (
                      <Button size="sm" className="mt-2" onClick={() => onRestore({ id: "panel", kind: "panel", name: "Painel" }, { points: catalog.panel })}>
                        Restaurar o painel
                      </Button>
                    ) : (
                      <p className="text-amber-400">Nenhum backup do painel no armazenamento.</p>
                    )}
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">Projetos</p>
                    <p className="text-muted-foreground">O painel publica cada projeto do GitHub e depois põe os bancos e as pastas de volta.</p>
                    {catalog.projects.length === 0 && <p className="text-amber-400">Nenhum backup de projeto no armazenamento.</p>}
                    <ul className="mt-2 flex flex-col gap-2">
                      {catalog.projects.map((p) => (
                        <li key={p.folder} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {p.projectName ?? p.folder} <span className="text-muted-foreground">({p.points.length} data(s))</span>
                          </span>
                          {p.projectId ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                onRestore({ id: `project:${p.projectId}`, kind: "project", name: p.projectName ?? p.folder }, { points: p.points, redeploy: true })
                              }
                            >
                              Restaurar
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Não cadastrado aqui: restaure o painel primeiro.</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">E-mail</p>
                    <p className="text-muted-foreground">Por último. Depois aponte o DNS (A, MX e o PTR no provedor) para o IP desta VPS.</p>
                    {catalog.email.length > 0 ? (
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => onRestore({ id: "email", kind: "email", name: "E-mail" }, { points: catalog.email })}>
                        Restaurar o e-mail
                      </Button>
                    ) : (
                      <p className="text-muted-foreground">Nenhum backup de e-mail no armazenamento.</p>
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
      <p className="text-sm text-muted-foreground">
        Cópias do painel, do e-mail e dos bancos e arquivos de cada projeto, feitas sozinhas no horário escolhido. Uma fica na VPS e outra pode ir
        para um armazenamento externo, cifrada.
      </p>
      {loadError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            Tentar de novo
          </Button>
        </div>
      )}
      {!status && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {status && (
        <>
          {!status.archiverAvailable && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> O 7-Zip não está instalado no container do painel, então os backups não
              rodam. Atualize o painel (sudo git pull e sudo docker compose up -d --build em /opt/tws-panel).
            </p>
          )}
          {reminderDue(status) && (
            <p data-testid="reminder" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> Você ainda tem sua senha de backup? Teste aqui, no cartão Criptografia.
            </p>
          )}
          {status.running && (
            <p className="flex items-center gap-2 text-sm text-sky-300">
              <Loader2 className="h-4 w-4 animate-spin" />{" "}
              {status.running.operation === "restore" ? "Restaurando" : status.running.operation === "verify" ? "Conferindo" : "Fazendo backup de"}{" "}
              {status.running.operation === "verify" && status.running.target === "all" ? "todos os backups" : status.running.targetName}
              {status.queued.length > 0 && `; ${status.queued.length} na fila`}.
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
                description="Contas, projetos cadastrados, configurações, certificados próprios e as chaves que cifram os segredos do painel."
              />
            )}
            {email && (
              <TargetCard
                target={email}
                status={status}
                reload={load}
                onRestore={(target) => setRestore({ target })}
                icon={<Mail className="h-4 w-4 text-violet-400" />}
                description="O servidor de e-mail inteiro: caixas, mensagens, contas, regras e chaves DKIM. Ele para por alguns segundos durante a cópia."
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
              <CardTitle className="text-base">Últimos backups</CardTitle>
              <CardDescription>
                Backups, restaurações e conferências, com o motivo quando algo falhou. Cópias na VPS em <span className="break-all">{status.localPath}</span>.
                Conferir abre cada cópia com o 7-Zip; a externa é baixada e comparada com o que foi enviado.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <VerifyAllButton target="all" onQueued={load} label="Conferir todos os backups" disabled={!status.archiverAvailable} />
              </div>
              <BackupTimezoneNote status={status} />
              <HistoryList records={status.history.slice(0, 30)} empty="Nenhum backup feito ainda." onVerify={load} />
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
