/**
 * "Marcar como ciente" de um item da saúde do e-mail que depende do provedor da VPS
 * (DNS reverso, porta 25): botão que abre um campo curto para o motivo (opcional) e,
 * quando o item já está marcado, a data, o motivo e o botão "Desmarcar".
 *
 * O estado nunca depende só de cor: a marcação aparece como texto ("Ciente") e a
 * nota explica o que muda. Quem decide se a marcação ainda vale é o servidor.
 */
import { useId, useState } from "react";
import { isMailHealthAcknowledgeable, MAIL_HEALTH_ACK_REASON_MAX, type MailHealthCheck } from "@paas/core";
import { formatDateTime, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AckHandlers {
  onAcknowledge(id: string, reason: string): Promise<boolean>;
  onUnacknowledge(id: string): Promise<boolean>;
}

export function AckControls({ check, handlers }: { check: MailHealthCheck; handlers: AckHandlers }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  if (!isMailHealthAcknowledgeable(check.id)) return null;

  if (check.acknowledged) {
    return (
      <div className="flex flex-col gap-1 text-xs" data-testid={`ack-note-${check.id}`}>
        <p className="text-muted-foreground">{t("mailHealth.ack.note", { date: formatDateTime(check.acknowledged.at) })}</p>
        {check.acknowledged.reason && <p className="[overflow-wrap:anywhere]">{t("mailHealth.ack.reason", { reason: check.acknowledged.reason })}</p>}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await handlers.onUnacknowledge(check.id);
              setBusy(false);
            }}
          >
            {t("mailHealth.ack.undo")}
          </Button>
        </div>
      </div>
    );
  }

  if (check.level !== "warn" && check.level !== "critical") return null;

  if (!open) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid={`ack-open-${check.id}`}>
            {t("mailHealth.ack.button")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs"
      data-testid={`ack-form-${check.id}`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const ok = await handlers.onAcknowledge(check.id, reason);
        setBusy(false);
        if (ok) {
          setOpen(false);
          setReason("");
        }
      }}
    >
      <p className="text-muted-foreground">{t("mailHealth.ack.hint")}</p>
      <label htmlFor={fieldId} className="font-medium">
        {t("mailHealth.ack.reasonLabel")}
      </label>
      <Input
        id={fieldId}
        value={reason}
        maxLength={MAIL_HEALTH_ACK_REASON_MAX}
        placeholder={t("mailHealth.ack.reasonPlaceholder")}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t("mailHealth.ack.saving") : t("mailHealth.ack.confirm")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {t("mailHealth.ack.cancel")}
        </Button>
      </div>
    </form>
  );
}
