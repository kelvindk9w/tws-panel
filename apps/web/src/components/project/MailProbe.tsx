import { useState } from "react";
import { Check, Circle, Loader2, Plug, X } from "lucide-react";
import type { MailProbeResult } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { probeErrorText, probeFailureText, probeStepStates, type ProbeStepState } from "@/lib/mail-diagnosis";
import { useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";

const STEP_KEYS = {
  connect: "diagnostico.probe.step.connect",
  ehlo: "diagnostico.probe.step.ehlo",
  starttls: "diagnostico.probe.step.starttls",
  certificate: "diagnostico.probe.step.certificate",
  auth: "diagnostico.probe.step.auth",
} as const satisfies Record<string, Key>;

const MARK_KEYS: Record<ProbeStepState, Key> = {
  passed: "diagnostico.probe.mark.passed",
  failed: "diagnostico.probe.mark.failed",
  notReached: "diagnostico.probe.mark.notReached",
};

/** Botão "Testar conexão a partir do app" da aba E-mail do projeto: mostra as etapas e o motivo da primeira falha. */
export function MailProbe({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MailProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiFetch<MailProbeResult>(`/api/projects/${encodeURIComponent(projectId)}/email/testar-conexao`, { method: "POST" }));
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : "";
      const status = err instanceof ApiRequestError ? err.status : 0;
      setError(probeErrorText(code, status));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="mail-probe">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {busy ? t("diagnostico.probe.running") : t("diagnostico.probe.button")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("diagnostico.probe.note")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div role="status" data-testid="probe-result" data-ok={result.ok ? "true" : "false"} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className={result.ok ? "text-emerald-400" : "font-medium text-destructive"}>
            {result.ok
              ? t("diagnostico.probe.ok", { host: result.host, port: result.port, ms: result.elapsedMs })
              : t("diagnostico.probe.fail", {
                  step: result.failedStep ? t(STEP_KEYS[result.failedStep]) : "",
                  host: result.host,
                  port: result.port,
                  ms: result.elapsedMs,
                })}
          </p>
          <ol aria-label={t("diagnostico.probe.steps")} className="flex flex-col gap-1">
            {probeStepStates(result).map(({ step, state }) => (
              <li key={step} data-step={step} data-state={state} className="flex items-center gap-2">
                {state === "passed" ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : state === "failed" ? (
                  <X className="h-4 w-4 text-destructive" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span>{t(STEP_KEYS[step])}</span>
                <span className="text-xs text-muted-foreground">({t(MARK_KEYS[state])})</span>
              </li>
            ))}
          </ol>
          {!result.ok && <p data-testid="probe-failure">{probeFailureText(result.failure)}</p>}
          {result.detail && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">{t("diagnostico.probe.detail")}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{result.detail}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
