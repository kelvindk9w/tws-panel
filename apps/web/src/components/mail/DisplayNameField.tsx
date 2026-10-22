/**
 * Campo "Nome de exibição (opcional)" das caixas de e-mail, igual em todo lugar
 * que cria ou altera uma caixa (criar na página do domínio, criar na aba do
 * projeto, ativar o e-mail do projeto, "Alterar nome de exibição"). A regra é a
 * do servidor (normalizeDisplayName, @paas/core): sem quebra de linha nem
 * caracteres de controle, sem < > aspas e barra invertida, até 80 caracteres.
 */
import { useId } from "react";
import { MAILBOX_DISPLAY_NAME_MAX, normalizeDisplayName } from "@paas/core";
import { useI18n } from "@/i18n";
import { Input } from "@/components/ui/input";

/** Chave de texto do problema do nome, ou null se está bom (vazio é válido: "sem nome"). */
export function displayNameProblem(value: string): "mail.displayName.errorChars" | "mail.displayName.errorLength" | null {
  const checked = normalizeDisplayName(value);
  if (checked.ok) return null;
  return checked.code === "too_long" ? "mail.displayName.errorLength" : "mail.displayName.errorChars";
}

export function DisplayNameField({
  value,
  onChange,
  placeholder,
  hintKey = "mail.displayName.hint",
  label,
  disabled,
  onEnter,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Exemplo mostrado quando vazio (padrão: um nome de exemplo). */
  placeholder?: string;
  hintKey?: "mail.displayName.hint" | "mail.displayName.hintProject";
  label?: string;
  disabled?: boolean;
  onEnter?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const problem = displayNameProblem(value);
  const text = label ?? t("mail.displayName.label");
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id}>{text}</label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder ?? t("mail.displayName.placeholder")}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
      <p id={`${id}-hint`} className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {problem ? t(problem, { max: MAILBOX_DISPLAY_NAME_MAX }) : t(hintKey, { max: MAILBOX_DISPLAY_NAME_MAX })}
      </p>
    </div>
  );
}
