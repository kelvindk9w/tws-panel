import { ApiRequestError } from "@/lib/api";
import { getLocale, hasKey, SOURCE_LOCALE, translate } from "./core";
import type { Key } from "./keys";

/**
 * Texto de um erro da API para mostrar ao usuário.
 *
 * O servidor ainda responde em português. Então:
 *  - no idioma de origem (pt-BR) vale a mensagem do servidor, que pode trazer
 *    detalhes do caso;
 *  - em outro idioma, se o `code` estável do erro tem texto em
 *    `errors.code.<code>`, usa-se a tradução; sem ela, a mensagem do servidor
 *    (em português) é o fallback;
 *  - erro que não é da API, ou sem mensagem, mostra `fallback`.
 */
export function apiErrorText(err: unknown, fallback: Key, params?: Record<string, string | number>): string {
  if (err instanceof ApiRequestError) {
    const codeKey = `errors.code.${err.code}`;
    if (getLocale() !== SOURCE_LOCALE && hasKey(codeKey)) return translate(codeKey, params);
    if (err.message) return err.message;
  } else if (err instanceof Error && err.message && getLocale() === SOURCE_LOCALE) {
    // erros locais (ex.: validação) já nascem no idioma certo
    return err.message;
  }
  return translate(fallback, params);
}
