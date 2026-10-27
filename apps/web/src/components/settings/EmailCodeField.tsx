import { useEffect, useRef, useState } from "react";
import type { EmailCodeAction, EmailCodeSendResponse, EmailCodeStatusResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

/**
 * Situação do código por e-mail (ligado ou não). Falha de rede/servidor vale "não ligado":
 * o campo some e o servidor continua sendo quem decide (ele recusa a ação sem o código).
 */
export function useEmailCodeStatus(): EmailCodeStatusResponse | null {
  const [status, setStatus] = useState<EmailCodeStatusResponse | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch<EmailCodeStatusResponse>("/api/auth/email-code")
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/**
 * Campo do código enviado por e-mail, para os formulários das ações sensíveis. Só aparece quando a
 * pessoa ligou o fator (Configurações → Segurança); desligado, não ocupa espaço. `force` mostra o
 * campo mesmo desligado (é o que LIGA o fator).
 */
export function EmailCodeField({
  value,
  onChange,
  action,
  force = false,
  idPrefix = "ec",
}: {
  value: string;
  onChange: (v: string) => void;
  /** Para qual ação o código é pedido: o servidor o prende a ela e o e-mail diz qual é. */
  action: EmailCodeAction;
  force?: boolean;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const status = useEmailCodeStatus();
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  if (!force && !status?.enabled) return null;

  function countdown(seconds: number) {
    if (timer.current) clearInterval(timer.current);
    setWait(seconds);
    timer.current = setInterval(() => {
      setWait((w) => {
        if (w <= 1 && timer.current) clearInterval(timer.current);
        return Math.max(0, w - 1);
      });
    }, 1000);
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch<EmailCodeSendResponse>("/api/auth/email-code/send", { method: "POST", body: JSON.stringify({ action }) });
      setSentTo(res.sentTo);
      countdown(res.resendAfterSec);
    } catch (err) {
      setError(apiErrorText(err, "access.emailField.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="email-code-field">
      <label htmlFor={`${idPrefix}-email-code`} className="text-sm font-medium">
        {t("access.emailField.label")}
      </label>
      {!force && status?.address && (
        <p className="text-xs text-muted-foreground">{t("access.emailField.hint", { address: status.address })}</p>
      )}
      <div className="flex gap-2">
        <Input
          id={`${idPrefix}-email-code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("access.emailField.placeholder")}
          className="font-mono tracking-widest"
        />
        <Button type="button" variant="outline" disabled={sending || wait > 0} onClick={() => void send()}>
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          {sending ? t("access.emailField.sending") : wait > 0 ? t("access.emailField.resend", { sec: wait }) : t("access.emailField.send")}
        </Button>
      </div>
      {sentTo && !error && <p className="text-xs text-emerald-400">{t("access.emailField.sent", { to: sentTo })}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
