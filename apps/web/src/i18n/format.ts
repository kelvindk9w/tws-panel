import { getLocale, intlLocale } from "./core";

type DateInput = Date | string | number;
const toDate = (v: DateInput) => (v instanceof Date ? v : new Date(v));

/**
 * Formatação pelo idioma da interface. O fuso NÃO muda aqui: sem `timeZone`
 * nas opções vale o do navegador, e quem já passava `timeZone` (UTC, fuso do
 * projeto) continua passando.
 */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleString(intlLocale(getLocale()), options);
}

export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleDateString(intlLocale(getLocale()), options);
}

export function formatTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleTimeString(intlLocale(getLocale()), options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(intlLocale(getLocale()), options);
}

/** Ordenação alfabética pelo idioma (substitui localeCompare("pt-BR")). */
export function compareText(a: string, b: string, options?: Intl.CollatorOptions): number {
  return a.localeCompare(b, intlLocale(getLocale()), options);
}

export function lowerCase(text: string): string {
  return text.toLocaleLowerCase(intlLocale(getLocale()));
}
