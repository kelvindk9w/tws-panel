/**
 * "Não procede — não avisar mais": a ação em cada achado dos guardrails (diálogo de bloqueio do deploy e avisos
 * da Visão geral) e a seção recolhida "Alertas dispensados (N)", com "Voltar a avisar".
 *
 * A dispensa vale para o projeto e para o achado exato (regra + serviço + variável/alvo). Regras inegociáveis
 * (isolamento do painel, privileged, docker.sock, rede do host) não mostram a ação. Dispensar um BLOQUEIO pede a
 * mesma prova do override (senha + código do app); aviso pede só a sessão. Token de API nunca dispensa.
 */
import { useCallback, useEffect, useState } from "react";
import {
  GUARDRAIL_DISMISSAL_REASON_MAX,
  guardrailDismissalFor,
  guardrailDismissNeedsProof,
  isGuardrailDismissible,
  type GuardrailDismissal,
  type GuardrailDismissalListResponse,
  type GuardrailDismissalScope,
  type GuardrailDismissFinding,
  type GuardrailDismissResponse,
  type GuardrailWarning,
  type ProjectResponse,
} from "@paas/core";
import { AlertTriangle, BellRing, ChevronDown, ChevronRight, EyeOff, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { cn } from "@/lib/utils";

/** Botão "Não procede" de um achado; não aparece para regra inegociável. */
export function DismissFindingButton({ finding, onClick }: { finding: GuardrailDismissFinding; onClick: () => void }) {
  const { t } = useI18n();
  if (!isGuardrailDismissible(finding.rule)) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      <EyeOff className="h-3 w-3" /> {t("projects.dismiss.action")}
    </button>
  );
}

/** Diálogo da dispensa: abrangência, motivo opcional e, para bloqueio, a reautenticação. */
export function GuardrailDismissDialog({
  projectId,
  finding,
  onClose,
  onDone,
}: {
  projectId: string;
  finding: GuardrailDismissFinding;
  onClose: () => void;
  /** Gravou: o aviso de e-mail não enviado (quando houver) vem junto. */
  onDone: (alertWarning: string | null) => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<GuardrailDismissalScope>("project");
  const [reason, setReason] = useState("");
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proof = guardrailDismissNeedsProof(finding.rule);
  const ready = !busy && (!proof || (reauth.password.length > 0 && reauth.code.trim().length > 0));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GuardrailDismissResponse>(`/api/projects/${projectId}/guardrails/dismissals`, {
        method: "POST",
        body: JSON.stringify({
          finding: {
            rule: finding.rule,
            title: finding.title,
            ...(finding.evidence ? { evidence: finding.evidence } : {}),
            ...(finding.service ? { service: finding.service } : {}),
            ...(finding.target ? { target: finding.target } : {}),
          },
          scope,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(proof ? reauthPayload(reauth) : {}),
        }),
      });
      onDone(res.alertWarning ?? null);
    } catch (err) {
      setError(apiErrorText(err, "projects.dismiss.error"));
      setReauth({ ...reauth, code: "", emailCode: "" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dismiss-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-auto rounded-xl border bg-background p-6 shadow-2xl"
      >
        <h2 id="dismiss-title" className="flex items-center gap-2 text-lg font-semibold">
          <EyeOff className="h-5 w-5" /> {t("projects.dismiss.title")}
        </h2>
        <div className="rounded-lg border bg-black/40 p-3 text-sm">
          <div className="font-medium">{finding.title}</div>
          <div className="pt-1 text-xs text-muted-foreground">
            <code>[{finding.rule}]</code>
            {finding.target && <> · {t("projects.dismiss.target", { target: finding.target })}</>}
            {finding.service && <> · {t("projects.dismiss.service", { service: finding.service })}</>}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{t("projects.dismiss.explain")}</p>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="pb-1 font-medium">{t("projects.dismiss.scope")}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="dismiss-scope" checked={scope === "project"} onChange={() => setScope("project")} />
            {t("projects.dismiss.scopeProject")}
          </label>
          <label className={cn("flex items-center gap-2", !finding.service && "opacity-50")}>
            <input
              type="radio"
              name="dismiss-scope"
              checked={scope === "service"}
              disabled={!finding.service}
              onChange={() => setScope("service")}
            />
            {finding.service ? t("projects.dismiss.scopeService", { service: finding.service }) : t("projects.dismiss.scopeServiceNone")}
          </label>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("projects.dismiss.reason")}</span>
          <textarea
            value={reason}
            maxLength={GUARDRAIL_DISMISSAL_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder={t("projects.dismiss.reasonPlaceholder")}
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
          />
        </label>
        {proof && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-xs text-muted-foreground">{t("projects.dismiss.reauth")}</p>
            <ReauthFields idPrefix="dismiss" action="deploy.override" value={reauth} onChange={setReauth} />
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t("projects.dismiss.cancel")}
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <EyeOff className="h-4 w-4" />}
            {t("projects.dismiss.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Seção recolhida "Alertas dispensados (N)": quem, quando, motivo e "Voltar a avisar". */
export function DismissedGuardrailsSection({
  projectId,
  dismissals,
  onRestored,
}: {
  projectId: string;
  dismissals: GuardrailDismissal[];
  onRestored: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (dismissals.length === 0) return null;

  async function restore(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/guardrails/dismissals/${id}`, { method: "DELETE" });
      onRestored();
    } catch (err) {
      setError(apiErrorText(err, "projects.dismiss.restoreError"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card data-testid="dismissed-guardrails">
      <CardHeader className="pb-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <CardTitle className="text-base">{t("projects.dismiss.sectionTitle", { n: dismissals.length })}</CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("projects.dismiss.sectionHint")}</p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <ul className="flex flex-col gap-2 text-sm">
            {dismissals.map((d) => (
              <li key={d.id} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{d.title}</div>
                  <div className="text-xs text-muted-foreground">
                    <code>[{d.rule}]</code> · {d.match === "target" ? t("projects.dismiss.target", { target: d.value }) : <span className="break-all font-mono">{d.value}</span>} ·{" "}
                    {d.service === null ? t("projects.dismiss.allServices") : t("projects.dismiss.service", { service: d.service })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("projects.dismiss.byAt", { by: d.by, at: formatDateTime(d.at) })}
                  </div>
                  <div className="text-xs">{d.reason ? t("projects.dismiss.reasonShown", { reason: d.reason }) : t("projects.dismiss.noReason")}</div>
                </div>
                <Button variant="outline" size="sm" disabled={busyId !== null} onClick={() => void restore(d.id)}>
                  {busyId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                  {t("projects.dismiss.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

/** Lista das dispensas do projeto (recarregável). Falha na leitura = lista vazia (os avisos aparecem todos). */
export function useGuardrailDismissals(projectId: string | null) {
  const [dismissals, setDismissals] = useState<GuardrailDismissal[]>([]);
  const reload = useCallback(() => {
    if (!projectId) return;
    apiFetch<GuardrailDismissalListResponse>(`/api/projects/${projectId}/guardrails/dismissals`)
      .then((r) => setDismissals(Array.isArray(r?.dismissals) ? r.dismissals : []))
      .catch(() => setDismissals([]));
  }, [projectId]);
  useEffect(() => reload(), [reload]);
  return { dismissals, reload };
}

/**
 * Avisos da detecção na Visão geral (o card "Guardrails (N)"), sem os dispensados, cada um com "Não procede",
 * e logo abaixo a seção "Alertas dispensados (N)".
 */
export function ProjectGuardrailNotices({ project }: { project: ProjectResponse["project"] }) {
  const { t } = useI18n();
  const { dismissals, reload } = useGuardrailDismissals(project.id);
  const [dismissing, setDismissing] = useState<GuardrailDismissFinding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const warnings = activeWarnings(project.detection?.warnings ?? [], dismissals);
  return (
    <>
      {warnings.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-amber-400">
              <AlertTriangle className="h-4 w-4" /> {t("projects.detail.guardrails", { n: warnings.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", w.severity === "critical" ? "bg-red-400" : "bg-amber-400")}
                  />
                  <span className="min-w-0 flex-1">
                    {w.service && <code className="mr-1 text-xs">[{w.service}]</code>}
                    {w.message}
                    <WarningDismiss warning={w} onDismiss={setDismissing} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          {notice}
        </p>
      )}
      <DismissedGuardrailsSection projectId={project.id} dismissals={dismissals} onRestored={reload} />
      {dismissing && (
        <GuardrailDismissDialog
          projectId={project.id}
          finding={dismissing}
          onClose={() => setDismissing(null)}
          onDone={(warning) => {
            setDismissing(null);
            setNotice(warning);
            reload();
          }}
        />
      )}
    </>
  );
}

/** "Não procede" ao lado de um aviso da detecção (nada quando o aviso não é de uma regra dispensável). */
export function WarningDismiss({ warning, onDismiss }: { warning: GuardrailWarning; onDismiss: (f: GuardrailDismissFinding) => void }) {
  const finding = warningAsFinding(warning);
  if (!finding) return null;
  return (
    <span className="ml-2">
      <DismissFindingButton finding={finding} onClick={() => onDismiss(finding)} />
    </span>
  );
}

/** O aviso da detecção como achado para a dispensa (null = aviso sem regra do deploy: não se dispensa). */
export function warningAsFinding(w: GuardrailWarning): GuardrailDismissFinding | null {
  return w.rule ? { rule: w.rule, title: w.message, ...pick(w) } : null;
}

/** Avisos da detecção que continuam valendo (sem os dispensados). */
export function activeWarnings(warnings: readonly GuardrailWarning[], dismissals: readonly GuardrailDismissal[]): GuardrailWarning[] {
  return warnings.filter((w) => {
    const f = warningAsFinding(w);
    return !f || !guardrailDismissalFor(f, dismissals);
  });
}

/** Campos opcionais do aviso que identificam o achado (só os presentes). */
function pick(w: { service?: string; target?: string; evidence?: string }): Pick<GuardrailDismissFinding, "service" | "target" | "evidence"> {
  return {
    ...(w.service ? { service: w.service } : {}),
    ...(w.target ? { target: w.target } : {}),
    ...(w.evidence ? { evidence: w.evidence } : {}),
  };
}
