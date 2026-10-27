import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { AdminUser, TwoFactorStatusResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmWordInput } from "@/components/ConfirmWordInput";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, ShieldCheck, Stethoscope } from "lucide-react";
import { apiErrorText, formatDateTime, lowerCase, Trans, useI18n } from "@/i18n";
import { EmailCodeField } from "@/components/settings/EmailCodeField";
import { McpAccess } from "@/pages/settings/McpAccess";

/** Palavra que o servidor compara (routes/setup-restart.ts); a tela aceita também a do idioma. */
const CONFIRMATION = "recomeçar";

/** "Recomeçar do zero": orientação primeiro, confirmação forte depois. */
function RestartZone() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || twoFactor !== null) return;
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setTwoFactor(s.enabled === true))
      .catch(() => setTwoFactor(false));
  }, [open, twoFactor]);

  const localWord = lowerCase(t("setup.done.restart.confirmWord"));
  const canRestart =
    !busy && password !== "" && code.trim() !== "" && [CONFIRMATION, localWord].includes(lowerCase(confirm.trim()));

  async function restart(event: FormEvent) {
    event.preventDefault();
    if (!canRestart) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ setupUrl: string }>("/api/settings/restart-setup", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, code: code.trim(), confirm: CONFIRMATION, ...(emailCode.trim() ? { emailCode: emailCode.trim() } : {}) }),
      });
      // recarrega a página inteira: o assistente recomeça do passo 0 com o token novo
      window.location.assign(res.setupUrl);
    } catch (err) {
      setError(err instanceof ApiRequestError ? apiErrorText(err, "setup.done.restart.failed") : t("setup.done.restart.failed"));
      setBusy(false);
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left font-semibold text-red-400"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <AlertTriangle className="h-4 w-4" /> {t("setup.done.restart.title")}
        </button>
        <CardDescription>{t("setup.done.restart.description")}</CardDescription>
      </CardHeader>
      {open && (
        <CardContent data-testid="restart-zone" className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-2 text-muted-foreground">
            <p>
              <Trans k="setup.done.restart.what" components={{ b: <strong className="text-foreground" /> }} />
            </p>
            <p>
              <Trans k="setup.done.restart.keeps" components={{ b: <strong className="text-foreground" /> }} />
            </p>
            <p>
              <Trans k="setup.done.restart.when" components={{ b: <strong className="text-foreground" /> }} />
            </p>
          </div>

          {twoFactor === null && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

          {twoFactor === false && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
              <Trans
                k="setup.done.restart.needTwoFactor"
                params={{ command: "sudo ./scripts/reset-setup.sh --full" }}
                components={{
                  link: (c) => (
                    <Link to="/settings/security#two-factor" className="underline">
                      {c}
                    </Link>
                  ),
                  code: <code className="font-mono" />,
                }}
              />
            </p>
          )}

          {twoFactor === true && (
            <form onSubmit={(e) => void restart(e)} className="flex max-w-sm flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rs-password" className="font-medium">
                  {t("setup.done.restart.password")}
                </label>
                <PasswordInput
                  id="rs-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rs-code" className="font-medium">
                  {t("setup.done.restart.code")}
                </label>
                <Input
                  id="rs-code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123 456"
                  className="font-mono tracking-widest"
                />
              </div>
              <EmailCodeField idPrefix="rs" value={emailCode} onChange={setEmailCode} />
              <ConfirmWordInput
                id="rs-confirm"
                word={t("setup.done.restart.confirmWord")}
                value={confirm}
                onChange={setConfirm}
                labelKey="setup.done.restart.confirm"
                hintKey="setup.done.restart.confirmHint"
              />
              {error && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" variant="destructive" disabled={!canRestart}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("setup.done.restart.submit")}
              </Button>
            </form>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * /setup depois da configuração concluída. Antes, o item "Setup" do menu
 * abria o assistente do zero pedindo um token que já não valia. Agora: o que
 * foi feito, o que dá para refazer sem risco, e — separado, com orientação e
 * confirmação forte — "Recomeçar do zero".
 */
export function SetupDone({ user }: { user: AdminUser }) {
  const { t } = useI18n();
  const quando = formatDateTime(user.createdAt);
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);
  useEffect(() => {
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setTwoFactor(s.enabled === true))
      .catch(() => setTwoFactor(false));
  }, []);
  return (
    <div data-testid="setup-done" className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CheckCircle2 className="h-6 w-6 text-emerald-400" /> {t("setup.done.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          <Trans
            k="setup.done.completedAt"
            params={{ when: quando, user: user.username }}
            components={{ b: <strong className="text-foreground" /> }}
          />
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("setup.done.redo.title")}</CardTitle>
          <CardDescription>{t("setup.done.redo.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/health">
              <Stethoscope className="h-4 w-4" /> {t("setup.done.redo.health")}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/security/hardening">
              <ShieldCheck className="h-4 w-4" /> {t("setup.done.redo.hardening")}
            </Link>
          </Button>
          <Button asChild>
            <Link to="/">{t("setup.done.redo.dashboard")}</Link>
          </Button>
        </CardContent>
      </Card>

      {/* O acesso por IA (MCP) começa desligado: terminada a instalação, quem quiser liga aqui mesmo. */}
      <McpAccess twoFactor={twoFactor} />

      <RestartZone />
    </div>
  );
}
