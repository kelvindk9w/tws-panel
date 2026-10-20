/**
 * E-mail de teste da página do domínio de e-mail.
 *
 *  - TestEmailForm: a pessoa digita um endereço (ex.: o Gmail dela) e o painel
 *    envia uma mensagem simples a partir da caixa `from`;
 *  - TestEmailModal: o formulário num modal, aberto por qualquer botão
 *    (o card do checklist ou "Testar envio" de cada caixa — pedido do dono do
 *    produto, 02/10/2026, para testar logo depois de trocar uma senha);
 *  - TestEmailCard: o card do checklist, com o botão que abre o modal.
 *
 * Depois de enviar, consulta o destino da
 * mensagem a cada poucos segundos (padrão: 3 s, por até 2 min) e mostra o
 * resultado com cor: entregue (verde), recusado (vermelho), adiado (amarelo).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MailTestResponse, MailTestStatus } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatTime, Trans, t as tGlobal, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Send, X, XCircle } from "lucide-react";

/** "pelo Gmail", "pela Microsoft (Outlook)"… a partir do domínio do destinatário. */
function acceptedBy(to: string): string {
  const domain = to.split("@")[1]?.toLowerCase() ?? "";
  if (["gmail.com", "googlemail.com"].includes(domain)) return tGlobal("mail.test.by.gmail");
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return tGlobal("mail.test.by.microsoft");
  if (/^(yahoo|ymail)\.[a-z.]+$/.test(domain)) return tGlobal("mail.test.by.yahoo");
  return tGlobal("mail.test.by.other", { domain });
}

function hhmm(iso: string): string {
  return formatTime(iso, { hour: "2-digit", minute: "2-digit" });
}

const STYLE: Record<MailTestStatus["state"], string> = {
  queued: "border-sky-500/40 bg-sky-500/10",
  delivered: "border-emerald-500/40 bg-emerald-500/10",
  bounced: "border-red-500/40 bg-red-500/10",
  deferred: "border-amber-500/40 bg-amber-500/10",
};

function StatusBox({ test, stopped, onRetry }: { test: MailTestStatus; stopped: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  let icon;
  let title: string;
  switch (test.state) {
    case "delivered":
      icon = <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
      title = t("mail.test.delivered", { by: acceptedBy(test.to) });
      break;
    case "bounced":
      icon = <XCircle className="h-4 w-4 shrink-0 text-red-400" />;
      title = t("mail.test.bounced", { detail: test.detail ?? t("mail.test.bouncedDefault") });
      break;
    case "deferred":
      icon = <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />;
      title = test.nextRetryAt
        ? t("mail.test.deferredRetry", { detail: test.detail ?? t("mail.test.deferredDefault"), time: hhmm(test.nextRetryAt) })
        : t("mail.test.deferred", { detail: test.detail ?? t("mail.test.deferredDefault") });
      break;
    default:
      icon = stopped ? <Clock className="h-4 w-4 shrink-0 text-sky-400" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />;
      title = t("mail.test.queued");
  }

  return (
    <div data-state={test.state} className={cn("flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm", STYLE[test.state])}>
      <p className="flex items-start gap-2 font-medium">
        {icon}
        <span>{title}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {t("mail.test.summary", { from: test.from, to: test.to, time: hhmm(test.sentAt) })}
      </p>
      {test.state === "delivered" && test.detail && (
        <p className="break-all text-xs text-muted-foreground">
          {test.confirmed ? t("mail.test.serverReply", { detail: test.detail }) : test.detail}
        </p>
      )}
      {test.state === "delivered" && (
        <p className="text-xs">
          {t("mail.test.checkSpam")}
        </p>
      )}
      {test.state === "bounced" && (
        <p className="text-xs text-muted-foreground">
          {t("mail.test.bouncedHint")}
        </p>
      )}
      {stopped && !test.final && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {t("mail.test.stoppedHint")}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("mail.common.recheck")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TestEmailForm({
  domain,
  from,
  pollMs = 3_000,
  maxPollMs = 120_000,
}: {
  domain: string;
  /** Caixa do domínio que envia o teste. */
  from: string;
  /** Intervalo entre consultas do destino da mensagem. */
  pollMs?: number;
  /** Tempo máximo de consulta automática antes de oferecer "Conferir de novo". */
  maxPollMs?: number;
}) {
  const { t } = useI18n();
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<MailTestStatus | null>(null);
  const [pollStart, setPollStart] = useState(0);
  const [stopped, setStopped] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const base = `/api/mail/domains/${encodeURIComponent(domain)}/test-email`;

  // Consulta periódica até o resultado definitivo ou o tempo máximo.
  useEffect(() => {
    if (!test || test.final || stopped) return;
    if (Date.now() - pollStart >= maxPollMs) {
      setStopped(true);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<MailTestResponse>(`${base}/${test.id}`)
        .then((res) => {
          if (alive.current) setTest(res.test);
        })
        .catch((err: unknown) => {
          if (!alive.current) return;
          setError(apiErrorText(err, "mail.test.pollError"));
          setStopped(true);
        });
    }, pollMs);
    return () => clearTimeout(timer);
  }, [test, stopped, pollStart, pollMs, maxPollMs, base]);

  const retry = useCallback(() => {
    setError(null);
    setPollStart(Date.now());
    setStopped(false);
    // força uma nova rodada mesmo com o mesmo estado
    setTest((t) => (t ? { ...t } : t));
  }, []);

  async function send() {
    const address = to.trim();
    if (!address) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch<MailTestResponse>(base, { method: "POST", body: JSON.stringify({ to: address, from }) });
      setPollStart(Date.now());
      setStopped(false);
      setTest(res.test);
    } catch (err) {
      setError(apiErrorText(err, "mail.test.sendError"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        <Trans
          k="mail.test.intro"
          params={{ from }}
          components={{ code: <code className="text-xs text-foreground" /> }}
        />
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          placeholder={t("mail.test.placeholder")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          className="min-w-0 flex-1 sm:max-w-xs"
          aria-label={t("mail.test.toAria")}
        />
        <Button variant="deploy" size="sm" disabled={sending || !to.trim()} onClick={() => void send()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t("mail.test.send")}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {test && <StatusBox test={test} stopped={stopped} onRetry={retry} />}
      <p className="text-xs text-muted-foreground">
        {t("mail.test.internalNote", { domain })}
      </p>
    </div>
  );
}

/** O formulário de teste num modal (Esc ou clique fora fecham). */
export function TestEmailModal({ domain, from, onClose }: { domain: string; from: string; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("mail.test.modalAria", { from })}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 break-all text-lg font-semibold">
            <Send className="h-4 w-4 shrink-0" /> {t("mail.test.title")}
          </h2>
          <Button variant="ghost" size="icon" aria-label={t("mail.common.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <TestEmailForm domain={domain} from={from} />
      </div>
    </div>
  );
}

/** Card do checklist: explica e abre o modal com postmaster@<domínio>. */
export function TestEmailCard({ domain }: { domain: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" /> {t("mail.test.cardTitle")}
        </CardTitle>
        <CardDescription>
          {t("mail.test.cardDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="deploy" size="sm" onClick={() => setOpen(true)}>
          <Send className="h-4 w-4" /> {t("mail.test.title")}
        </Button>
      </CardContent>
      {open && <TestEmailModal domain={domain} from={`postmaster@${domain}`} onClose={() => setOpen(false)} />}
    </Card>
  );
}
