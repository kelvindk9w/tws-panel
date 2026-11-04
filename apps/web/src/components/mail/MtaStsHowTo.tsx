/**
 * Caixa do MTA-STS na saúde do envio de e-mail.
 *
 *  - Política ATIVA (abre em HTTPS e é válida): sem passos de configuração; só um "Detalhes" recolhido com os
 *    valores, para consulta.
 *  - Falta algo: "O que fazer" mostra a situação (A, TXT e política, cada um com ✓ ou ✗ e a palavra "Pronto" ou
 *    "Falta", nunca só a cor) e SÓ os passos do que falta, com os valores para copiar.
 *  - O botão "Verificar" roda só este item na hora (POST .../mta-sts/verify): consulta o A e o TXT, o painel
 *    registra o nome no proxy se faltar, dispara a emissão do certificado se o DNS aponta e acompanha ("emitindo…",
 *    nova conferência a cada poucos segundos, até um limite). Se falta DNS, mostra exatamente qual registro, com
 *    o valor certo do `id` e o botão de copiar. O DNS é do cliente: o painel não cria esses dois registros.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isMtaStsActive, mtaStsProgress, type DeliveryHealthStateResponse, type DnsPlanResponse, type MailHealthCheck, type MtaStsMissingRecord, type MtaStsVerifyResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { CopyButton } from "@/components/mail/CopyButton";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, RefreshCw, XCircle } from "lucide-react";

/** Quantas conferências de acompanhamento depois do clique, no máximo. */
export const MTA_STS_MAX_FOLLOW_UPS = 8;

type Tri = boolean | null;

function StatusRow({ done, label, id }: { done: Tri; label: string; id: string }) {
  const { t } = useI18n();
  const word = done === true ? t("mailHealth.mtasts.state.done") : done === false ? t("mailHealth.mtasts.state.missing") : t("mailHealth.mtasts.state.unknown");
  return (
    <li className="flex items-center gap-2" data-status-row={id} data-done={done === null ? "unknown" : String(done)}>
      {done === true ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
      ) : done === false ? (
        <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
      ) : (
        <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span>{label}</span>
      <span className="font-medium">· {word}</span>
    </li>
  );
}

function CopyLine({ label, text, tag }: { label: string; text: string; tag: string }) {
  const { t } = useI18n();
  return (
    <li className="flex min-w-0 items-start gap-1" data-copy={tag}>
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <code className="min-w-0 whitespace-pre-wrap break-all font-mono">{text}</code>
      <CopyButton text={text} ariaLabel={t("mailHealth.howto.copyAria", { label })} />
    </li>
  );
}

export function MtaStsHowTo({
  check,
  plan,
  onHealth,
}: {
  check: MailHealthCheck;
  plan: DnsPlanResponse;
  /** A saúde do domínio já com o item reavaliado pelo servidor (a linha, o aviso do topo e as contagens passam a mostrá-la). */
  onHealth?: (health: DeliveryHealthStateResponse) => void;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<MtaStsVerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const run = useCallback(
    async (count: number) => {
      if (timer.current) clearTimeout(timer.current);
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch<MtaStsVerifyResponse>(`/api/mail/domains/${encodeURIComponent(plan.domain)}/mta-sts/verify`, {
          method: "POST",
          body: JSON.stringify({ followUp: count > 0 }),
        });
        if (!mounted.current) return;
        setResult(res);
        setFollow(count);
        if (res.health) onHealth?.(res.health);
        // Emitindo: confere de novo daqui a poucos segundos, até um limite.
        if (res.state === "issuing" && res.retryAfter !== null && count < MTA_STS_MAX_FOLLOW_UPS) {
          timer.current = setTimeout(() => void run(count + 1), res.retryAfter * 1000);
        }
      } catch (err) {
        if (mounted.current) setError(apiErrorText(err, "mailHealth.mtasts.result.error"));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [plan.domain, onHealth],
  );

  // O estado vem do servidor (a mesma avaliação do item da saúde): o navegador não deduz "ativo" por conta própria.
  const active = result ? result.state === "active" : isMtaStsActive(check);
  const progress = result ? result.progress : mtaStsProgress(check.code);
  const idGrace = result ? result.idGrace : check.code === "id_grace";
  const aRecord = plan.records.find((r) => r.id === "mta_sts_a");
  const txtRecord = plan.records.find((r) => r.id === "mta_sts");
  const missingOf = (id: MtaStsMissingRecord["id"]) => result?.missing.find((m) => m.id === id);
  const txtValue = missingOf("mta_sts")?.value ?? txtRecord?.value ?? "";
  const txtOutdated = missingOf("mta_sts")?.outdated === true || check.code === "id_outdated";
  const certFailed = check.code === "cert_failed" || result?.certificate === "failed";
  const url = `https://mta-sts.${plan.domain}/.well-known/mta-sts.txt`;
  const mailHost = plan.records.find((r) => r.id === "a")?.name ?? plan.serverHostname;

  const showA = progress.a !== true;
  const showTxt = progress.txt !== true;
  const showPolicy = !showA && !showTxt && progress.policy !== true;
  const noSteps = !showA && !showTxt && !showPolicy;
  const gain = t("mailHealth.howto.mta_sts.gain");

  return (
    <div className="flex flex-col gap-2" data-howto="mta_sts" data-mta-sts-active={active ? "true" : "false"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
        {active ? t("mailHealth.mtasts.details") : t("mailHealth.howto.button")}
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={active ? t("mailHealth.mtasts.detailsRegion") : t("mailHealth.howto.region", { check: t("mailHealth.check.mta_sts") })}
          className="flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/20 px-3 py-2 text-xs [overflow-wrap:anywhere]"
        >
          {active ? (
            <>
              <p className="text-muted-foreground">{t("mailHealth.mtasts.detailsNote")}</p>
              {idGrace && <p className="text-amber-300">{t("mailHealth.mtasts.idGrace")}</p>}
              <ul className="flex flex-col gap-1">
                {aRecord && <CopyLine tag="aName" label={t("mailHealth.howto.label.aName")} text={aRecord.name} />}
                {aRecord && <CopyLine tag="ip" label={t("mailHealth.howto.label.ip")} text={aRecord.value} />}
                {txtRecord && <CopyLine tag="txtName" label={t("mailHealth.howto.label.txtName")} text={txtRecord.name} />}
                {txtRecord && <CopyLine tag="txtValue" label={t("mailHealth.howto.label.txtValue")} text={txtValue} />}
                <CopyLine tag="url" label={t("mailHealth.howto.label.url")} text={url} />
                <CopyLine tag="policy" label={t("mailHealth.howto.label.policy")} text={plan.mtaStsPolicy} />
              </ul>
            </>
          ) : (
            <>
              <p className="font-medium">{t("mailHealth.howto.optional")}</p>
              <p>{t("mailHealth.mtasts.intro")}</p>
              <div className="flex flex-col gap-1">
                <p className="font-medium">{t("mailHealth.mtasts.statusTitle")}</p>
                <ul className="flex flex-col gap-1" aria-label={t("mailHealth.mtasts.statusTitle")}>
                  <StatusRow id="a" done={progress.a} label={t("mailHealth.mtasts.status.a")} />
                  <StatusRow id="txt" done={progress.txt} label={t("mailHealth.mtasts.status.txt")} />
                  <StatusRow id="policy" done={progress.policy} label={t("mailHealth.mtasts.status.policy")} />
                </ul>
              </div>
              <ol className="flex flex-col gap-2">
                {showA && (
                  <li data-step="a" className="flex flex-col gap-1">
                    <span className="flex items-start gap-1">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
                      <span>
                        <span className="sr-only">{t("mailHealth.mtasts.state.missing")}: </span>
                        {t("mailHealth.mtasts.step.a", { mailHost })}
                      </span>
                    </span>
                    <ul className="flex flex-col gap-1 pl-5">
                      {aRecord && <CopyLine tag="aName" label={t("mailHealth.howto.label.aName")} text={aRecord.name} />}
                      {aRecord && <CopyLine tag="ip" label={t("mailHealth.howto.label.ip")} text={aRecord.value} />}
                    </ul>
                  </li>
                )}
                {showTxt && (
                  <li data-step="txt" className="flex flex-col gap-1">
                    <span className="flex items-start gap-1">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
                      <span>
                        <span className="sr-only">{t("mailHealth.mtasts.state.missing")}: </span>
                        {txtOutdated ? t("mailHealth.mtasts.step.txt.outdated") : t("mailHealth.mtasts.step.txt")}
                      </span>
                    </span>
                    <ul className="flex flex-col gap-1 pl-5">
                      {txtRecord && <CopyLine tag="txtName" label={t("mailHealth.howto.label.txtName")} text={txtRecord.name} />}
                      {txtRecord && <CopyLine tag="txtValue" label={t("mailHealth.howto.label.txtValue")} text={txtValue} />}
                    </ul>
                  </li>
                )}
                {showPolicy && (
                  <li data-step="policy" className="flex items-start gap-1">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
                    <span>
                      <span className="sr-only">{t("mailHealth.mtasts.state.missing")}: </span>
                      {certFailed ? t("mailHealth.mtasts.step.policy.failed") : t("mailHealth.mtasts.step.policy")}
                    </span>
                  </li>
                )}
              </ol>
              {noSteps && (
                <p className="text-amber-300" data-testid="mta-sts-attention">
                  {t("mailHealth.mtasts.attention")}
                </p>
              )}
              <p>{t("mailHealth.howto.gain", { gain })}</p>
            </>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(0)} aria-describedby={`${panelId}-hint`}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                {busy ? t("mailHealth.mtasts.verifying") : t("mailHealth.mtasts.verify")}
              </Button>
              <span id={`${panelId}-hint`} className="text-muted-foreground">
                {t("mailHealth.mtasts.verifyHint")}
              </span>
            </div>
            <div role="status" aria-live="polite" aria-label={t("mailHealth.mtasts.result.region")} className="flex flex-col gap-1" data-testid="mta-sts-result">
              {error && <p className="text-destructive">{error}</p>}
              {result && <VerifyOutcome result={result} follow={follow} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** O que a verificação concluiu: ativo, emitindo (com a próxima conferência), DNS faltando ou indisponível. */
function VerifyOutcome({ result, follow }: { result: MtaStsVerifyResponse; follow: number }) {
  const { t } = useI18n();
  return (
    <>
      {result.published && <p>{t("mailHealth.mtasts.result.published")}</p>}
      {result.issuanceTriggered && <p>{t("mailHealth.mtasts.result.triggered")}</p>}
      {result.state === "active" && (
        <p className="flex items-center gap-1 font-medium" data-outcome="active">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />{" "}
          {result.check?.code === "enforce" ? t("mailHealth.mtasts.result.activeEnforce") : t("mailHealth.mtasts.result.active")}
        </p>
      )}
      {result.state === "missing_txt" && result.missing.length === 0 && <p data-outcome="missing-txt">{t("mailHealth.mtasts.result.missingTxt")}</p>}
      {result.state === "attention" && (
        <p className="text-amber-300" data-outcome="attention">
          {t("mailHealth.mtasts.result.attention")}
        </p>
      )}
      {result.state === "unverified" && <p data-outcome="unverified">{t("mailHealth.mtasts.result.unverified")}</p>}
      {result.warmLimitUntil && (
        <p className="text-amber-300" data-outcome="warm-limit">
          {t("mailHealth.mtasts.result.warmLimit", { time: new Date(result.warmLimitUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}
        </p>
      )}
      {result.state === "issuing" && result.warmLimitUntil === null &&
        (follow < MTA_STS_MAX_FOLLOW_UPS && result.retryAfter !== null ? (
          <p className="flex items-center gap-1" data-outcome="issuing">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            {t("mailHealth.mtasts.result.issuing", { seconds: result.retryAfter, n: follow + 1, max: MTA_STS_MAX_FOLLOW_UPS + 1 })}
          </p>
        ) : (
          <p data-outcome="issuing-long">{t("mailHealth.mtasts.result.issuingLong")}</p>
        ))}
      {result.state === "issuing" && result.certificate === "failed" && <p className="text-amber-300">{t("mailHealth.mtasts.result.certFailed")}</p>}
      {result.state === "waiting_dns" && result.missing.length === 0 && <p data-outcome="unknown">{t("mailHealth.mtasts.result.unknown")}</p>}
      {result.state === "unavailable" && <p data-outcome="unavailable">{t("mailHealth.mtasts.result.unavailable")}</p>}
      {result.missing.length > 0 && (
        <div className="flex flex-col gap-1" data-outcome="missing">
          <p className="font-medium">{t("mailHealth.mtasts.result.waiting")}</p>
          <ul className="flex flex-col gap-1">
            {result.missing.map((m) => (
              <li key={m.id} className="flex items-start gap-1" data-missing={m.id}>
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
                <span>
                  {m.id === "mta_sts_a" ? t("mailHealth.mtasts.missing.a") : m.outdated ? t("mailHealth.mtasts.missing.txtOutdated") : t("mailHealth.mtasts.missing.txt")}{" "}
                  <code className="font-mono">{m.name}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

