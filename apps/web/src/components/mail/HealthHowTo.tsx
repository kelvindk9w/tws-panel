/**
 * "O que fazer" de um item da saúde do e-mail: botão que abre e fecha uma área
 * com passos curtos e valores copiáveis. Acessível: é um <button> de verdade
 * (Enter e Espaço), com aria-expanded e aria-controls apontando para a área.
 *
 * Itens opcionais dizem "opcional, melhora a reputação" e o ganho; o próximo
 * passo do DMARC diz também o risco. Nunca promete caixa de entrada.
 */
import { useId, useState } from "react";
import type { DnsPlanResponse, MailHealthCheck } from "@paas/core";
import { useI18n } from "@/i18n";
import type { Key } from "@/i18n/keys";
import { howtoFor } from "@/lib/mail-health-howto";
import { CopyButton } from "@/components/mail/CopyButton";
import { ChevronRight } from "lucide-react";

export function HealthHowTo({ check, plan }: { check: MailHealthCheck; plan: DnsPlanResponse }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const howto = howtoFor(check, plan);
  if (!howto) return null;
  const checkName = t(`mailHealth.check.${check.id}` as Key);
  const gain = howto.gainKey ? t(howto.gainKey) : null;
  const risk = howto.riskKey ? t(howto.riskKey) : null;
  const tag = howto.optional ? (howto.nextStep ? t("mailHealth.howto.nextStep") : t("mailHealth.howto.optional")) : null;

  return (
    <div className="flex flex-col gap-2" data-howto={howto.variant}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
        {t("mailHealth.howto.button")}
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={t("mailHealth.howto.region", { check: checkName })}
          className="flex flex-col gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs"
        >
          {tag && <p className="font-medium">{tag}</p>}
          <ol className="list-decimal space-y-1 pl-4">
            {howto.steps.map((key) => (
              <li key={key}>{t(key, howto.params)}</li>
            ))}
          </ol>
          {howto.copies.length > 0 && (
            <ul className="flex flex-col gap-1">
              {howto.copies.map((c, i) => {
                const label = t(c.labelKey);
                const text = c.messageKey ? t(c.messageKey, c.params) : (c.value ?? "");
                return (
                  <li key={`${c.labelKey}-${i}`} className="flex min-w-0 items-start gap-1" data-copy={c.labelKey.replace("mailHealth.howto.label.", "")}>
                    <span className="shrink-0 text-muted-foreground">{label}:</span>
                    <code className="min-w-0 whitespace-pre-wrap break-all font-mono">{text}</code>
                    <CopyButton text={text} ariaLabel={t("mailHealth.howto.copyAria", { label })} />
                  </li>
                );
              })}
            </ul>
          )}
          {howto.severityKey && <p className="text-muted-foreground">{t(howto.severityKey)}</p>}
          {gain && <p>{t("mailHealth.howto.gain", { gain })}</p>}
          {risk && <p className="text-amber-300">{t("mailHealth.howto.risk", { risk })}</p>}
        </div>
      )}
    </div>
  );
}
