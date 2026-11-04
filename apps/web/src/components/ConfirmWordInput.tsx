import { useId } from "react";
import { Trans, useI18n, type Key } from "@/i18n";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/mail/CopyButton";

interface Props {
  id: string;
  /** O que a pessoa precisa digitar (palavra fixa, nome do projeto ou domínio). */
  word: string;
  value: string;
  onChange: (value: string) => void;
  /** Rótulo com `<code>{word}</code>` (ou outro parâmetro de `params`). */
  labelKey: Key;
  /** Dica de que é a palavra literal (opcional). Recebe os mesmos `params`. */
  hintKey?: Key;
  /** Parâmetros do rótulo e da dica; por padrão `{ word }`. */
  params?: Record<string, string>;
}

/**
 * Campo "digite X para confirmar", igual em todo o app: X aparece em fonte de
 * código, uma dica diz que é a palavra literal, o próprio X é o placeholder e
 * há um botão para copiá-lo. Só apresentação: quem usa decide o que vale como
 * confirmação.
 */
export function ConfirmWordInput({ id, word, value, onChange, labelKey, hintKey, params }: Props) {
  const { t } = useI18n();
  const hintId = useId();
  const p = params ?? { word };
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium">
        <Trans k={labelKey} params={p} components={{ code: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground" /> }} />
      </label>
      {hintKey && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {t(hintKey, p)}
        </p>
      )}
      <div className="flex items-center gap-1">
        <Input
          id={id}
          className="min-w-0 flex-1"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={word}
          aria-describedby={hintKey ? hintId : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <CopyButton text={word} ariaLabel={t("common.confirmWord.copy", { word })} />
      </div>
    </div>
  );
}
