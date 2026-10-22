/**
 * Saúde do envio de e-mail de um domínio: nota por verificação (em ordem /
 * atenção / crítico), "Verificar agora", aviso claro quando algo que afeta a
 * caixa de entrada está pendente e o passo a passo do DNS (ordem, valor pronto
 * para copiar, Cloudflare em nuvem cinza, PTR no provedor da VPS).
 *
 * Nunca promete caixa de entrada: o texto fala em "aumenta as chances" e em
 * estar conforme o que Gmail, Yahoo e Microsoft pedem de quem envia.
 *
 * Aparece no topo do checklist de DNS (página do domínio e aba DNS do projeto).
 * Carrega os próprios dados a partir de `domain`.
 */
import {
  mailHealthScope,
  type DeliveryHealthResponse,
  type DnsPlanRecord,
  type DnsPlanResponse,
  type MailHealthCheck,
  type MailHealthLevel,
  type MailHealthScope,
} from "@paas/core";
import { formatDateTime, useI18n } from "@/i18n";
import type { Key } from "@/i18n/keys";
import { emailDeliverabilityGuideUrl } from "@/lib/links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/mail/CopyButton";
import { HealthHowTo } from "@/components/mail/HealthHowTo";
import { useDeliveryHealth } from "@/components/mail/useDeliveryHealth";
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";

export function LevelIcon({ level }: { level: MailHealthLevel }) {
  switch (level) {
    case "ok":
      return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />;
    case "warn":
      return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />;
    case "critical":
      return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />;
    case "info":
      return <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />;
  }
}

export const LEVEL_BADGE: Record<MailHealthLevel, "success" | "warning" | "destructive" | "secondary"> = {
  ok: "success",
  warn: "warning",
  critical: "destructive",
  info: "secondary",
};

export function CheckRow({ check, plan }: { check: MailHealthCheck; plan: DnsPlanResponse | null }) {
  const { t } = useI18n();
  // O nome do servidor (HELO) usa as mesmas mensagens do registro A.
  const family = check.id === "helo" ? "a" : check.id;
  const message = t(`mailHealth.msg.${family}.${check.code}` as Key, check.params);
  const showCompare = check.level !== "ok" && check.level !== "info" && check.expected !== undefined && (check.id === "spf" || check.id === "dkim" || check.id === "dmarc" || check.id === "mx" || check.id === "ptr");
  return (
    <li className="flex items-start gap-2 border-b py-2 last:border-0" data-level={check.level} data-check={check.id} data-scope={mailHealthScope(check.id)}>
      <LevelIcon level={check.level} />
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t(`mailHealth.check.${check.id}` as Key)}</span>
          <Badge variant={LEVEL_BADGE[check.level]}>{t(`mailHealth.level.${check.level}` as Key)}</Badge>
        </p>
        <p className="text-muted-foreground">{message}</p>
        {showCompare && (
          <dl className="grid gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("mailHealth.expected")}</dt>
            <dd className="break-all font-mono">{check.expected}</dd>
            <dt className="text-muted-foreground">{t("mailHealth.found")}</dt>
            <dd className="break-all font-mono">{check.found && check.found.length > 0 ? check.found.join(" | ") : t("mailHealth.none")}</dd>
          </dl>
        )}
        {plan && <HealthHowTo check={check} plan={plan} />}
      </div>
    </li>
  );
}

function PlanRow({ record }: { record: DnsPlanRecord }) {
  const { t } = useI18n();
  const value = record.value;
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-0" data-record={record.id}>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">{record.order}.</span>
        <span className="font-mono text-xs font-semibold">{record.type}</span>
        <Badge variant={record.need === "required" ? "default" : "secondary"}>{t(`mailHealth.plan.need.${record.need}` as Key)}</Badge>
      </p>
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-xs text-muted-foreground">{t("mailHealth.plan.col.name")}</span>
        <code className="min-w-0 break-all font-mono text-xs">{record.name}</code>
        <CopyButton text={record.name} ariaLabel={t("mailHealth.plan.copyName", { id: record.id })} />
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-xs text-muted-foreground">{t("mailHealth.plan.col.value")}</span>
        <code className="min-w-0 break-all font-mono text-xs">{value}</code>
        <CopyButton text={value} ariaLabel={t("mailHealth.plan.copyValue", { id: record.id })} />
      </span>
      {record.priority !== undefined && (
        <span className="text-xs text-muted-foreground">
          {t("mailHealth.plan.priority")}: <code className="font-mono">{record.priority}</code>
        </span>
      )}
      <p className="text-xs text-muted-foreground">{t(`mailHealth.plan.${record.purpose}.purpose` as Key)}</p>
    </li>
  );
}

export function DeliveryHealthCard({ domain }: { domain: string }) {
  const { t, locale } = useI18n();
  const { state, error, checking, cooldown, check } = useDeliveryHealth(domain);

  const report: DeliveryHealthResponse | null = state?.report ?? null;
  const plan = state?.plan ?? null;
  const issues = (level: MailHealthLevel) =>
    report ? report.checks.filter((c) => c.inbox && c.level === level).map((c) => t(`mailHealth.check.${c.id}` as Key)).join(", ") : "";
  const criticalItems = issues("critical");
  const warnItems = issues("warn");
  const byScope = (scope: MailHealthScope) => (report ? report.checks.filter((c) => mailHealthScope(c.id) === scope) : []);

  return (
    <Card data-testid="delivery-health" data-level={report?.level ?? "unknown"}>
      <CardHeader className="px-4 pb-2 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4" /> {t("mailHealth.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            {report && <Badge variant={LEVEL_BADGE[report.level]}>{t(`mailHealth.level.${report.level}` as Key)}</Badge>}
            <Button size="sm" disabled={checking || cooldown > 0} onClick={() => void check()}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {checking ? t("mailHealth.verifying") : cooldown > 0 ? t("mailHealth.cooldown", { seconds: cooldown }) : t("mailHealth.verify")}
            </Button>
          </div>
        </div>
        <CardDescription>
          {t("mailHealth.description")}{" "}
          <a className="underline" href={emailDeliverabilityGuideUrl(locale)} target="_blank" rel="noreferrer">
            {t("mailHealth.plan.help")}
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!state && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("mail.common.loading")}
          </p>
        )}
        {state && !report && <p className="text-sm text-muted-foreground">{t("mailHealth.neverChecked")}</p>}

        {report && criticalItems && (
          <div role="alert" className="flex flex-col gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm" data-severity="critical">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" /> {t("mailHealth.inbox.title")}
            </p>
            <p>{t("mailHealth.inbox.body", { items: criticalItems })}</p>
          </div>
        )}
        {report && warnItems && (
          <div role="status" className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" data-severity="warn">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" /> {t("mailHealth.attention.title")}
            </p>
            <p>{t("mailHealth.attention.body", { items: warnItems })}</p>
          </div>
        )}
        {report && !criticalItems && !warnItems && (
          <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm">{t("mailHealth.inbox.none")}</p>
        )}

        {report && (
          <>
            <p className="text-xs text-muted-foreground">
              {t("mailHealth.counts", report.counts)} · {t("mailHealth.checkedAt", { date: formatDateTime(report.checkedAt) })}
            </p>
            {(["server", "domain"] as const).map((scope) => (
              <section key={scope} data-scope-section={scope} aria-labelledby={`health-${scope}-${domain}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={`health-${scope}-${domain}`} className="text-sm font-semibold">
                    {scope === "server" ? t("mailHealth.scope.server.title") : t("mailHealth.scope.domain.title", { domain: report.domain })}
                  </h3>
                  <Badge variant={LEVEL_BADGE[report.scopes[scope].level]}>{t(`mailHealth.level.${report.scopes[scope].level}` as Key)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{t(scope === "server" ? "mailHealth.scope.server.hint" : "mailHealth.scope.domain.hint")}</p>
                <ul>
                  {byScope(scope).map((c) => (
                    <CheckRow key={c.id} check={c} plan={plan} />
                  ))}
                </ul>
              </section>
            ))}
            {report.level !== "ok" && (
              <div className="rounded-lg border px-4 py-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t("mailHealth.wait.title")}</p>
                <p>{t("mailHealth.wait.body")}</p>
              </div>
            )}
          </>
        )}

        {plan && (
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">{t("mailHealth.plan.title")}</summary>
            <div className="flex flex-col gap-3 pt-2">
              <p className="text-xs text-muted-foreground">{t("mailHealth.plan.intro")}</p>
              <ol>
                {plan.records.map((r) => (
                  <PlanRow key={r.id} record={r} />
                ))}
              </ol>
              <div className="rounded-lg border px-3 py-2 text-xs">
                <p className="font-medium">{t("mailHealth.plan.cloudflare.title")}</p>
                <p className="text-muted-foreground">{t("mailHealth.plan.cloudflare.body")}</p>
              </div>
              <div className="rounded-lg border px-3 py-2 text-xs">
                <p className="font-medium">{t("mailHealth.plan.ptr.title")}</p>
                <p className="text-muted-foreground">{t("mailHealth.plan.ptr.body", { ip: plan.ptr.ip, expected: plan.ptr.expected })}</p>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs">
                <p className="font-medium">{t("mailHealth.plan.sts.title")}</p>
                <p className="text-muted-foreground">{t("mailHealth.plan.sts.body")}</p>
                <pre className="whitespace-pre-wrap rounded border bg-black/40 p-2 font-mono">{plan.mtaStsPolicy}</pre>
                <div>
                  <CopyButton text={plan.mtaStsPolicy} label={t("mailHealth.plan.sts.copy")} />
                </div>
              </div>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
