import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Ruler, Wrench } from "lucide-react";
import type { AofMeasureResponse, AofRepairResponse, ProjectAofFinding } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { redisAofGuideUrl } from "@/lib/links";
import { apiErrorText } from "@/i18n/api-error";
import { formatNumber, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";

const RESULT_KEY: Record<AofRepairResponse["outcome"], Key> = {
  repaired: "metrics.aof.result.repaired",
  fix_failed: "metrics.aof.result.fix_failed",
  backup_failed: "metrics.aof.result.backup_failed",
  start_failed: "metrics.aof.result.start_failed",
};

/**
 * Serviço em ciclo de reinício porque o arquivo AOF do redis/valkey ficou com o final corrompido (queda brusca
 * da VPS). Diz a causa e oferece o reparo, que NUNCA é automático: a pessoa confirma num diálogo que diz o que
 * vai acontecer (serviço parado, cópia da pasta antes, quantos bytes do fim saem). Quando o redis não informa os
 * bytes (Redis antes do 8.4, Valkey), o botão "Medir" pergunta à ferramenta da própria imagem, sem alterar nada.
 * Com o projeto parado pela pessoa, o serviço fica parado depois do reparo (keptStopped).
 */
export function AofRepairCard({ projectId, findings, onChanged }: { projectId: string; findings: readonly ProjectAofFinding[]; onChanged?: () => void }) {
  if (findings.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="aof-repair">
      {findings.map((f) => (
        <AofFindingItem key={`${f.service}:${f.container}`} projectId={projectId} finding={f} {...(onChanged ? { onChanged } : {})} />
      ))}
    </div>
  );
}

function AofFindingItem({ projectId, finding, onChanged }: { projectId: string; finding: ProjectAofFinding; onChanged?: () => void }) {
  const { t, locale } = useI18n();
  const [measured, setMeasured] = useState<number | null>(null);
  const [busy, setBusy] = useState<"measure" | "repair" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AofRepairResponse | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // trava síncrona: dois cliques antes de o estado atualizar não mandam dois pedidos
  const inFlight = useRef(false);

  const engine = finding.engine;
  // o número que a pessoa confirma: o medido agora (ou o que a ferramenta disse ao recusar) vale mais que o do log
  const bytes = measured ?? finding.bytes;
  const n = (v: number) => formatNumber(v);
  const base = `/api/projects/${encodeURIComponent(projectId)}/aof-repair`;

  async function measure() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("measure");
    setError(null);
    try {
      const r = await apiFetch<AofMeasureResponse>(`${base}/measure`, { method: "POST", body: JSON.stringify({ service: finding.service }) });
      setMeasured(r.bytes);
    } catch (err) {
      setError(apiErrorText(err, "metrics.aof.measureError"));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function repair() {
    if (inFlight.current || bytes === null || !agreed) return;
    inFlight.current = true;
    setBusy("repair");
    setError(null);
    try {
      const r = await apiFetch<AofRepairResponse>(base, { method: "POST", body: JSON.stringify({ service: finding.service, maxBytes: bytes }) });
      setResult(r);
      setConfirming(false);
      onChanged?.();
    } catch (err) {
      const more = err instanceof ApiRequestError && err.code === "aof_discard_exceeds" ? Number(err.data?.bytes) : Number.NaN;
      if (Number.isSafeInteger(more) && more > 0) {
        // a ferramenta cortaria mais que o confirmado: nada foi alterado; a pessoa vê o número novo e decide de novo
        setMeasured(more);
        setAgreed(false);
        setError(t("metrics.aof.exceeds", { bytes: n(more) }));
      } else {
        setError(apiErrorText(err, "metrics.aof.error"));
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const done = result !== null;
  const resultText =
    result === null
      ? null
      : t(result.outcome === "repaired" && result.keptStopped ? "metrics.aof.result.repairedStopped" : RESULT_KEY[result.outcome], { bytes: result.discardedBytes === null ? "?" : n(result.discardedBytes), backup: result.backup ?? "—" });

  return (
    <Card className={done && result.ok ? "border-emerald-500/40" : "border-destructive/50"} data-testid={`aof-finding-${finding.service}`}>
      <CardContent className="flex flex-col gap-3 py-4 text-sm">
        <p className="flex items-start gap-2 font-medium">
          {done && result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />}
          <span className="break-words">{t("metrics.aof.title", { engine, service: finding.service })}</span>
        </p>
        {!done && (
          <>
            <p className="break-words text-muted-foreground">{t("metrics.aof.body", { file: finding.file })}</p>
            <p className="break-words text-muted-foreground" data-testid="aof-bytes">
              {measured !== null
                ? t("metrics.aof.measured", { engine, bytes: n(measured) })
                : finding.bytes !== null
                  ? t("metrics.aof.bytes", { engine, bytes: n(finding.bytes) })
                  : t("metrics.aof.bytesUnknown", { engine })}
            </p>
          </>
        )}

        {error && !confirming && (
          <p role="alert" className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-2" data-testid="aof-result">
            <p role="status" className="break-words">
              {resultText}
            </p>
            {result.keptStopped && result.outcome !== "repaired" && <p className="break-words">{t("metrics.aof.result.keptStopped")}</p>}
            {!result.restarted && !result.keptStopped && result.outcome !== "start_failed" && <p className="break-words text-destructive">{t("metrics.aof.result.notRestarted")}</p>}
            <details className="rounded-md border p-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t("metrics.aof.output")}</summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-xs">{result.output}</pre>
            </details>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!done && bytes === null && (
            <Button type="button" size="sm" variant="outline" onClick={() => void measure()} disabled={busy !== null}>
              {busy === "measure" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ruler className="h-4 w-4" />}
              {busy === "measure" ? t("metrics.aof.measuring") : t("metrics.aof.measure")}
            </Button>
          )}
          {!done && bytes !== null && (
            <Button
              ref={trigger}
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                setAgreed(false);
                setError(null);
                setConfirming(true);
              }}
            >
              <Wrench className="h-4 w-4" />
              {t("metrics.aof.repair", { engine })}
            </Button>
          )}
          <a href={redisAofGuideUrl(locale)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
            {t("metrics.aof.guide")}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      </CardContent>

      {confirming && bytes !== null && (
        <Modal
          title={t("metrics.aof.confirm.title", { engine })}
          busy={busy === "repair"}
          returnFocusRef={trigger}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={busy === "repair"}>
                {t("metrics.aof.confirm.cancel")}
              </Button>
              <Button type="button" variant="destructive" onClick={() => void repair()} disabled={!agreed || busy === "repair"}>
                {busy === "repair" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                {busy === "repair" ? t("metrics.aof.running") : t("metrics.aof.confirm.ok")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm" data-testid="aof-confirm">
            <p>{t("metrics.aof.confirm.intro", { service: finding.service })}</p>
            <ol className="ml-5 list-decimal space-y-1.5 break-words">
              <li>{t("metrics.aof.confirm.stop")}</li>
              <li>{t("metrics.aof.confirm.backup")}</li>
              <li className="font-medium">{t("metrics.aof.confirm.discard", { bytes: n(bytes) })}</li>
              <li>{t("metrics.aof.confirm.restart")}</li>
            </ol>
            {error && (
              <p role="alert" className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={busy === "repair"} />
              <span>{t("metrics.aof.confirm.check")}</span>
            </label>
          </div>
        </Modal>
      )}
    </Card>
  );
}
