import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
  validateUsername,
  type CreateAdminResponse,
  type SecurityScanReport,
} from "@paas/core";
import { apiFetch, ApiRequestError, clearSetupToken } from "@/lib/api";
import { IndexGauge } from "@/components/IndexGauge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, Loader2, PartyPopper, UserRound } from "lucide-react";
import { apiErrorText, useI18n } from "@/i18n";

/** Checklist ao vivo das regras de senha (mesma validação do backend). */
function PasswordRules({ password }: { password: string }) {
  const { t } = useI18n();
  const { checks } = validatePasswordStrength(password);
  const rules = [
    { ok: checks.minLength, label: t("setup.admin.rule.minLength", { min: PASSWORD_MIN_LENGTH }) },
    { ok: checks.hasUpper, label: t("setup.admin.rule.upper") },
    { ok: checks.hasLower, label: t("setup.admin.rule.lower") },
    { ok: checks.hasNumber, label: t("setup.admin.rule.number") },
  ];
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {rules.map((rule) => (
        <li
          key={rule.label}
          className={`flex items-center gap-1.5 ${rule.ok ? "text-emerald-400" : "text-muted-foreground"}`}
        >
          {rule.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          {rule.label}
        </li>
      ))}
    </ul>
  );
}



export function AdminStep({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // score de segurança do Passo 2 (cache do servidor) para a tela de sucesso
  const [score, setScore] = useState<{ value: number; source: string } | null>(null);
  useEffect(() => {
    apiFetch<{ report: SecurityScanReport }>("/api/security/scan")
      .then((res) =>
        setScore({ value: res.report.hardeningIndex ?? 0, source: res.report.hardeningIndexSource }),
      )
      .catch(() => undefined); // score é opcional — a tela funciona sem ele
  }, []);

  const strength = validatePasswordStrength(password);
  const usernameOk = validateUsername(username.trim());
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = usernameOk && strength.valid && confirmOk && !loading;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch<CreateAdminResponse>("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      // setup concluído: o token foi invalidado no servidor — descarta o local
      clearSetupToken();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? apiErrorText(err, "setup.admin.createFailed") : t("setup.admin.createFailed"));
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------ pós-setup
  if (done) {
    return (
      <div className="flex animate-fade-in flex-col gap-6">
        <Card className="border-emerald-500/25 bg-[radial-gradient(ellipse_at_top,rgba(52,211,153,0.06),transparent_65%)]">
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 shadow-[0_0_32px_rgba(52,211,153,0.18)] ring-1 ring-emerald-500/30 motion-safe:animate-scale-in">
              <PartyPopper className="h-7 w-7 text-emerald-400" />
            </div>
            <CardTitle className="text-2xl tracking-tight">{t("setup.admin.done.title")}</CardTitle>
            <CardDescription className="max-w-md">
              {t("setup.admin.done.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6">
            {score && (
              <div className="flex flex-col items-center gap-2.5">
                <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {t("setup.admin.done.score")}
                </span>
                <IndexGauge value={score.value} source={score.source} size="sm" />
              </div>
            )}
            <Button onClick={() => navigate("/login")}>
              {t("setup.admin.done.login")} <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ------------------------------------------------------------ formulário
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1">
            <ArrowLeft className="h-4 w-4" /> {t("setup.admin.backToSecurity")}
          </Button>
        )}
        <h2 className="text-xl font-semibold tracking-tight">{t("setup.admin.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("setup.admin.description")}
        </p>
      </div>

      <Card>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <UserRound className="h-6 w-6" />
          </div>
          <CardTitle>{t("setup.admin.card.title")}</CardTitle>
          <CardDescription className="max-w-md">
            {t("setup.admin.card.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="mx-auto flex max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-username" className="text-sm font-medium">
                {t("setup.admin.username.label")}
              </label>
              <Input
                id="admin-username"
                autoComplete="username"
                placeholder={t("setup.admin.username.placeholder")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              {username.length > 0 && !usernameOk && (
                <p className="text-xs text-amber-400">
                  {t("setup.admin.username.hint")}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-password" className="text-sm font-medium">
                {t("setup.admin.password.label")}
              </label>
              <PasswordInput
                id="admin-password"
                autoComplete="new-password"
                placeholder={t("setup.admin.password.placeholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {password.length > 0 && <PasswordRules password={password} />}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-confirm" className="text-sm font-medium">
                {t("setup.admin.confirm.label")}
              </label>
              <PasswordInput
                id="admin-confirm"
                autoComplete="new-password"
                placeholder={t("setup.admin.confirm.placeholder")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm.length > 0 && !confirmOk && (
                <p className="text-xs text-amber-400">{t("setup.admin.confirm.mismatch")}</p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={!canSubmit}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? t("setup.admin.submitting") : t("setup.admin.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
