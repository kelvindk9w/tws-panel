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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Send, X, XCircle } from "lucide-react";

/** "pelo Gmail", "pela Microsoft (Outlook)"… a partir do domínio do destinatário. */
function acceptedBy(to: string): string {
  const domain = to.split("@")[1]?.toLowerCase() ?? "";
  if (["gmail.com", "googlemail.com"].includes(domain)) return "pelo Gmail";
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return "pela Microsoft (Outlook)";
  if (/^(yahoo|ymail)\.[a-z.]+$/.test(domain)) return "pelo Yahoo";
  return `pelo servidor de ${domain}`;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const STYLE: Record<MailTestStatus["state"], string> = {
  queued: "border-sky-500/40 bg-sky-500/10",
  delivered: "border-emerald-500/40 bg-emerald-500/10",
  bounced: "border-red-500/40 bg-red-500/10",
  deferred: "border-amber-500/40 bg-amber-500/10",
};

function StatusBox({ test, stopped, onRetry }: { test: MailTestStatus; stopped: boolean; onRetry: () => void }) {
  let icon;
  let title: string;
  switch (test.state) {
    case "delivered":
      icon = <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
      title = `Entregue ao servidor do destinatário (aceito ${acceptedBy(test.to)}).`;
      break;
    case "bounced":
      icon = <XCircle className="h-4 w-4 shrink-0 text-red-400" />;
      title = `Recusado: ${test.detail ?? "o servidor do destinatário não aceitou a mensagem."}`;
      break;
    case "deferred":
      icon = <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />;
      title =
        `Adiada: ${test.detail ?? "o servidor do destinatário pediu para tentar depois"}` +
        (test.nextRetryAt ? `, nova tentativa às ${hhmm(test.nextRetryAt)}.` : ".");
      break;
    default:
      icon = stopped ? <Clock className="h-4 w-4 shrink-0 text-sky-400" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />;
      title = "Na fila / tentando entregar…";
  }

  return (
    <div data-state={test.state} className={cn("flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm", STYLE[test.state])}>
      <p className="flex items-start gap-2 font-medium">
        {icon}
        <span>{title}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        De {test.from} para {test.to}, enviado às {hhmm(test.sentAt)}.
      </p>
      {test.state === "delivered" && test.detail && (
        <p className="break-all text-xs text-muted-foreground">
          {test.confirmed ? `Resposta do servidor: ${test.detail}` : test.detail}
        </p>
      )}
      {test.state === "delivered" && (
        <p className="text-xs">
          Confira também a pasta Spam. Se a mensagem estiver lá, marque como "Não é spam": isso ajuda as
          próximas mensagens do domínio.
        </p>
      )}
      {test.state === "bounced" && (
        <p className="text-xs text-muted-foreground">
          O motivo acima é o que o servidor do destinatário respondeu. Confira o checklist DNS (SPF, DKIM,
          DMARC e o nome reverso) e tente de novo daqui a alguns minutos.
        </p>
      )}
      {stopped && !test.final && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            O servidor de e-mail continua tentando sozinho. Você pode conferir de novo mais tarde.
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Conferir de novo
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
          setError(err instanceof Error ? err.message : "Falha ao consultar o e-mail de teste.");
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
      setError(err instanceof Error ? err.message : "Falha ao enviar o e-mail de teste.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Manda uma mensagem simples de <code className="text-xs text-foreground">{from}</code> para o endereço que
        você digitar (por exemplo, o seu Gmail) e mostra o que o servidor do destinatário respondeu. O painel
        entra na caixa com a senha atual dela: se a mensagem sair, a senha está certa.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          placeholder="voce@gmail.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          className="min-w-0 flex-1 sm:max-w-xs"
          aria-label="Endereço de destino do teste"
        />
        <Button variant="deploy" size="sm" disabled={sending || !to.trim()} onClick={() => void send()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Enviar
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {test && <StatusBox test={test} stopped={stopped} onRetry={retry} />}
      <p className="text-xs text-muted-foreground">
        O teste fala com o servidor de e-mail por dentro da VPS, então funciona mesmo antes de o certificado de
        mail.{domain} ficar pronto.
      </p>
    </div>
  );
}

/** O formulário de teste num modal (Esc ou clique fora fecham). */
export function TestEmailModal({ domain, from, onClose }: { domain: string; from: string; onClose: () => void }) {
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
        aria-label={`Enviar e-mail de teste — ${from}`}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 break-all text-lg font-semibold">
            <Send className="h-4 w-4 shrink-0" /> Enviar e-mail de teste
          </h2>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
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
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" /> E-mail de teste
        </CardTitle>
        <CardDescription>
          Confira se o servidor entrega de verdade: o painel manda uma mensagem para o endereço que você escolher e
          mostra o que o servidor do destinatário respondeu. Para testar outra caixa, use "Testar envio" na aba
          Caixas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="deploy" size="sm" onClick={() => setOpen(true)}>
          <Send className="h-4 w-4" /> Enviar e-mail de teste
        </Button>
      </CardContent>
      {open && <TestEmailModal domain={domain} from={`postmaster@${domain}`} onClose={() => setOpen(false)} />}
    </Card>
  );
}
