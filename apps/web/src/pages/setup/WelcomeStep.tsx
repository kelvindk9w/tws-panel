import { useEffect, useRef, useState } from "react";
import type { VerifyTokenResponse } from "@paas/core";
import { apiFetch, getSetupToken, setSetupToken, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KeyRound, Loader2, Server } from "lucide-react";
import { apiErrorText, Trans, useI18n } from "@/i18n";

interface WelcomeStepProps {
  onVerified: () => void;
}

export function WelcomeStep({ onVerified }: WelcomeStepProps) {
  const { t } = useI18n();
  // Se o token veio pela URL (?token=...), ele já está na sessão — pré-preenche
  // e valida automaticamente, sem obrigar o usuário a colar de novo.
  const [token, setToken] = useState(() => getSetupToken() ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoVerified = useRef(false);

  async function verify(value: string) {
    setError(null);
    setLoading(true);
    try {
      const result = await apiFetch<VerifyTokenResponse>("/api/setup/verify-token", {
        method: "POST",
        body: JSON.stringify({ token: value }),
      });
      if (result.valid) {
        setSetupToken(value);
        onVerified();
      } else {
        setError(t("setup.welcome.invalidToken"));
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? apiErrorText(err, "setup.welcome.verifyError") : t("setup.welcome.verifyError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const stored = getSetupToken();
    if (!autoVerified.current && stored) {
      autoVerified.current = true;
      void verify(stored.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await verify(token.trim());
  }

  return (
    <Card className="animate-fade-in">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
          <Server className="h-6 w-6" />
        </div>
        <CardTitle className="text-2xl tracking-tight">{t("setup.welcome.title")}</CardTitle>
        <CardDescription>
          <Trans k="setup.welcome.description" components={{ b: <strong /> }} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-md flex-col gap-4">
          <div className="relative">
            <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("setup.welcome.tokenPlaceholder")}
              className="pl-9 font-mono"
              autoFocus
              required
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading || token.trim().length === 0}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("setup.welcome.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
