import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { MailRate, MailVolumeDay, MailVolumeResponse } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { dayLabel, formatPercent } from "@/lib/envios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Cores por ESTADO (cores de status, com rótulo na legenda e na tabela —
 * nunca só a cor): entregue verde, adiada âmbar, recusada vermelha,
 * cancelada cinza.
 */
const SERIES = [
  { key: "delivered", label: "Entregues", one: "entregue", many: "entregues", color: "bg-emerald-500" },
  { key: "deferred", label: "Adiadas", one: "adiada", many: "adiadas", color: "bg-amber-500" },
  { key: "bounced", label: "Recusadas", one: "recusada", many: "recusadas", color: "bg-red-500" },
  { key: "cancelled", label: "Canceladas", one: "cancelada", many: "canceladas", color: "bg-slate-400" },
] as const;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function dayText(d: MailVolumeDay): string {
  const parts = [count(d.delivered, "entregue", "entregues"), count(d.bounced, "recusada", "recusadas"), count(d.deferred, "adiada", "adiadas")];
  if (d.cancelled > 0) parts.push(count(d.cancelled, "cancelada", "canceladas"));
  return `${dayLabel(d.date)}: ${parts.join(", ")}`;
}

/** Barras empilhadas por dia, em HTML puro (sem biblioteca de gráfico). */
function VolumeChart({ days }: { days: MailVolumeDay[] }) {
  const total = (d: MailVolumeDay) => d.delivered + d.deferred + d.bounced + d.cancelled;
  const max = Math.max(1, ...days.map(total));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legenda">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.color)} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="relative">
        <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
          {hover !== null ? dayText(days[hover]!) : "Passe o dedo ou o mouse numa barra para ver os números do dia."}
        </p>
        <div role="img" aria-label={`Envios por dia nos últimos ${days.length} dias`} className="flex h-40 items-end gap-1 border-b border-border/60 pt-2">
          {days.map((d, i) => {
            const t = total(d);
            return (
              <div
                key={d.date}
                data-testid="volume-bar"
                aria-label={dayText(d)}
                title={dayText(d)}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => setHover(i)}
                className={cn(
                  "flex h-full min-w-0 flex-1 cursor-default flex-col-reverse justify-start gap-[2px] rounded-t outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  hover === i && "bg-accent/40",
                )}
              >
                {SERIES.map((s) => {
                  const v = d[s.key];
                  if (v === 0) return null;
                  return <div key={s.key} className={cn("w-full first:rounded-b-none last:rounded-t", s.color)} style={{ height: `${(v / max) * 100}%` }} />;
                })}
                {t === 0 && <div className="h-px w-full bg-border" />}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden>
          <span>{dayLabel(days[0]!.date)}</span>
          <span>{dayLabel(days[Math.floor(days.length / 2)]!.date)}</span>
          <span>{dayLabel(days.at(-1)!.date)}</span>
        </div>
      </div>
    </div>
  );
}

function RateTile({ id, title, rate, limitText }: { id: string; title: string; rate: MailRate; limitText: string }) {
  return (
    <div data-testid={id} className={cn("flex flex-col gap-1 rounded-lg border p-3", rate.high && "border-red-500/40 bg-red-500/5")}>
      <span className="text-xs text-muted-foreground">{title}</span>
      <span className="text-2xl font-semibold tabular-nums">{rate.value === null ? "—" : formatPercent(rate.value)}</span>
      <span className="text-xs text-muted-foreground">Saudável: até {limitText}</span>
      {rate.high && (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5" /> Atenção: acima de {limitText}
        </span>
      )}
    </div>
  );
}

/** Volume: envios por dia e por projeto nos últimos 14 dias, e as taxas. */
export function VolumeSection() {
  const [data, setData] = useState<MailVolumeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const tz = new Date().getTimezoneOffset();
    apiFetch<MailVolumeResponse>(`/api/mail/envios/volume?tz=${tz}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : "Não deu para ler o volume."));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Volume (últimos 14 dias)</CardTitle>
        <CardDescription>Quantas mensagens saíram por dia e o que aconteceu com elas.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <>
            <VolumeChart days={data.days} />
            <div>
              <Button size="sm" variant="outline" onClick={() => setTable((v) => !v)}>
                {table ? "Esconder tabela" : "Ver como tabela"}
              </Button>
            </div>
            {table && (
              <table className="w-full table-fixed text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">Dia</th>
                    <th className="py-1 font-medium">Entregues</th>
                    <th className="py-1 font-medium">Adiadas</th>
                    <th className="py-1 font-medium">Recusadas</th>
                    <th className="py-1 font-medium">Canceladas</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.days.map((d) => (
                    <tr key={d.date} className="border-t">
                      <td className="py-1">{dayLabel(d.date)}</td>
                      <td className="py-1">{d.delivered}</td>
                      <td className="py-1">{d.deferred}</td>
                      <td className="py-1">{d.bounced}</td>
                      <td className="py-1">{d.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RateTile id="rate-bounce" title="Taxa de recusa" rate={data.bounceRate} limitText="2%" />
              <RateTile id="rate-defer" title="Destinatários com adiamento" rate={data.deferRate} limitText="5%" />
              <div className="flex flex-col gap-1 rounded-lg border p-3">
                <span className="text-xs text-muted-foreground">Reclamações (marcado como spam)</span>
                <span className="text-2xl font-semibold">—</span>
                <span className="text-xs text-muted-foreground">
                  O servidor não recebe esse dado. Confira no Google Postmaster Tools: saudável é abaixo de 0,1%.
                </span>
              </div>
            </div>
            {data.lowVolume && (
              <p className="text-xs text-muted-foreground">
                Poucos envios no período: com menos de 50 mensagens, uma ou duas recusas já mexem muito na taxa.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Os limites seguem as recomendações do Google e do Yahoo (recusa e spam baixos); o de adiamento é uma referência do painel.
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Por projeto</h3>
              {data.byProject.length === 0 && <p className="text-xs text-muted-foreground">Nenhum envio no período.</p>}
              <ul className="flex flex-col gap-1">
                {data.byProject.map((p) => (
                  <li key={p.projectId ?? "none"} data-testid={`project-${p.projectId ?? "none"}`} className="flex flex-wrap justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {count(p.delivered, "entregue", "entregues")} · {count(p.deferred, "adiada", "adiadas")} · {count(p.bounced, "recusada", "recusadas")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
