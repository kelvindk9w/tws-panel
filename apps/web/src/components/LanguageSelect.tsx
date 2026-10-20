import { localeName, supportedLocales, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Seletor de idioma da interface. Lista os idiomas que existem em
 * `src/locales/` (cada um com o próprio nome) e guarda a escolha neste
 * navegador.
 */
export function LanguageSelect({ className, id }: { className?: string; id?: string }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <select
      id={id}
      aria-label={t("common.language.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value)}
      className={cn(
        "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring",
        className,
      )}
    >
      {supportedLocales().map((l) => (
        <option key={l} value={l}>
          {localeName(l)}
        </option>
      ))}
    </select>
  );
}
