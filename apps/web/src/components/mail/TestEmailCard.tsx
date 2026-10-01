/**
 * TestEmailCard — "Enviar e-mail de teste" na página do domínio de e-mail.
 *
 * A pessoa digita um endereço (ex.: o Gmail dela) e o painel envia uma
 * mensagem simples de postmaster@<domínio>. Depois consulta o destino da
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
import { AlertTriangle, CheckCircle2, Clock, Loader2, Send, XCircle } from "lucide-react";

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

export function TestEmailCard({
  domain,
  pollMs = 3_000,
  maxPollMs = 120_000,
}: {
  domain: string;
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
      const res = await apiFetch<MailTestResponse>(base, { method: "POST", body: JSON.stringify({ to: address }) });
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" /> Enviar e-mail de teste
        </CardTitle>
        <CardDescription>
          Manda uma mensagem simples de <code className="text-xs">postmaster@{domain}</code> para o endereço que
          você digitar (por exemplo, o seu Gmail) e mostra o que o servidor do destinatário respondeu. O teste
          fala com o servidor de e-mail por dentro da VPS, então funciona mesmo antes de o certificado de
          mail.{domain} ficar pronto; o estado do certificado continua no card "Certificado do servidor de
          e-mail", na página E-mail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input
            type="email"
            placeholder="voce@gmail.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            className="max-w-xs"
            aria-label="Endereço de destino do teste"
          />
          <Button
            size="sm"
            className="bg-violet-600 text-white hover:bg-violet-700"
            disabled={sending || !to.trim()}
            onClick={() => void send()}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Enviar
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {test && <StatusBox test={test} stopped={stopped} onRetry={retry} />}
      </CardContent>
    </Card>
  );
}
