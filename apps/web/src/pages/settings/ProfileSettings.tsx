import { useState, type FormEvent } from "react";
import { DISPLAY_NAME_MAX_LENGTH, type UpdateProfileRequest, type UpdateProfileResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, Loader2 } from "lucide-react";

/**
 * Configurações → Perfil: nome de exibição, e-mail e usuário de login.
 * Trocar o usuário de login muda o que se digita para entrar: pede a senha.
 */
export function ProfileSettings() {
  const { t } = useI18n();
  const { user, setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [alertWarning, setAlertWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameChanges = username.trim() !== user.username;
  const emailChanges = email.trim() !== (user.email ?? "");
  const needsPassword = usernameChanges || emailChanges;
  const dirty =
    displayName.trim() !== (user.displayName ?? "") || email.trim() !== (user.email ?? "") || usernameChanges;
  const canSave = dirty && !saving && username.trim() !== "" && (!needsPassword || currentPassword !== "");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    setAlertWarning(null);
    try {
      const payload: UpdateProfileRequest = {
        displayName: displayName.trim(),
        email: email.trim(),
        ...(usernameChanges ? { username: username.trim() } : {}),
        ...(needsPassword ? { currentPassword, ...(code.trim() ? { code: code.trim() } : {}) } : {}),
      };
      const res = await apiFetch<UpdateProfileResponse>("/api/settings/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setUser(res.user);
      setCurrentPassword("");
      setCode("");
      setAlertWarning(res.alertWarning ?? null);
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, "settings.profile.error.save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.profile.title")}</CardTitle>
        <CardDescription>{t("settings.profile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-name" className="text-sm font-medium">
              {t("settings.profile.name.label")}
            </label>
            <Input
              id="pf-name"
              value={displayName}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={user.username}
            />
            <p className="text-xs text-muted-foreground">{t("settings.profile.name.hint")}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-email" className="text-sm font-medium">
              {t("settings.profile.email.label")}
            </label>
            <Input
              id="pf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("settings.profile.email.placeholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.profile.email.hint")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-username" className="text-sm font-medium">
              {t("settings.profile.username.label")}
            </label>
            <Input
              id="pf-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t("settings.profile.username.hint")}</p>
          </div>
          {needsPassword && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pf-password" className="text-sm font-medium">
                {t("settings.profile.password.label")}
              </label>
              <PasswordInput
                id="pf-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <p className="text-xs text-amber-400">
                {usernameChanges ? t("settings.profile.password.warning") : t("settings.profile.password.emailWarning")}
              </p>
              {emailChanges && (
                <>
                  <label htmlFor="pf-code" className="text-sm font-medium">
                    {t("settings.profile.code.label")}
                  </label>
                  <Input id="pf-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
                </>
              )}
            </div>
          )}
          {alertWarning && (
            <p role="status" data-testid="alert-warning" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              {alertWarning}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!canSave}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.profile.save")}
            </Button>
            {saved && !dirty && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> {t("settings.profile.saved")}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
