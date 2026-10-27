import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  linuxPasswordErrors,
  type AccessStatusResponse,
  type BansResponse,
  type RecoveryKitResponse,
  type SshKeyInfo,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { downloadText, kitText, printText } from "@/lib/recovery-kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { CopyButton } from "@/components/CopyButton";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { Download, KeyRound, Loader2, Printer, RefreshCw, ShieldAlert } from "lucide-react";

const KEYGEN = 'ssh-keygen -t ed25519 -C "meu-notebook"';

function Notice({ tone, children }: { tone: "ok" | "error" | "warn"; children: ReactNode }) {
  const style =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${style}`}>
      {children}
    </p>
  );
}

function SubmitButton({ busy, disabled, label, busyLabel, destructive = false }: { busy: boolean; disabled: boolean; label: string; busyLabel: string; destructive?: boolean }) {
  return (
    <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={disabled || busy}>
      {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? busyLabel : label}
    </Button>
  );
}

/** Configurações → Acesso à VPS: chaves SSH, senha do usuário Linux, IPs bloqueados e kit de recuperação. */
export function AccessSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AccessStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<AccessStatusResponse>("/api/security/access"));
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorText(err, "access.page.loadError"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!status) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="access-settings">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t("access.page.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("access.page.intro")}</p>
        {status.available && status.user && <p className="text-sm">{t("access.page.user", { user: status.user })}</p>}
        {!status.available && <Notice tone="warn">{t("access.page.unavailable", { reason: status.reason ?? "" })}</Notice>}
        {status.available && !status.twoFactorEnabled && (
          <Notice tone="warn">
            <Trans k="access.reauth.needTwoFactor" components={{ link: <Link to="/settings/security#two-factor" className="underline underline-offset-2" /> }} />
          </Notice>
        )}
        {status.keysError && <Notice tone="error">{t("access.page.keysError", { error: status.keysError })}</Notice>}
      </div>

      {status.available && status.user && (
        <>
          <KeysCard user={status.user} keys={status.keys} onChange={(keys) => setStatus({ ...status, keys })} />
          <LinuxPasswordCard user={status.user} />
        </>
      )}
      <BansCard />
      <KitCard />
    </div>
  );
}

// ------------------------------------------------------------------ chaves SSH

function KeysCard({ user, keys, onChange }: { user: string; keys: SshKeyInfo[]; onChange: (keys: SshKeyInfo[]) => void }) {
  const { t } = useI18n();
  const [publicKey, setPublicKey] = useState("");
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [removing, setRemoving] = useState<SshKeyInfo | null>(null);
  const [removeReauth, setRemoveReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ keys: SshKeyInfo[] }>("/api/security/access/keys", {
        method: "POST",
        body: JSON.stringify({ ...reauthPayload(reauth), publicKey: publicKey.trim() }),
      });
      onChange(res.keys);
      setPublicKey("");
      setReauth({ ...reauth, code: "", emailCode: "" });
      setDone(t("access.keys.added"));
    } catch (err) {
      setError(apiErrorText(err, "access.keys.error"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!removing) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ keys: SshKeyInfo[] }>("/api/security/access/keys/remove", {
        method: "POST",
        body: JSON.stringify({ ...reauthPayload(removeReauth), fingerprint: removing.fingerprint }),
      });
      onChange(res.keys);
      setRemoving(null);
      setRemoveReauth(EMPTY_REAUTH);
      setDone(t("access.keys.removed"));
    } catch (err) {
      setError(apiErrorText(err, "access.keys.removeError"));
    } finally {
      setBusy(false);
    }
  }

  const ready = (r: Reauth) => r.password.length > 0 && r.code.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> {t("access.keys.title")}
        </CardTitle>
        <CardDescription>{t("access.keys.description", { user })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access.keys.empty")}</p>
        ) : (
          <ul data-testid="ssh-keys" className="flex flex-col gap-2">
            {keys.map((k) => (
              <li key={k.fingerprint} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs">{k.fingerprint}</p>
                  <p className="text-muted-foreground">
                    {k.type}
                    {k.bits ? ` ${k.bits}` : ""} · {k.comment || t("access.keys.noComment")}
                  </p>
                  {k.hasOptions && <p className="text-xs text-amber-400">{t("access.keys.hasOptions")}</p>}
                </div>
                <Button variant="outline" size="sm" onClick={() => { setRemoving(k); setRemoveReauth(EMPTY_REAUTH); setError(null); setDone(null); }}>
                  {t("access.keys.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {removing && (
          <form onSubmit={(e) => void remove(e)} className="flex max-w-md flex-col gap-3 rounded-md border border-destructive/40 p-3" data-testid="remove-key-form">
            <p className="text-sm font-medium">{t("access.keys.removeTitle", { fingerprint: removing.fingerprint })}</p>
            <p className="text-sm text-muted-foreground">{t("access.keys.removeWarn")}</p>
            <ReauthFields idPrefix="rk" value={removeReauth} onChange={setRemoveReauth} />
            <div className="flex gap-2">
              <SubmitButton destructive busy={busy} disabled={!ready(removeReauth)} label={t("access.keys.removeConfirm")} busyLabel={t("access.keys.removing")} />
              <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>
                {t("access.keys.cancel")}
              </Button>
            </div>
          </form>
        )}

        <form onSubmit={(e) => void add(e)} className="flex max-w-md flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("access.keys.addTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("access.keys.addHint")}</p>
          <p className="text-xs text-muted-foreground">{t("access.keys.howTo")}</p>
          <div className="flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5">
            <code className="break-all font-mono text-xs text-emerald-100/90">{KEYGEN}</code>
            <CopyButton text={KEYGEN} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ak-key" className="text-sm font-medium">
              {t("access.keys.publicKey")}
            </label>
            <textarea
              id="ak-key"
              rows={3}
              spellCheck={false}
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA… meu-notebook"
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
            />
          </div>
          <ReauthFields idPrefix="ak" value={reauth} onChange={setReauth} />
          <SubmitButton busy={busy} disabled={!ready(reauth) || publicKey.trim().length === 0} label={t("access.keys.add")} busyLabel={t("access.keys.adding")} />
        </form>

        {error && <Notice tone="error">{error}</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ senha Linux

function LinuxPasswordCard({ user }: { user: string }) {
  const { t } = useI18n();
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const problems = next.length > 0 ? linuxPasswordErrors(next) : [];
  const mismatch = again.length > 0 && again !== next;
  const canSubmit = next.length > 0 && problems.length === 0 && again === next && reauth.password.length > 0 && reauth.code.trim().length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await apiFetch("/api/security/access/linux-password", {
        method: "POST",
        body: JSON.stringify({ ...reauthPayload(reauth), newLinuxPassword: next }),
      });
      setNext("");
      setAgain("");
      setReauth({ ...reauth, code: "", emailCode: "" });
      setDone(true);
    } catch (err) {
      setError(apiErrorText(err, "access.linux.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("access.linux.title", { user })}</CardTitle>
        <CardDescription>{t("access.linux.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lp-new" className="text-sm font-medium">
              {t("access.linux.new")}
            </label>
            <PasswordInput id="lp-new" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lp-again" className="text-sm font-medium">
              {t("access.linux.confirm")}
            </label>
            <PasswordInput id="lp-again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            {mismatch && <p className="text-xs text-amber-400">{t("access.linux.mismatch")}</p>}
          </div>
          <ReauthFields idPrefix="lp" value={reauth} onChange={setReauth} />
          <SubmitButton busy={busy} disabled={!canSubmit} label={t("access.linux.submit")} busyLabel={t("access.linux.saving")} />
          {error && <Notice tone="error">{error}</Notice>}
          {done && <Notice tone="ok">{t("access.linux.done", { user })}</Notice>}
        </form>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ fail2ban

function BansCard() {
  const { t } = useI18n();
  const [bans, setBans] = useState<BansResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBans(await apiFetch<BansResponse>("/api/security/access/bans"));
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorText(err, "access.bans.error"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function unban(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setBans(
        await apiFetch<BansResponse>("/api/security/access/bans/unban", {
          method: "POST",
          body: JSON.stringify({ ...reauthPayload(reauth), ip: target }),
        }),
      );
      setDone(t("access.bans.unbanDone", { ip: target }));
      setTarget(null);
      setReauth(EMPTY_REAUTH);
    } catch (err) {
      setError(apiErrorText(err, "access.bans.error"));
    } finally {
      setBusy(false);
    }
  }

  const all = bans?.jails.flatMap((j) => j.ips.map((ip) => ({ jail: j.jail, ip }))) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" /> {t("access.bans.title")}
        </CardTitle>
        <CardDescription>{t("access.bans.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {bans && !bans.available && <Notice tone="warn">{t("access.bans.unavailable", { reason: bans.reason ?? "" })}</Notice>}
        {bans?.available && all.length === 0 && <p className="text-sm text-muted-foreground">{t("access.bans.empty")}</p>}
        {all.length > 0 && (
          <ul data-testid="bans" className="flex flex-col gap-2">
            {all.map(({ jail, ip }) => (
              <li key={`${jail}-${ip}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span>
                  <span className="font-mono">{ip}</span>{" "}
                  <span className="text-xs text-muted-foreground">({t("access.bans.jail", { jail })})</span>
                  {bans?.yourIp === ip && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400">{t("access.bans.yours")}</span>}
                </span>
                <Button variant="outline" size="sm" onClick={() => { setTarget(ip); setReauth(EMPTY_REAUTH); setError(null); setDone(null); }}>
                  {t("access.bans.unban")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {target && (
          <form onSubmit={(e) => void unban(e)} className="flex max-w-md flex-col gap-3 rounded-md border p-3" data-testid="unban-form">
            <p className="text-sm font-medium">{t("access.bans.unbanTitle", { ip: target })}</p>
            <ReauthFields idPrefix="ub" value={reauth} onChange={setReauth} />
            <div className="flex gap-2">
              <SubmitButton busy={busy} disabled={reauth.password.length === 0 || reauth.code.trim().length === 0} label={t("access.bans.unban")} busyLabel={t("access.bans.unbanning")} />
              <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
                {t("access.keys.cancel")}
              </Button>
            </div>
          </form>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        <div>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("access.bans.refresh")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ kit

function KitCard() {
  const { t } = useI18n();
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [kit, setKit] = useState<RecoveryKitResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setKit(await apiFetch<RecoveryKitResponse>("/api/security/access/kit", { method: "POST", body: JSON.stringify(reauthPayload(reauth)) }));
      setReauth(EMPTY_REAUTH);
    } catch (err) {
      setError(apiErrorText(err, "access.kit.error"));
    } finally {
      setBusy(false);
    }
  }

  const text = kit ? kitText(kit) : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("access.kit.title")}</CardTitle>
        <CardDescription>{t("access.kit.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!kit && (
          <form onSubmit={(e) => void generate(e)} className="flex max-w-md flex-col gap-3">
            <ReauthFields idPrefix="kit" value={reauth} onChange={setReauth} />
            <SubmitButton busy={busy} disabled={reauth.password.length === 0 || reauth.code.trim().length === 0} label={t("access.kit.generate")} busyLabel={t("access.kit.generating")} />
          </form>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {kit && (
          <>
            <pre data-testid="kit-text" className="whitespace-pre-wrap rounded-md border bg-black/40 p-3 font-mono text-xs">
              {text}
            </pre>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => printText(t("access.kit.doc.title"), text)}>
                <Printer className="h-3.5 w-3.5" /> {t("access.kit.print")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadText(t("access.kit.doc.fileName"), text)}>
                <Download className="h-3.5 w-3.5" /> {t("access.kit.download")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
