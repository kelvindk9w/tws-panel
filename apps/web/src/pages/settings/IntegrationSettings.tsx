import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { TokenGuide } from "@/components/TokenGuide";
import { CloudflareSettings } from "@/pages/settings/CloudflareSettings";
import { CheckCircle2, Loader2 } from "lucide-react";
import { GithubIcon } from "@/components/icons/GithubIcon";

interface GithubStatus {
  connected: boolean;
  login: string | null;
  hint: string | null;
  updatedAt: string | null;
}

/**
 * Configurações → Integrações. Conta do GitHub: conectada uma vez (token
 * somente leitura), o Novo Projeto lista os repositórios para escolher, e os
 * privados clonam sem pedir token de novo.
 */
export function IntegrationSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<GithubStatus>("/api/integrations/github")
      .then(setStatus)
      .catch(() => setError(t("settings.integrations.github.error.load")));
  }, [t]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GithubStatus>("/api/integrations/github", {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken("");
      setStatus(res);
    } catch (err) {
      setError(apiErrorText(err, "settings.integrations.github.error.connect"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/integrations/github", { method: "DELETE" });
      setStatus({ connected: false, login: null, hint: null, updatedAt: null });
    } catch (err) {
      setError(apiErrorText(err, "settings.integrations.github.error.disconnect"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GithubIcon className="h-4 w-4" /> GitHub
        </CardTitle>
        <CardDescription>{t("settings.integrations.github.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex max-w-lg flex-col gap-3 text-sm">
        {status === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {status?.connected && (
          <div className="flex flex-col gap-3">
            <p data-testid="github-connected" className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />{" "}
              <Trans k="settings.integrations.github.connectedAs" params={{ login: status.login ?? "" }} components={{ b: <strong /> }} />
              <span className="text-xs text-muted-foreground">
                {t("settings.integrations.github.tokenHint", { hint: status.hint ?? "" })}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.integrations.github.expiredNote")}
            </p>
            <Button variant="outline" className="self-start" onClick={() => void disconnect()} disabled={busy}>
              {t("settings.integrations.github.disconnect")}
            </Button>
          </div>
        )}

        {status && !status.connected && (
          <form onSubmit={(e) => void connect(e)} className="flex flex-col gap-3">
            <label htmlFor="gh-token" className="font-medium">
              {t("settings.integrations.github.tokenLabel")}
            </label>
            <PasswordInput
              id="gh-token"
              revealLabel={t("settings.integrations.github.tokenReveal")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
            />
            <TokenGuide scope="account" />
            <span className="text-xs text-muted-foreground">
              {t("settings.integrations.github.tokenNote")}
            </span>
            <Button type="submit" className="self-start" disabled={busy || token.trim() === ""}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.integrations.github.connect")}
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
    <CloudflareSettings />
    </div>
  );
}
