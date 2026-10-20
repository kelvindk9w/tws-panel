/**
 * Aviso de que o domínio já recebe e-mail em outro servidor (registro MX).
 * Usado na página E-mail e no cadastro do domínio pelo e-mail do projeto.
 */
import { useState } from "react";
import type { ExistingMailInfo } from "@paas/core";
import { Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * Motivo real (01/10/2026): o dono do produto ia cadastrar o domínio
 * principal da empresa, que recebe e-mail em outro provedor. Seguir o
 * checklist (MX → esta VPS) desviaria todo esse e-mail. O aviso tem de ser
 * impossível de ignorar e seguir exige marcar a confirmação.
 */
export function ExistingMailWarning({
  domain,
  info,
  busy,
  onUseSuggested,
  onConfirm,
  onCancel,
}: {
  domain: string;
  info: ExistingMailInfo;
  busy: boolean;
  onUseSuggested: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [understood, setUnderstood] = useState(false);
  const current = info.servers[0];
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-red-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {info.status === "elsewhere"
          ? t("mail.existing.titleElsewhere")
          : t("mail.existing.titleUnknown")}
      </p>
      {info.status === "elsewhere" ? (
        <>
          <p>
            <Trans k="mail.existing.elsewhere" params={{ domain, current: current ?? "" }} components={{ b: <strong /> }} />
          </p>
          <p className="text-xs text-muted-foreground">{t("mail.existing.servers", { servers: info.servers.join(", ") })}</p>
        </>
      ) : (
        <p>
          <Trans k="mail.existing.unknown" params={{ domain }} components={{ b: <strong /> }} />
        </p>
      )}
      <p>
        <Trans k="mail.existing.recommended" params={{ suggested: info.suggestedDomain }} components={{ b: <strong /> }} />
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onUseSuggested}>
          {t("mail.existing.useSuggested", { suggested: info.suggestedDomain })}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("mail.common.cancel")}
        </Button>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
        />
        {t("mail.existing.understand", { domain })}
      </label>
      <div>
        <Button variant="destructive" size="sm" disabled={!understood || busy} onClick={onConfirm}>
          {t("mail.existing.proceed", { domain })}
        </Button>
      </div>
    </div>
  );
}

