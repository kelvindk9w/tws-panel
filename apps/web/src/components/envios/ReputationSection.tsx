import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { BlacklistResult, BlacklistTargetResult, MailReputationResponse } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";

const DQS_INFO_URL =
  "https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-cloudflares-dns-move-to-spamhaus-technologys-free-data-query-service/";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

function ResultRow({ target, r }: { target: string; r: BlacklistResult }) {
  return (
    <li data-testid={`bl-${target}-${r.dnsbl}`} className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.label}</span>
        {r.status === "clean" && <Badge variant="success">Limpo</Badge>}
        {r.status === "listed" && <Badge variant="destructive">Listado</Badge>}
        {r.status === "unknown" && <Badge variant="warning">Não deu para verificar</Badge>}
      </div>
      {r.status !== "clean" && r.detail && <p className="break-words text-xs text-muted-foreground">{r.detail}</p>}
      {r.status === "listed" && r.removalUrl && (
        <a href={r.removalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
          Pedir remoção <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {r.status === "unknown" && r.lookupUrl && (
        <a href={r.lookupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
          Conferir no site <ExternalLink className="h-3 w-3" />
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
      setError(errorText(err, "Não deu para ler a reputação."));
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
      setError(errorText(err, "Não deu para conferir agora."));
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
      setKeyError(errorText(err, "Não deu para salvar a chave."));
    } finally {
      setKeyBusy(false);
    }
  }

  const check_ = data?.lastCheck ?? null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Listas de bloqueio</CardTitle>
          <CardDescription>
            Confere se o IP do servidor e os domínios de e-mail estão em listas que fazem outros servidores recusar mensagens. O painel
            confere sozinho uma vez por dia. Quando a lista não responde, aparece &quot;não deu para verificar&quot; — nunca &quot;limpo&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || data?.checking} onClick={() => void check()}>
              {busy || data?.checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Conferir agora
            </Button>
            {data?.nextCheckAt && <span className="text-xs text-muted-foreground">Próxima conferência automática: {formatDateTime(data.nextCheckAt)}</span>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data?.lastError && <p className="break-words text-xs text-amber-300">{data.lastError}</p>}
          {data && !check_ && <p className="text-sm text-muted-foreground">Ainda não conferido.</p>}
          {check_ && (
            <>
              <p className="text-xs text-muted-foreground">Conferido em {formatDateTime(check_.checkedAt)}</p>
              {check_.ip && <TargetBlock title="IP do servidor" target={check_.ip} />}
              {check_.domains.map((d) => (
                <TargetBlock key={d.target} title="Domínio" target={d} />
              ))}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            A lista de bloqueio da Microsoft (Outlook/Hotmail) não pode ser consultada assim: ela aparece como recusa com o código S3150
            no Histórico. O caminho de liberação é sender.office.com.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Chave DQS da Spamhaus (gratuita)</CardTitle>
          <CardDescription>
            A Spamhaus recusa consultas de servidores DNS públicos ou de muito volume, que é o caso da maioria das VPS. Com a chave
            gratuita do serviço DQS dela, a conferência passa a funcionar.{" "}
            <a href={DQS_INFO_URL} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
              Como conseguir a chave
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data?.dqs.configured && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Chave cadastrada (termina em {data.dqs.hint}).</span>
              <Button size="sm" variant="outline" disabled={keyBusy} onClick={() => void saveKey(null)}>
                Apagar chave
              </Button>
            </div>
          )}
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => void saveKey(key.trim(), e)}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="dqs-key" className="text-xs text-muted-foreground">
                Chave DQS {data?.dqs.configured ? "(nova, para trocar)" : ""}
              </label>
              <PasswordInput id="dqs-key" revealLabel="chave" value={key} autoComplete="off" maxLength={64} onChange={(e) => setKey(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={keyBusy || key.trim() === ""}>
              {keyBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Salvar chave
            </Button>
          </form>
          {keyError && <p className="text-xs text-destructive">{keyError}</p>}
          <p className="text-xs text-muted-foreground">A chave fica guardada no servidor e não volta para a tela.</p>
        </CardContent>
      </Card>
    </div>
  );
}
