import { Languages } from "lucide-react";
import { localeName, localeShort, supportedLocales, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Seletor de idioma da interface. Lista os idiomas que existem em
 * `src/locales/` (cada um com o próprio nome) e guarda a escolha neste
 * navegador.
 *
 * `compact` é a variante do cabeçalho do painel: ícone de idiomas e só o
 * código (PT, EN) no controle fechado, para caber ao lado do menu do usuário;
 * cada opção continua com o nome completo para leitores de tela.
 */
export function LanguageSelect({ className, id, compact = false }: { className?: string; id?: string; compact?: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const select = (
    <select
      id={id}
      aria-label={t("common.language.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value)}
      className={cn(
        "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring",
        compact ? "w-full cursor-pointer pl-7 pr-1 font-medium" : className,
      )}
    >
      {supportedLocales().map((l) => (
        <option key={l} value={l} aria-label={compact ? localeName(l) : undefined} title={compact ? localeName(l) : undefined}>
          {compact ? localeShort(l) : localeName(l)}
        </option>
      ))}
    </select>
  );
  if (!compact) return select;
  return (
    <div className={cn("relative inline-flex shrink-0 items-center", className)}>
      <Languages aria-hidden className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
      {select}
    </div>
  );
}
