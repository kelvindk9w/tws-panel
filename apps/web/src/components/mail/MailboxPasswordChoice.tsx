/**
 * Senha da caixa do projeto: a pessoa digita (duas vezes) ou pede ao painel
 * uma senha forte, que aparece UMA vez (GeneratedPasswordNotice). Usado ao
 * ativar o e-mail do projeto e em "Trocar senha".
 */
import { useId, useState } from "react";
import { MAILBOX_PASSWORD_MIN } from "@paas/core";
import { copyText } from "@/lib/clipboard";
import { t, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";

export interface PasswordChoiceState {
  mode: "type" | "generate";
  password: string;
  confirm: string;
}

export const EMPTY_PASSWORD_CHOICE: PasswordChoiceState = { mode: "type", password: "", confirm: "" };

/** O que falta para a escolha valer (null = pronta). */
export function passwordChoiceProblem(s: PasswordChoiceState): string | null {
  if (s.mode === "generate") return null;
  if (s.password.trim().length < MAILBOX_PASSWORD_MIN) {
    return t("mail.password.tooShort", { min: MAILBOX_PASSWORD_MIN });
  }
  if (s.password !== s.confirm) return t("mail.password.mismatch");
  return null;
}

export function PasswordChoice({
  value,
  onChange,
  passwordLabel,
}: {
  value: PasswordChoiceState;
  onChange: (next: PasswordChoiceState) => void;
  passwordLabel?: string;
}) {
  const { t } = useI18n();
  const label = passwordLabel ?? t("mail.password.label");
  const group = useId();
  const problem = passwordChoiceProblem(value);
  // só reclama depois que a pessoa começou a digitar (a repetição, depois de começar a repetir)
  const short = value.password.trim().length < MAILBOX_PASSWORD_MIN;
  const showProblem = problem !== null && value.password !== "" && (short || value.confirm !== "");
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 flex items-center gap-2 text-sm">
        <KeyRound className="h-4 w-4" /> {t("mail.password.label")}
      </legend>
      <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:gap-4">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={group}
            checked={value.mode === "type"}
            onChange={() => onChange({ ...value, mode: "type" })}
          />
          {t("mail.password.modeType")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={group}
            checked={value.mode === "generate"}
            onChange={() => onChange({ ...value, mode: "generate" })}
          />
          {t("mail.password.modeGenerate")}
        </label>
      </div>
      {value.mode === "type" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <PasswordInput
            aria-label={label}
            placeholder={t("mail.password.placeholder", { label, min: MAILBOX_PASSWORD_MIN })}
            autoComplete="new-password"
            value={value.password}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
          />
          <PasswordInput
            aria-label={t("mail.password.repeat")}
            placeholder={t("mail.password.repeat")}
            autoComplete="new-password"
            value={value.confirm}
            onChange={(e) => onChange({ ...value, confirm: e.target.value })}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("mail.password.generateHint")}
        </p>
      )}
      {showProblem && <p className="text-xs text-red-300">{problem}</p>}
    </fieldset>
  );
}

/** A senha gerada pelo painel, mostrada uma única vez. */
export function GeneratedPasswordNotice({ password, onDone }: { password: string; onDone: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div
      data-testid="generated-password"
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">{t("mail.generated.title")}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border bg-black/40 px-2 py-1 font-mono text-emerald-200">
          {password}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("mail.generated.copyAria")}
          onClick={async () => setCopied(await copyText(password))}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          {copied ? t("mail.generated.copied") : t("mail.generated.copy")}
        </Button>
      </div>
      <p className="flex items-start gap-2 text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("mail.generated.warning")}</span>
      </p>
      <div>
        <Button variant="success" size="sm" onClick={onDone}>
          {t("mail.generated.done")}
        </Button>
      </div>
    </div>
  );
}
