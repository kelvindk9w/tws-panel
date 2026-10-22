/**
 * Saúde do e-mail dentro da página do projeto (aba Remetente do card de
 * e-mail): resumo do domínio do projeto, botão "Verificar a saúde agora" (com
 * espera entre verificações) e uma expansão com os itens do domínio. Uma linha
 * lembra que o DNS reverso (PTR) e a porta 25 são do servidor e vale para
 * todos os projetos, com o estado atual.
 *
 * Reaproveita a rota e o serviço da saúde do domínio (useDeliveryHealth) e as
 * mesmas linhas de item do card completo: nenhuma regra é duplicada.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import { mailHealthScope, type DeliveryHealthResponse, type MailHealthLevel } from "@paas/core";
import { formatDateTime, useI18n } from "@/i18n";
import type { Key } from "@/i18n/keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckRow, LEVEL_BADGE } from "@/components/mail/DeliveryHealthCard";
import { useDeliveryHealth } from "@/components/mail/useDeliveryHealth";
import { ChevronRight, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

function serverItemLevel(report: DeliveryHealthResponse, id: "ptr" | "port25"): MailHealthLevel | null {
  return report.checks.find((c) => c.id === id)?.level ?? null;
}

export function ProjectEmailHealth({ domain }: { domain: string }) {
  const { t } = useI18n();
  const { state, error, checking, cooldown, check } = useDeliveryHealth(domain);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const report = state?.report ?? null;
  const plan = state?.plan ?? null;

  const levelWord = (level: MailHealthLevel | null) => (level ? t(`mailHealth.level.${level}` as Key) : t("mailHealth.project.server.unknown"));
  const domainChecks = report ? report.checks.filter((c) => mailHealthScope(c.id) === "domain") : [];
  const serverNames = (level: MailHealthLevel) =>
    report
      ? report.checks
          .filter((c) => mailHealthScope(c.id) === "server" && c.level === level)
          .map((c) => t(`mailHealth.check.${c.id}` as Key))
          .join(", ")
      : "";
  const serverCritical = serverNames("critical");
  const serverAttention = serverNames("warn");

  return (
    <section
      aria-labelledby={`project-health-${domain}`}
      className="flex flex-col gap-2 rounded-lg border px-4 py-3"
      data-testid="project-email-health"
      data-level={report?.level ?? "unknown"}
      data-server-level={report?.scopes.server.level ?? "unknown"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`project-health-${domain}`} className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" /> {t("mailHealth.project.title")}
        </h3>
        <div className="flex items-center gap-2">
          {report && (
            <Badge variant={LEVEL_BADGE[report.level]} title={t("mailHealth.project.worst")} data-testid="project-email-health-badge">
              {t(`mailHealth.level.${report.level}` as Key)}
            </Badge>
          )}
          <Button size="sm" variant="outline" disabled={checking || cooldown > 0} onClick={() => void check()}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? t("mailHealth.verifying") : cooldown > 0 ? t("mailHealth.cooldown", { seconds: cooldown }) : t("mailHealth.verify")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("mailHealth.project.description", { domain })}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!state && !error && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("mail.common.loading")}
        </p>
      )}
      {state && !report && <p className="text-sm text-muted-foreground">{t("mailHealth.project.neverChecked", { domain })}</p>}
      {report && (
        <>
          <div className="flex flex-col gap-0.5 text-sm">
            <p data-testid="project-email-health-domain-summary">{t("mailHealth.project.summary", report.scopes.domain.counts)}</p>
            <p data-testid="project-email-health-server-summary">{t("mailHealth.project.server.summary", report.scopes.server.counts)}</p>
            <p className="text-xs text-muted-foreground">{t("mailHealth.checkedAt", { date: formatDateTime(report.checkedAt) })}</p>
          </div>
          {serverCritical && (
            <p role="alert" data-severity="critical" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
              {t("mailHealth.project.server.critical", { items: serverCritical })}
            </p>
          )}
          {serverAttention && (
            <p data-severity="warn" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
              {t("mailHealth.project.server.attention", { items: serverAttention })}
            </p>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="flex w-fit items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
            {t("mailHealth.project.expand", { domain })}
          </button>
          {open && (
            <ul id={panelId} data-testid="project-email-health-items">
              {domainChecks.map((c) => (
                <CheckRow key={c.id} check={c} plan={plan} />
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-col gap-1 rounded-md bg-muted/30 px-3 py-2 text-xs" data-testid="project-email-health-server">
        <p>
          {t("mailHealth.project.server.line", {
            ptr: levelWord(report ? serverItemLevel(report, "ptr") : null),
            port25: levelWord(report ? serverItemLevel(report, "port25") : null),
          })}
        </p>
        <p className="text-muted-foreground">{t("mailHealth.project.server.note")}</p>
        <Link to={`/mail/${encodeURIComponent(domain)}?aba=dns`} className="w-fit underline underline-offset-2">
          {t("mailHealth.project.openFull")}
        </Link>
      </div>
    </section>
  );
}
