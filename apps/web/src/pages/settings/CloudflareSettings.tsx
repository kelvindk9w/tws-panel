import { useEffect, useId, useState, type FormEvent } from "react";
import type { CloudflareConnectResponse, CloudflareStatus } from "@paas/core";
import { ChevronDown, ChevronRight, CheckCircle2, CloudCog, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Configurações → Integrações → Cloudflare (DNS). Desligada por padrão: liga com um API Token
 * (nunca a Global API Key). O token fica cifrado no servidor e nunca volta; trocar ou remover pede a senha.
 */
export function CloudflareSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CloudflareStatus | null>(null);
  const [zones, setZones] = useState<string[] | null>(null);
  /** Só vem ao conectar: false = o token parece só leitura; null = não deu para conferir. */
  const [dnsEdit, setDnsEdit] = useState<boolean | null | undefined>(undefined);
  const [mode, setMode] = useState<"idle" | "connect" | "remove">("idle");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { token: useId(), password: useId(), code: useId() };

  useEffect(() => {
    let alive = true;
    apiFetch<CloudflareStatus>("/api/integrations/cloudflare")
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s?.connected) {
          apiFetch<{ zones: string[] }>("/api/integrations/cloudflare/zones")
            .then((z) => alive && setZones(z.zones))
            .catch(() => undefined);
        }
      })
      .catch(() => alive && setError(t("cloudflare.error.load")));
    return () => {
      alive = false;
    };
  }, [t]);

  const connected = status?.connected === true;
  const showForm = status !== null && (!connected || mode === "connect");
  const reauth = { currentPassword: password, ...(code.trim() ? { code: code.trim() } : {}) };

  function reset() {
    setToken("");
    setPassword("");
    setCode("");
    setMode("idle");
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<CloudflareConnectResponse>("/api/integrations/cloudflare", {
        method: "PUT",
        body: JSON.stringify({ token: token.trim(), ...reauth }),
      });
      const { zones: names, dnsEdit: canEdit, ...rest } = res;
      setDnsEdit(canEdit);
      setStatus(rest);
      setZones(names);
      reset();
    } catch (err) {
      setError(apiErrorText(err, "cloudflare.error.connect"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<CloudflareStatus>("/api/integrations/cloudflare/disconnect", {
        method: "POST",
        body: JSON.stringify(reauth),
      });
      setStatus(res);
      setZones(null);
      reset();
    } catch (err) {
      setError(apiErrorText(err, "cloudflare.error.disconnect"));
    } finally {
      setBusy(false);
    }
  }

  const passwordFields = (
    <>
      <label htmlFor={ids.password} className="font-medium">
        {t("cloudflare.form.password.label")}
      </label>
      <PasswordInput id={ids.password} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor={ids.code} className="font-medium">
        {t("cloudflare.form.code.label")}
      </label>
      <Input id={ids.code} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
    </>
  );

  return (
    <Card data-testid="cloudflare-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudCog className="h-4 w-4" /> {t("cloudflare.card.title")}
        </CardTitle>
        <CardDescription>{t("cloudflare.card.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex max-w-lg flex-col gap-3 text-sm">
        {status === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {connected && (
          <div className="flex flex-col gap-3">
            <p data-testid="cloudflare-connected" className="flex flex-wrap items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> {t("cloudflare.connected")}
              <span className="text-xs text-muted-foreground">{t("cloudflare.tokenHint", { hint: status?.hint ?? "" })}</span>
            </p>
            {zones !== null && zones.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">{t("cloudflare.zones.title")}</p>
                <p data-testid="cloudflare-zones" className="break-all font-mono text-xs text-muted-foreground">
                  {zones.join(", ")}
                </p>
              </div>
            )}
            {zones !== null && zones.length === 0 && (
              <p role="note" className="flex items-start gap-2 text-xs text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t("cloudflare.zones.none")}
              </p>
            )}
            {dnsEdit === false && (
              <p role="alert" data-testid="cloudflare-readonly" className="flex items-start gap-2 text-xs text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t("cloudflare.dnsEdit.no")}
              </p>
            )}
            {dnsEdit === null && (
              <p role="note" data-testid="cloudflare-edit-unknown" className="text-xs text-muted-foreground">
                {t("cloudflare.dnsEdit.unknown")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("cloudflare.usage", { count: status?.callsLastHour ?? 0, limit: status?.hourlyLimit ?? 0 })}
            </p>
            {mode === "idle" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setMode("connect")}>
                  {t("cloudflare.form.replace")}
                </Button>
                <Button variant="outline" onClick={() => setMode("remove")}>
                  {t("cloudflare.form.disconnect")}
                </Button>
              </div>
            )}
          </div>
        )}

        {connected && mode === "remove" && (
          <form onSubmit={(e) => void disconnect(e)} className="flex flex-col gap-3">
            {passwordFields}
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" disabled={busy || password.length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("cloudflare.form.confirmDisconnect")}
              </Button>
              <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                {t("cloudflare.form.cancel")}
              </Button>
            </div>
          </form>
        )}

        {showForm && (
          <form onSubmit={(e) => void connect(e)} className="flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={guideOpen}
              onClick={() => setGuideOpen((v) => !v)}
              className="flex items-center gap-1.5 self-start text-xs font-medium text-sky-400 hover:underline"
            >
              {guideOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {t("cloudflare.guide.toggle")}
            </button>
            {guideOpen && (
              <div data-testid="cloudflare-guide" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
                <ol className="list-decimal space-y-1 pl-4">
                  <li>{t("cloudflare.guide.s1")}</li>
                  <li>
                    <Trans k="cloudflare.guide.s2" components={{ b: <strong className="text-foreground" /> }} />
                  </li>
                  <li>
                    <Trans k="cloudflare.guide.s3" components={{ b: <strong className="text-foreground" /> }} />
                  </li>
                  <li>{t("cloudflare.guide.s4")}</li>
                </ol>
                <p className="flex items-start gap-2 text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t("cloudflare.guide.never")}
                </p>
                <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 self-start text-sky-400 hover:underline">
                  {t("cloudflare.guide.link")} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
            )}
            <label htmlFor={ids.token} className="font-medium">
              {t("cloudflare.form.token.label")}
            </label>
            <PasswordInput
              id={ids.token}
              revealLabel={t("cloudflare.form.token.reveal")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {passwordFields}
            <span className="text-xs text-muted-foreground">{t("cloudflare.form.note")}</span>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || token.trim() === "" || password.length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t(connected ? "cloudflare.form.replace" : "cloudflare.form.connect")}
              </Button>
              {connected && (
                <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                  {t("cloudflare.form.cancel")}
                </Button>
              )}
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
