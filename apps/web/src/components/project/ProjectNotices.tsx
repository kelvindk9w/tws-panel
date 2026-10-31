/**
 * Avisos do Laravel na visão geral do projeto: fila sem worker (aviso) e LOG_CHANNEL (dica discreta, dispensável por
 * projeto). Se a consulta falhar, não mostra nada: é complemento, não pode atrapalhar a página.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import type { ProjectMailDiagnosis } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { emailTroubleshootingGuideUrl } from "@/lib/links";
import { useI18n } from "@/i18n";

const dismissKey = (projectId: string) => `paas.notice.log_channel_stderr.${projectId}`;

function readDismissed(projectId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function ProjectNotices({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const [codes, setCodes] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(() => readDismissed(projectId));

  useEffect(() => {
    let cancelled = false;
    setCodes([]);
    setDismissed(readDismissed(projectId));
    apiFetch<ProjectMailDiagnosis>(`/api/projects/${encodeURIComponent(projectId)}/email/diagnostico?only=notices`)
      .then((d) => {
        if (!cancelled) setCodes(Array.isArray(d?.notices) ? d.notices.map((n) => n.code) : []);
      })
      .catch(() => {
        if (!cancelled) setCodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function dismiss() {
    try {
      window.localStorage.setItem(dismissKey(projectId), "1");
    } catch {
      // sem armazenamento: some só nesta visita
    }
    setDismissed(true);
  }

  const queue = codes.includes("queue_no_worker");
  const log = codes.includes("log_channel_stderr") && !dismissed;
  if (!queue && !log) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="project-notices">
      {queue && (
        <div role="alert" data-testid="notice-queue_no_worker" className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong>{t("diagnostico.notice.queue.title")}</strong>
            <span>{t("diagnostico.notice.queue.fixSync")}</span>
            <span>{t("diagnostico.notice.queue.fixWorker")}</span>
            <a href={emailTroubleshootingGuideUrl(locale)} target="_blank" rel="noreferrer" className="w-fit underline">
              {t("diagnostico.why.docs")}
            </a>
          </div>
        </div>
      )}
      {log && (
        <p data-testid="notice-log_channel_stderr" className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t("diagnostico.notice.log.text")}</span>
          <button type="button" aria-label={t("diagnostico.notice.log.dismiss")} onClick={dismiss} className="rounded p-0.5 hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
    </div>
  );
}
