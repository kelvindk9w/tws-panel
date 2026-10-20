import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, CircleDashed, CircleHelp, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { DeliverabilityItem, DeliverabilityResponse, PostmasterMarks } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n, type Key } from "@/i18n";
import { formatDateTime } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const GOOGLE_POSTMASTER = "https://postmaster.google.com/";
const MICROSOFT_SNDS = "https://sendersupport.olc.protection.outlook.com/snds/";

const BAND = {
  green: { text: "envios.score.band.green", className: "text-emerald-400" },
  yellow: { text: "envios.score.band.yellow", className: "text-amber-400" },
  red: { text: "envios.score.band.red", className: "text-red-400" },
} as const satisfies Record<string, { text: Key; className: string }>;

const STATUS: Record<DeliverabilityItem["status"], { label: Key; variant: "success" | "warning" | "destructive" | "secondary"; Icon: typeof CheckCircle2 }> = {
  done: { label: "envios.score.status.done", variant: "success", Icon: CheckCircle2 },
  partial: { label: "envios.score.status.partial", variant: "warning", Icon: CircleDashed },
  todo: { label: "envios.score.status.todo", variant: "destructive", Icon: XCircle },
  unknown: { label: "envios.score.status.unknown", variant: "secondary", Icon: CircleHelp },
};

/** ISO → AAAA-MM-DD (campo de data). */
function dateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function ItemRow({ item }: { item: DeliverabilityItem }) {
  const { t } = useI18n();
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
        <Badge variant={s.variant}>{t(s.label)}</Badge>
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
  const { t } = useI18n();
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
      setError(apiErrorText(err, "envios.score.error.load"));
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
      setSaved(t("envios.score.saved"));
      await load();
    } catch (err) {
      setError(apiErrorText(err, "envios.score.error.save"));
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
          <CardTitle className="text-base">{t("envios.score.ready.title")}</CardTitle>
          <CardDescription>
            {t("envios.score.ready.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={cn("text-4xl font-bold tabular-nums", BAND[data.band].className)}>{data.score}</span>
                <span className="text-sm text-muted-foreground">{t("envios.score.outOf", { max: data.max })}</span>
              </div>
              <p className={cn("text-sm", BAND[data.band].className)}>{t(BAND[data.band].text)}</p>
              <p className="text-xs text-muted-foreground">
                {t("envios.score.factsAt", { date: formatDateTime(data.factsAt) })}
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
          <CardTitle className="text-base">{t("envios.score.external.title")}</CardTitle>
          <CardDescription>
            <Trans
              k="envios.score.external.desc"
              components={{
                google: (c) => (
                  <a href={GOOGLE_POSTMASTER} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                    {c}
                  </a>
                ),
                snds: (c) => (
                  <a href={MICROSOFT_SNDS} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                    {c}
                  </a>
                ),
              }}
            />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {field("googleAt", t("envios.score.field.google"))}
              {field("microsoftAt", t("envios.score.field.microsoft"))}
              {field("spamRateOkAt", t("envios.score.field.spam"))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("envios.score.saveMarks")}
              </Button>
              {saved && <span className="text-xs text-emerald-400">{saved}</span>}
            </div>
            <p className="text-xs text-muted-foreground">{t("envios.score.clearHint")}</p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
