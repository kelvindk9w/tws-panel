import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { BlacklistResult, BlacklistTargetResult, MailReputationResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { formatDateTime } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";

const DQS_INFO_URL =
  "https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-cloudflares-dns-move-to-spamhaus-technologys-free-data-query-service/";

function ResultRow({ target, r }: { target: string; r: BlacklistResult }) {
  const { t } = useI18n();
  return (
    <li data-testid={`bl-${target}-${r.dnsbl}`} className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.label}</span>
        {r.status === "clean" && <Badge variant="success">{t("envios.reputation.result.clean")}</Badge>}
        {r.status === "listed" && <Badge variant="destructive">{t("envios.reputation.result.listed")}</Badge>}
        {r.status === "unknown" && <Badge variant="warning">{t("envios.reputation.result.unknown")}</Badge>}
      </div>
      {r.status !== "clean" && r.detail && <p className="break-words text-xs text-muted-foreground">{r.detail}</p>}
      {r.status === "listed" && r.removalUrl && (
        <a href={r.removalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
          {t("envios.reputation.result.removal")} <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {r.status === "unknown" && r.lookupUrl && (
        <a href={r.lookupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
          {t("envios.reputation.result.lookup")} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

function TargetBlock({ title, target }: { title: string; target: BlacklistTargetResult }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="break-all text-xs text-muted-foreground">
        {title}: <span className="font-mono">{target.target}</span>
      </h3>
      <ul className="flex flex-col gap-1.5">
        {target.results.map((r) => (
          <ResultRow key={r.dnsbl} target={target.target} r={r} />
        ))}
      </ul>
    </div>
  );
}

/** Reputação: listas de bloqueio (uma vez por dia e no botão) e a chave DQS. */
export function ReputationSection() {
  const { t } = useI18n();
  const [data, setData] = useState<MailReputationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<MailReputationResponse>("/api/mail/envios/reputation"));
    } catch (err) {
      setError(apiErrorText(err, "envios.reputation.error.load"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setData(await apiFetch<MailReputationResponse>("/api/mail/envios/reputation/check", { method: "POST" }));
    } catch (err) {
      setError(apiErrorText(err, "envios.reputation.error.check"));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(value: string | null, e?: FormEvent) {
    e?.preventDefault();
    setKeyBusy(true);
    setKeyError(null);
    try {
      setData(await apiFetch<MailReputationResponse>("/api/mail/envios/reputation/dqs", { method: "PUT", body: JSON.stringify({ key: value }) }));
      setKey("");
    } catch (err) {
      setKeyError(apiErrorText(err, "envios.reputation.error.saveKey"));
    } finally {
      setKeyBusy(false);
    }
  }

  const check_ = data?.lastCheck ?? null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("envios.reputation.blocklists.title")}</CardTitle>
          <CardDescription>
            {t("envios.reputation.blocklists.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || data?.checking} onClick={() => void check()}>
              {busy || data?.checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("envios.reputation.checkNow")}
            </Button>
            {data?.nextCheckAt && <span className="text-xs text-muted-foreground">{t("envios.reputation.nextCheck", { date: formatDateTime(data.nextCheckAt) })}</span>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data?.lastError && <p className="break-words text-xs text-amber-300">{data.lastError}</p>}
          {data && !check_ && <p className="text-sm text-muted-foreground">{t("envios.reputation.notChecked")}</p>}
          {check_ && (
            <>
              <p className="text-xs text-muted-foreground">{t("envios.reputation.checkedAt", { date: formatDateTime(check_.checkedAt) })}</p>
              {check_.ip && <TargetBlock title={t("envios.reputation.target.ip")} target={check_.ip} />}
              {check_.domains.map((d) => (
                <TargetBlock key={d.target} title={t("envios.reputation.target.domain")} target={d} />
              ))}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {t("envios.reputation.microsoftNote")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("envios.reputation.dqs.title")}</CardTitle>
          <CardDescription>
            <Trans
              k="envios.reputation.dqs.desc"
              components={{
                link: (c) => (
                  <a href={DQS_INFO_URL} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                    {c}
                  </a>
                ),
              }}
            />
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data?.dqs.configured && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{t("envios.reputation.dqs.saved", { hint: data.dqs.hint ?? "" })}</span>
              <Button size="sm" variant="outline" disabled={keyBusy} onClick={() => void saveKey(null)}>
                {t("envios.reputation.dqs.delete")}
              </Button>
            </div>
          )}
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => void saveKey(key.trim(), e)}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="dqs-key" className="text-xs text-muted-foreground">
                {t("envios.reputation.dqs.label")} {data?.dqs.configured ? t("envios.reputation.dqs.labelNew") : ""}
              </label>
              <PasswordInput id="dqs-key" revealLabel={t("envios.reputation.dqs.reveal")} value={key} autoComplete="off" maxLength={64} onChange={(e) => setKey(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={keyBusy || key.trim() === ""}>
              {keyBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("envios.reputation.dqs.save")}
            </Button>
          </form>
          {keyError && <p className="text-xs text-destructive">{keyError}</p>}
          <p className="text-xs text-muted-foreground">{t("envios.reputation.dqs.note")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
