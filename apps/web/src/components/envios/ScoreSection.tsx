import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, CircleDashed, CircleHelp, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { DeliverabilityItem, DeliverabilityResponse, PostmasterMarks } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const GOOGLE_POSTMASTER = "https://postmaster.google.com/";
const MICROSOFT_SNDS = "https://sendersupport.olc.protection.outlook.com/snds/";

const BAND = {
  green: { text: "Pronto: siga o aquecimento e acompanhe o Postmaster Tools.", className: "text-emerald-400" },
  yellow: { text: "Vai chegar, mas com risco de spam. Veja o que falta abaixo.", className: "text-amber-400" },
  red: { text: "Arrume os itens que faltam antes de usar com clientes.", className: "text-red-400" },
} as const;

const STATUS: Record<DeliverabilityItem["status"], { label: string; variant: "success" | "warning" | "destructive" | "secondary"; Icon: typeof CheckCircle2 }> = {
  done: { label: "Feito", variant: "success", Icon: CheckCircle2 },
  partial: { label: "Em parte", variant: "warning", Icon: CircleDashed },
  todo: { label: "Falta", variant: "destructive", Icon: XCircle },
  unknown: { label: "Não deu para verificar", variant: "secondary", Icon: CircleHelp },
};

/** ISO → AAAA-MM-DD (campo de data). */
function dateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function ItemRow({ item }: { item: DeliverabilityItem }) {
  const s = STATUS[item.status];
  const external = item.link?.href.startsWith("http");
  return (
    <li data-testid={`score-${item.id}`} className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <s.Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">{item.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {item.points}/{item.maxPoints}
        </span>
        <Badge variant={s.variant}>{s.label}</Badge>
      </div>
      <p className="break-words text-xs text-muted-foreground">{item.detail}</p>
      {item.howTo && <p className="break-words text-xs">{item.howTo}</p>}
      {item.link && (
        <a
          href={item.link.href}
          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
          className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
        >
          {item.link.label} {external && <ExternalLink className="h-3 w-3" />}
        </a>
      )}
    </li>
  );
}

/** Nota de entregabilidade: o que está feito e o que falta, com nota honesta. */
export function ScoreSection() {
  const [data, setData] = useState<DeliverabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState({ googleAt: "", microsoftAt: "", spamRateOkAt: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch<DeliverabilityResponse>("/api/mail/envios/deliverability");
      setData(res);
      setMarks({ googleAt: dateInput(res.marks.googleAt), microsoftAt: dateInput(res.marks.microsoftAt), spamRateOkAt: dateInput(res.marks.spamRateOkAt) });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não deu para calcular a nota.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const body: PostmasterMarks = {
        googleAt: marks.googleAt || null,
        microsoftAt: marks.microsoftAt || null,
        spamRateOkAt: marks.spamRateOkAt || null,
      };
      await apiFetch("/api/mail/envios/postmaster", { method: "PUT", body: JSON.stringify(body) });
      setSaved("Marcações salvas.");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não deu para salvar.");
    } finally {
      setSaving(false);
    }
  }

  const field = (id: keyof typeof marks, label: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`mark-${id}`} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Input id={`mark-${id}`} type="date" value={marks[id]} onChange={(e) => setMarks((m) => ({ ...m, [id]: e.target.value }))} />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Prontidão para a caixa de entrada</CardTitle>
          <CardDescription>
            Mede o que o painel consegue conferir. A decisão final de cada provedor (Gmail, Outlook, Yahoo) não é pública: a nota é um
            guia, não uma garantia. Um servidor novo não chega ao verde antes de cerca de 30 dias enviando — é normal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={cn("text-4xl font-bold tabular-nums", BAND[data.band].className)}>{data.score}</span>
                <span className="text-sm text-muted-foreground">de {data.max}</span>
              </div>
              <p className={cn("text-sm", BAND[data.band].className)}>{BAND[data.band].text}</p>
              <p className="text-xs text-muted-foreground">
                DNS, nome reverso e certificado conferidos em {formatDateTime(data.factsAt)} (junto com as listas de bloqueio, na aba Reputação).
              </p>
              <ul className="flex flex-col gap-1.5">
                {data.items.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Acompanhamento fora do painel</CardTitle>
          <CardDescription>
            O painel não consegue entrar nesses portais por você. Cadastre e marque aqui a data: a nota passa a contar.{" "}
            <a href={GOOGLE_POSTMASTER} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
              Google Postmaster Tools
            </a>{" "}
            (domínio de envio; os gráficos só aparecem com volume) e{" "}
            <a href={MICROSOFT_SNDS} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
              Microsoft SNDS
            </a>{" "}
            (IP da VPS).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {field("googleAt", "Cadastrei no Google Postmaster Tools em")}
              {field("microsoftAt", "Cadastrei o IP no Microsoft SNDS em")}
              {field("spamRateOkAt", "Conferi a taxa de spam abaixo de 0,1% em")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Salvar marcações
              </Button>
              {saved && <span className="text-xs text-emerald-400">{saved}</span>}
            </div>
            <p className="text-xs text-muted-foreground">Deixe em branco para desmarcar.</p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
