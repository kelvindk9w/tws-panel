import { useEffect, useState } from "react";
import type { ProjectMailDiagnosis } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { emailTroubleshootingGuideUrl } from "@/lib/links";
import { hintText, refusalText } from "@/lib/mail-diagnosis";
import { formatDateTime, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Busca o diagnóstico de e-mail do projeto; falha = null (a tela some em silêncio, é só um complemento). */
export function useMailDiagnosis(projectId: string): ProjectMailDiagnosis | null {
  const [diag, setDiag] = useState<ProjectMailDiagnosis | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDiag(null);
    apiFetch<ProjectMailDiagnosis>(`/api/projects/${encodeURIComponent(projectId)}/email/diagnostico`)
      .then((d) => {
        if (!cancelled) setDiag(d && typeof d === "object" && Array.isArray(d.hints) ? d : null);
      })
      .catch(() => {
        if (!cancelled) setDiag(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return diag;
}

/**
 * Aba Envios do projeto: "Última tentativa de conexão do app" e, quando nenhum e-mail saiu na janela,
 * o cartão "Por que nada chegou?" com cada causa provável e o que fazer.
 */
export function MailDiagnosisPanel({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const diag = useMailDiagnosis(projectId);
  if (!diag) return null;

  const last = diag.lastAttempt;
  let attempt: string;
  if (!last) attempt = t("diagnostico.attempt.never");
  else if (last.outcome === "accepted") attempt = t("diagnostico.attempt.accepted", { date: formatDateTime(last.at) });
  else {
    const reason = last.kind ? refusalText(last.kind)?.title : undefined;
    attempt = reason
      ? t("diagnostico.attempt.refusedReason", { date: formatDateTime(last.at), reason })
      : t("diagnostico.attempt.refused", { date: formatDateTime(last.at) });
  }

  const hints = diag.hints.map((h) => ({ h, text: hintText(h) })).filter((x) => x.text !== null);

  return (
    <div className="flex flex-col gap-3" data-testid="mail-diagnosis">
      <p data-testid="last-attempt" className="text-sm">
        <span className="text-muted-foreground">{t("diagnostico.attempt.label")}: </span>
        <span className="font-medium">{attempt}</span>
      </p>
      {diag.noSendsRecent && (
        <Card data-testid="why-nothing">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("diagnostico.why.title")}</CardTitle>
            <CardDescription>{t("diagnostico.why.desc", { hours: diag.windowHours })}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {hints.length === 0 && <p className="text-sm text-muted-foreground">{t("diagnostico.why.empty")}</p>}
            {hints.length > 0 && (
              <ul className="flex flex-col gap-2">
                {hints.map(({ h, text }) => (
                  <li key={h.code} data-testid={`hint-${h.code}`} className="flex flex-col gap-0.5 rounded-md border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{text!.title}</span>
                      <Badge variant={h.severity === "problem" ? "destructive" : "secondary"}>
                        {h.severity === "problem" ? t("diagnostico.why.problem") : t("diagnostico.why.info")}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground">{text!.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <a href={emailTroubleshootingGuideUrl(locale)} target="_blank" rel="noreferrer" className="w-fit text-sm underline">
              {t("diagnostico.why.docs")}
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
