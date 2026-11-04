/**
 * TerminalGate — o terminal depois do setup só aparece habilitado.
 *
 * Envolve o TerminalPanel das páginas que usam a sessão de login (Hardening, Saúde): desligado, mostra
 * o convite com o botão "Habilitar terminal" (diálogo de reautenticação: senha + código do app + código
 * por e-mail quando ligado) e o aviso de que o terminal dá acesso total ao usuário da VPS; habilitado,
 * mostra a contagem do tempo restante e o botão "Desligar agora" acima do terminal. Quando o servidor
 * desliga (janela, ociosidade, senha ou 2FA trocados), volta ao convite dizendo por quê.
 *
 * Durante o assistente de instalação (`required` falso) nada disso aparece: o terminal segue como sempre.
 * O servidor é quem decide; esta tela só espelha o estado.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { formatCountdown, useTerminalAccess, type TerminalAccessState } from "@/lib/terminal-access";
import { Button } from "@/components/ui/button";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { Loader2, Power, ShieldAlert, TerminalSquare } from "lucide-react";

const toMinutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function TerminalGate({ children }: { children: (props: { onDisabled: () => void }) => ReactNode }) {
  const { t } = useI18n();
  const access = useTerminalAccess();
  const { status } = access;
  // aviso de que o e-mail de alerta não saiu: sobrevive à troca do convite pela barra
  const [alertWarning, setAlertWarning] = useState<string | null>(null);

  if (access.error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <span>{t("terminal.gate.error")}</span>
        <Button variant="outline" size="sm" onClick={access.reload}>
          {t("terminal.gate.retry")}
        </Button>
      </div>
    );
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground">{t("terminal.gate.checking")}</p>;
  }
  if (!status.required) return <>{children({ onDisabled: access.reload })}</>;
  if (!status.enabled) return <Invitation access={access} onEnabled={setAlertWarning} />;
  return (
    <div className="flex flex-col gap-3">
      <EnabledBar access={access} alertWarning={alertWarning} />
      {children({ onDisabled: access.reload })}
    </div>
  );
}

function EnabledBar({ access, alertWarning }: { access: TerminalAccessState; alertWarning: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const status = access.status!;

  async function turnOff() {
    setBusy(true);
    setFailed(false);
    try {
      await access.disable();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-emerald-300" role="status">
          <TerminalSquare className="h-4 w-4" />
          <span>{t("terminal.gate.bar.on", { time: formatCountdown(access.remainingMs) })}</span>
        </p>
        <Button variant="outline" size="sm" onClick={() => void turnOff()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}{" "}
          {busy ? t("terminal.gate.bar.offBusy") : t("terminal.gate.bar.off")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("terminal.gate.bar.idle", { idle: toMinutes(status.idleMs) })}</p>
      <p className="text-xs text-amber-300">{t("terminal.gate.warning")}</p>
      {alertWarning && (
        <p role="status" className="text-xs text-amber-300">
          {alertWarning}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("terminal.gate.bar.offError")}
        </p>
      )}
    </div>
  );
}

function Invitation({ access, onEnabled }: { access: TerminalAccessState; onEnabled: (warning: string | null) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status = access.status!;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4" aria-label={t("terminal.gate.title")}>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <TerminalSquare className="h-5 w-5 text-muted-foreground" />
        {t("terminal.gate.title")}
      </h3>
      {status.lastEnd && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {t(`terminal.gate.ended.${status.lastEnd}`)}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t("terminal.gate.body")}</p>
      <p className="flex items-start gap-2 text-sm text-amber-300">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("terminal.gate.warning")}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {t("terminal.gate.rules", { window: toMinutes(status.windowMs), idle: toMinutes(status.idleMs) })}
      </p>
      {!status.twoFactorEnabled && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans k="terminal.gate.needTwoFactor" components={{ link: <Link to="/settings/security#two-factor" className="underline underline-offset-2" /> }} />
        </p>
      )}
      <div>
        <Button onClick={() => setOpen(true)} disabled={!status.twoFactorEnabled}>
          <TerminalSquare className="h-4 w-4" /> {t("terminal.gate.enable")}
        </Button>
      </div>
      {open && <EnableDialog access={access} onClose={() => setOpen(false)} onEnabled={onEnabled} />}
    </section>
  );
}

function EnableDialog({ access, onClose, onEnabled }: { access: TerminalAccessState; onClose: () => void; onEnabled: (warning: string | null) => void }) {
  const { t } = useI18n();
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = access.status!;
  const ready = reauth.password.length > 0 && reauth.code.trim().length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await access.enable(reauthPayload(reauth));
      // O alerta por e-mail que não pôde sair não impede a habilitação: o aviso segue na barra.
      onEnabled(res.alertWarning ?? null);
    } catch (err) {
      setError(apiErrorText(err, "terminal.gate.dialog.error"));
      setReauth({ ...reauth, code: "", emailCode: "" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("terminal.gate.dialog.aria")}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)} className="flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-2xl">
        <h3 className="text-lg font-semibold">{t("terminal.gate.dialog.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("terminal.gate.dialog.intro", { window: toMinutes(status.windowMs) })}</p>
        <p className="text-sm text-amber-300">{t("terminal.gate.warning")}</p>
        <ReauthFields idPrefix="term" action="terminal.enable" value={reauth} onChange={setReauth} />
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("terminal.gate.dialog.cancel")}
          </Button>
          <Button type="submit" disabled={!ready || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? t("terminal.gate.dialog.busy") : t("terminal.gate.dialog.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}
