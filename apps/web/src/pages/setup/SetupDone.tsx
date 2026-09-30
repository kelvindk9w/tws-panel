import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { AdminUser, TwoFactorStatusResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, ShieldCheck, Stethoscope } from "lucide-react";

const CONFIRMATION = "recomeçar";

/** "Recomeçar do zero": orientação primeiro, confirmação forte depois. */
function RestartZone() {
  const [open, setOpen] = useState(false);
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || twoFactor !== null) return;
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setTwoFactor(s.enabled === true))
      .catch(() => setTwoFactor(false));
  }, [open, twoFactor]);

  const canRestart =
    !busy && password !== "" && code.trim() !== "" && confirm.trim().toLowerCase() === CONFIRMATION;

  async function restart(event: FormEvent) {
    event.preventDefault();
    if (!canRestart) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ setupUrl: string }>("/api/settings/restart-setup", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, code: code.trim(), confirm: confirm.trim() }),
      });
      // recarrega a página inteira: o assistente recomeça do passo 0 com o token novo
      window.location.assign(res.setupUrl);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível recomeçar.");
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
          <AlertTriangle className="h-4 w-4" /> Recomeçar do zero
        </button>
        <CardDescription>Refaz o assistente de configuração desde o começo. Leia antes de prosseguir.</CardDescription>
      </CardHeader>
      {open && (
        <CardContent data-testid="restart-zone" className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-2 text-muted-foreground">
            <p>
              <strong className="text-foreground">O que acontece:</strong> o painel apaga a sua conta de
              administrador (e a verificação em duas etapas dela), encerra todas as sessões e volta o assistente ao
              primeiro passo. Você continua na mesma hora, com um token de setup novo — o antigo deixa de valer.
            </p>
            <p>
              <strong className="text-foreground">O que fica:</strong> projetos, domínios, e-mail, histórico de
              segurança e as proteções já aplicadas na VPS. Nada disso é desfeito.
            </p>
            <p>
              <strong className="text-foreground">Quando faz sentido:</strong> para recriar a conta de administrador
              do zero ou refazer o assistente inteiro. Para só rever a saúde da máquina ou as proteções, use os
              botões acima — eles não apagam nada. Para trocar a senha, use Configurações → Segurança.
            </p>
          </div>

          {twoFactor === null && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

          {twoFactor === false && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
              Para recomeçar pelo painel, ative a verificação em duas etapas em{" "}
              <Link to="/settings/security#two-factor" className="underline">
                Configurações → Segurança
              </Link>
              : ela confirma que é você. O envio de código por e-mail ainda não existe no painel. Sem ela, o
              caminho é pela VPS, com acesso SSH: <code className="font-mono">sudo ./scripts/reset-setup.sh --full</code>
            </p>
          )}

          {twoFactor === true && (
            <form onSubmit={(e) => void restart(e)} className="flex max-w-sm flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rs-password" className="font-medium">
                  Sua senha atual
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
                  Código da verificação em duas etapas
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
              <div className="flex flex-col gap-1.5">
                <label htmlFor="rs-confirm" className="font-medium">
                  Digite recomeçar para confirmar
                </label>
                <Input id="rs-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
              </div>
              {error && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" variant="destructive" disabled={!canRestart}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Apagar e recomeçar
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
  const quando = new Date(user.createdAt).toLocaleString("pt-BR");
  return (
    <div data-testid="setup-done" className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CheckCircle2 className="h-6 w-6 text-emerald-400" /> Configuração inicial concluída
        </h1>
        <p className="text-sm text-muted-foreground">
          Concluída em {quando}, quando a conta <strong className="text-foreground">{user.username}</strong> foi
          criada.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Refazer sem apagar nada</CardTitle>
          <CardDescription>Estes caminhos só verificam ou reaplicam — a conta e os projetos ficam como estão.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/health">
              <Stethoscope className="h-4 w-4" /> Verificar a saúde da máquina
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/security/hardening">
              <ShieldCheck className="h-4 w-4" /> Rever as proteções de segurança
            </Link>
          </Button>
          <Button asChild>
            <Link to="/">Ir para o Dashboard</Link>
          </Button>
        </CardContent>
      </Card>

      <RestartZone />
    </div>
  );
}
