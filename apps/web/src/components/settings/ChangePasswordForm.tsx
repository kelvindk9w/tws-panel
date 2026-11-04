import { useState, type FormEvent } from "react";
import { PASSWORD_MIN_LENGTH, validatePasswordStrength, type ChangePasswordRequest } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { EmailCodeField } from "@/components/settings/EmailCodeField";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

/** Troca de senha (exige a senha atual; encerra as demais sessões). Configurações → Segurança. */
export function ChangePasswordForm() {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const strength = validatePasswordStrength(newPassword);
  const canSubmit =
    currentPassword.length > 0 && strength.valid && confirm === newPassword && !loading;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const payload: ChangePasswordRequest = { currentPassword, newPassword, ...(emailCode.trim() ? { emailCode: emailCode.trim() } : {}) };
      await apiFetch("/api/auth/change-password", { method: "POST", body: JSON.stringify(payload) });
      setSuccess(true);
    } catch (err) {
      setError(apiErrorText(err, "settings.password.error"));
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <p data-testid="password-changed" className="flex items-center gap-2 text-sm text-emerald-400">
        <CheckCircle2 className="h-4 w-4" /> {t("settings.password.changed")}
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-sm flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="cp-current" className="text-sm font-medium">{t("settings.password.current")}</label>
        <PasswordInput
          id="cp-current"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="cp-new" className="text-sm font-medium">{t("settings.password.new")}</label>
        <PasswordInput
          id="cp-new"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        {newPassword.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs">
            <li className={`flex items-center gap-1.5 ${strength.checks.minLength ? "text-emerald-400" : "text-muted-foreground"}`}>
              {strength.checks.minLength ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              {t("settings.password.rule.minLength", { min: PASSWORD_MIN_LENGTH })}
            </li>
            <li className={`flex items-center gap-1.5 ${strength.checks.hasUpper && strength.checks.hasLower ? "text-emerald-400" : "text-muted-foreground"}`}>
              {strength.checks.hasUpper && strength.checks.hasLower ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              {t("settings.password.rule.case")}
            </li>
            <li className={`flex items-center gap-1.5 ${strength.checks.hasNumber ? "text-emerald-400" : "text-muted-foreground"}`}>
              {strength.checks.hasNumber ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              {t("settings.password.rule.number")}
            </li>
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="cp-confirm" className="text-sm font-medium">{t("settings.password.confirm")}</label>
        <Input
          id="cp-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {confirm.length > 0 && confirm !== newPassword && (
          <p className="text-xs text-amber-400">{t("settings.password.mismatch")}</p>
        )}
      </div>

      <EmailCodeField idPrefix="cp" action="auth.password" value={emailCode} onChange={setEmailCode} />

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={!canSubmit}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {loading ? t("settings.password.saving") : t("settings.password.submit")}
      </Button>
    </form>
  );
}
