import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import type { LoginResponse } from "@paas/core";
import { apiFetch, ApiRequestError, clearSetupToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { LanguageSelect } from "@/components/LanguageSelect";
import { apiErrorText, useI18n } from "@/i18n";
import { Loader2, ShieldCheck } from "lucide-react";

/** "45 s", "5 min", "2 h" (arredonda para cima; igual nos dois idiomas). */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

export function LoginPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  // destino original salvo pelo guard de rotas
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Verificação em duas etapas: o servidor pede o código DEPOIS de conferir a
  // senha; o campo aparece e o formulário reenvia usuário + senha + código.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, ...(needsCode ? { code: code.trim() } : {}) }),
      });
      // o setup token não tem mais utilidade depois do login
      clearSetupToken();
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "two_factor_required") {
        setNeedsCode(true); // próximo passo, não erro
        return;
      }
      if (err instanceof ApiRequestError) {
        let text = apiErrorText(err, "auth.login.failed");
        // bloqueio do código por conta: diz quanto falta (o servidor manda retryAfterSec)
        const wait = err.data?.retryAfterSec;
        if (err.code === "two_factor_locked" && typeof wait === "number" && wait > 0) {
          text = `${text} ${t("auth.login.retryIn", { time: formatWait(wait) })}`;
        }
        setError(text);
      } else {
        setError(t("auth.login.failed"));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <CardTitle>
            TWS <span className="text-muted-foreground">Panel</span>
          </CardTitle>
          <CardDescription>{t("auth.login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-username" className="text-sm font-medium">
                {t("auth.login.username")}
              </label>
              <Input
                id="login-username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-password" className="text-sm font-medium">
                {t("auth.login.password")}
              </label>
              <PasswordInput
                id="login-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            {needsCode && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-code" className="text-sm font-medium">
                  {t("auth.login.code")}
                </label>
                <Input
                  id="login-code"
                  autoComplete="one-time-code"
                  inputMode="text"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123 456"
                  className="font-mono tracking-widest"
                />
                <p className="text-xs text-muted-foreground">
                  {t("auth.login.codeHelp")}
                </p>
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading || !username.trim() || !password || (needsCode && !code.trim())}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? t("auth.login.submitting") : t("auth.login.submit")}
            </Button>
          </form>
          <div className="mt-4 flex justify-center">
            <LanguageSelect />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
