import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { EmailCodeStatusResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { Loader2 } from "lucide-react";

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">{children}</p>;
}

/** Configurações → Segurança: liga e desliga o código por e-mail (fator extra e opcional). */
export function EmailCodeSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<EmailCodeStatusResponse | null>(null);
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<EmailCodeStatusResponse>("/api/auth/email-code"));
    } catch (err) {
      setError(apiErrorText(err, "access.emailCode.statusError"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent, action: "enable" | "disable") {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatus(
        await apiFetch<EmailCodeStatusResponse>(`/api/auth/email-code/${action}`, {
          method: "POST",
          body: JSON.stringify(reauthPayload(reauth)),
        }),
      );
      setReauth(EMPTY_REAUTH);
      setOpen(false);
    } catch (err) {
      setError(apiErrorText(err, "access.emailCode.error"));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    );
  }

  const ready = reauth.password.length > 0 && reauth.code.trim().length > 0 && reauth.emailCode.trim().length > 0;

  return (
    <div data-testid="email-code-settings" className="flex max-w-md flex-col gap-3 text-sm">
      <p className="text-muted-foreground">{t("access.emailCode.explain")}</p>

      {status.enabled ? (
        <>
          <p className="font-medium text-emerald-400">{t("access.emailCode.on", { address: status.address ?? "" })}</p>
          {status.enabledAt && <p className="text-xs text-muted-foreground">{t("access.emailCode.onSince", { date: formatDateTime(status.enabledAt) })}</p>}
        </>
      ) : (
        <p className="font-medium">{t("access.emailCode.off")}</p>
      )}

      {!status.twoFactorEnabled && !status.enabled && <Warn>{t("access.emailCode.notice.needTwoFactor")}</Warn>}
      {status.twoFactorEnabled && !status.address && !status.enabled && (
        <Warn>
          <Trans k="access.emailCode.notice.noAddress" components={{ link: <Link to="/settings/profile" className="underline underline-offset-2" /> }} />
        </Warn>
      )}
      {!status.mailReady && !status.enabled && <Warn>{t("access.emailCode.notice.mailNotReady", { reason: status.mailReason ?? "" })}</Warn>}
      {status.hostedHere && status.address && <Warn>{t("access.emailCode.notice.hosted", { address: status.address })}</Warn>}
      {(status.enabled || status.canEnable) && <Warn>{t("access.emailCode.notice.lockout")}</Warn>}

      {!open && (status.enabled || status.canEnable) && (
        <Button variant={status.enabled ? "outline" : "default"} onClick={() => { setOpen(true); setError(null); }}>
          {status.enabled ? t("access.emailCode.disable") : t("access.emailCode.enable")}
        </Button>
      )}

      {open && (
        <form onSubmit={(e) => void submit(e, status.enabled ? "disable" : "enable")} className="flex flex-col gap-3">
          <p className="text-muted-foreground">{status.enabled ? t("access.emailCode.disableHint") : t("access.emailCode.enableHint")}</p>
          <ReauthFields idPrefix="ecs" value={reauth} onChange={setReauth} forceEmailCode />
          <Button type="submit" variant={status.enabled ? "destructive" : "default"} disabled={!ready || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
            {busy ? t("access.emailCode.saving") : status.enabled ? t("access.emailCode.disable") : t("access.emailCode.enable")}
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
