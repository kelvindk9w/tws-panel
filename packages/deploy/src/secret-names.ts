/**
 * secret-names.ts — critério ÚNICO de "este nome de variável guarda um segredo?" para as regras
 * de credencial fraca (rules.ts e guardrails.ts).
 *
 * O termo sensível precisa ser o ÚLTIMO segmento do nome (separado por `_`, `-` ou `.`), ou o nome
 * inteiro. Assim `DB_PASSWORD` conta, mas `API_KEYS_ENVIRONMENT`, `AUTH_PASSWORD_MIN`, `TOKEN_TTL` e
 * `SECRET_ROTATION_DAYS` (configuração, não segredo) não. Os sufixos `_FILE`, `_HASH`, `_B64` e
 * `_BASE64` apontam para arquivo ou valor do segredo e são ignorados antes de olhar o fim do nome.
 *
 * Só serve para BLOQUEAR. O mascaramento na interface (`isSecretVariableName`, em @paas/core) é mais
 * amplo de propósito: mascarar a mais é inofensivo, bloquear a mais não é.
 */

/** Termos de uma palavra só. */
const SINGLE_TERMS = new Set(["PASSWORD", "PASSWD", "PASS", "PWD", "SECRET", "TOKEN", "APIKEY", "PEPPER", "SALT"]);

/** Termos de duas palavras (os dois últimos segmentos). SECRET_ACCESS_KEY termina em ACCESS_KEY. */
const PAIR_TERMS = new Set(["API_KEY", "PRIVATE_KEY", "SECRET_KEY", "ACCESS_KEY", "MASTER_KEY", "ENCRYPTION_KEY", "APP_KEY"]);

/** Sufixos que apontam para arquivo ou valor do segredo. */
const POINTER_SUFFIXES = new Set(["FILE", "HASH", "B64", "BASE64"]);

export function isSecretKeyName(name: string): boolean {
  const segments = name
    .trim()
    .toUpperCase()
    .split(/[_\-.]+/)
    .filter((s) => s !== "");
  if (segments.length > 1 && POINTER_SUFFIXES.has(segments[segments.length - 1]!)) segments.pop();
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  // `PWD` sozinho é o diretório atual do shell (`PWD: /app`), não senha; só vale com prefixo (DB_PWD).
  if (last === "PWD" && segments.length === 1) return false;
  if (SINGLE_TERMS.has(last)) return true;
  return segments.length >= 2 && PAIR_TERMS.has(`${segments[segments.length - 2]}_${last}`);
}
