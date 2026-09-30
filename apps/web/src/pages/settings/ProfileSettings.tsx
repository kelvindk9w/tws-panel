import { useState, type FormEvent } from "react";
import { DISPLAY_NAME_MAX_LENGTH, type UpdateProfileRequest, type UpdateProfileResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
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
  const { user, setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameChanges = username.trim() !== user.username;
  const dirty =
    displayName.trim() !== (user.displayName ?? "") || email.trim() !== (user.email ?? "") || usernameChanges;
  const canSave = dirty && !saving && username.trim() !== "" && (!usernameChanges || currentPassword !== "");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const payload: UpdateProfileRequest = {
        displayName: displayName.trim(),
        email: email.trim(),
        ...(usernameChanges ? { username: username.trim(), currentPassword } : {}),
      };
      const res = await apiFetch<UpdateProfileResponse>("/api/settings/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setUser(res.user);
      setCurrentPassword("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar o perfil.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Perfil</CardTitle>
        <CardDescription>Como você aparece no painel e como entra nele.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-name" className="text-sm font-medium">
              Nome de exibição
            </label>
            <Input
              id="pf-name"
              value={displayName}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={user.username}
            />
            <p className="text-xs text-muted-foreground">Aparece no menu. Em branco, mostra o usuário de login.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-email" className="text-sm font-medium">
              E-mail
            </label>
            <Input
              id="pf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
            />
            <p className="text-xs text-muted-foreground">
              Contato da conta. Hoje o painel não envia e-mails — veja Configurações → Notificações.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pf-username" className="text-sm font-medium">
              Usuário de login
            </label>
            <Input
              id="pf-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">É o que você digita para entrar no painel.</p>
          </div>
          {usernameChanges && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pf-password" className="text-sm font-medium">
                Sua senha atual
              </label>
              <PasswordInput
                id="pf-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <p className="text-xs text-amber-400">
                Trocar o usuário de login muda o que você digita para entrar: confirme com a senha.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!canSave}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
            </Button>
            {saved && !dirty && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> Salvo.
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
