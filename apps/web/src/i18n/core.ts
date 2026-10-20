/**
 * Núcleo do i18n da interface (sem dependências): dicionários por idioma e
 * namespace, interpolação `{nome}`, plural por Intl.PluralRules, fallback para
 * pt-BR e a escolha do idioma (detecção do navegador + preferência guardada).
 *
 * Os dicionários ficam em `src/locales/<idioma>/<namespace>.ts` (objeto plano,
 * chave -> texto). A chave pública é `<namespace>.<chave>`. Para adicionar um
 * idioma basta criar a pasta `src/locales/<idioma>/` com os mesmos arquivos:
 * eles são descobertos por `import.meta.glob`, sem mexer em componentes.
 */

export type Dict = Record<string, string>;
export type Params = Record<string, string | number>;
export type Locale = string;

/** Idioma de origem: referência de chaves e último recurso do fallback. */
export const SOURCE_LOCALE = "pt-BR";
/** Idioma usado quando o navegador não é de nenhum idioma suportado. */
export const FALLBACK_LOCALE = "en";
export const STORAGE_KEY = "paas.locale";

const modules = import.meta.glob<{ default: Dict }>("../locales/*/*.ts", { eager: true });

/** idioma -> namespace -> dicionário */
export const catalog: Record<string, Record<string, Dict>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const match = /\.\.\/locales\/([^/]+)\/([^/]+)\.ts$/.exec(path);
  if (!match) continue;
  const [, locale, ns] = match;
  (catalog[locale!] ??= {})[ns!] = mod.default;
}

/** Idiomas disponíveis = pastas em src/locales, com o idioma de origem primeiro. */
export function supportedLocales(): Locale[] {
  const all = Object.keys(catalog);
  return [SOURCE_LOCALE, ...all.filter((l) => l !== SOURCE_LOCALE).sort()].filter((l) => all.includes(l));
}

export function isSupported(locale: string | null | undefined): locale is Locale {
  return !!locale && Object.hasOwn(catalog, locale);
}

/** Nome do idioma em si mesmo (vem do dicionário `common` de cada idioma). */
export function localeName(locale: Locale): string {
  return catalog[locale]?.common?.["language.name"] ?? locale;
}

/**
 * Escolhe o idioma: a preferência guardada (se ainda existir) vence; senão o
 * primeiro idioma do navegador que tenha tradução ("pt*" -> pt-BR); senão en.
 */
export function detectLocale(stored: string | null | undefined, browserLanguages: readonly string[]): Locale {
  if (isSupported(stored)) return stored;
  const supported = supportedLocales();
  for (const raw of browserLanguages) {
    const tag = raw.toLowerCase();
    const exact = supported.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const primary = tag.split("-")[0]!;
    if (primary === "pt") return SOURCE_LOCALE;
    const byPrimary = supported.find((l) => l.toLowerCase().split("-")[0] === primary);
    if (byPrimary) return byPrimary;
  }
  return FALLBACK_LOCALE;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

// --- estado (store mínimo, compatível com useSyncExternalStore) ---

let current: Locale = SOURCE_LOCALE;
const listeners = new Set<() => void>();

function applyLocale(locale: Locale): Locale {
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const l of listeners) l();
  return locale;
}

/** Lê preferência + navegador e aplica (no carregamento do app e nos testes). */
export function initLocale(): Locale {
  return applyLocale(detectLocale(readStored(), browserLanguages()));
}

export function getLocale(): Locale {
  return current;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Troca o idioma; `persist` (padrão) guarda a escolha do usuário no navegador. */
export function setLocale(locale: Locale, options: { persist?: boolean } = {}): void {
  if (!isSupported(locale)) return;
  if (options.persist ?? true) {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // sem armazenamento (janela privada): vale só nesta sessão
    }
  }
  applyLocale(locale);
}

// --- tradução ---

function lookup(locale: Locale, key: string): string | undefined {
  const i = key.indexOf(".");
  if (i < 0) return undefined;
  return catalog[locale]?.[key.slice(0, i)]?.[key.slice(i + 1)];
}

/** Há texto para a chave neste idioma (sem fallback)? Aceita a chave-base de um plural. */
export function hasKey(key: string, locale: Locale = current): boolean {
  return lookup(locale, key) !== undefined || lookup(locale, `${key}_other`) !== undefined;
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function resolve(locale: Locale, key: string, params?: Params): string | undefined {
  const count = params?.count;
  if (typeof count === "number") {
    const text = lookup(locale, `${key}_${pluralCategory(locale, count)}`) ?? lookup(locale, `${key}_other`);
    if (text !== undefined) return text;
  }
  return lookup(locale, key);
}

const warned = new Set<string>();

/** Texto da chave no idioma (com interpolação e plural), caindo para pt-BR. */
export function translate(key: string, params?: Params, locale: Locale = current): string {
  const text = resolve(locale, key, params) ?? resolve(SOURCE_LOCALE, key, params);
  if (text === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] chave ausente: ${key}`);
    }
    return key;
  }
  return interpolate(text, params);
}

/** Idioma BCP 47 passado ao Intl (datas, números, ordenação). */
export function intlLocale(locale: Locale = current): string {
  return locale;
}
