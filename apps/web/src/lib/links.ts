/**
 * Todos os endereços de ajuda e feedback do painel moram AQUI — nenhum outro
 * arquivo escreve URL do site ou do repositório.
 *
 * PRIVACIDADE: o link de "Relatar um problema" só pode carregar a versão do
 * painel e o idioma da interface. Nada de IP, domínio, e-mail, usuário,
 * caminho, log ou nome de projeto — nem o SO da VPS, que a pessoa informa no
 * formulário. `bugReportUrl` lê só esses dois campos (qualquer outra
 * propriedade recebida é ignorada) e descarta o que não tem a forma esperada,
 * em vez de tentar "limpar".
 */

/** Site de documentação (GitHub Pages). */
export const SITE_URL = "https://kelvindk9w.github.io/tws-panel";
/** Repositório no GitHub. */
export const REPO_URL = "https://github.com/kelvindk9w/tws-panel";

/** Pasta do site para o idioma da interface: pt-BR → "pt-br"; qualquer outro → "en". */
export function siteLanguage(locale: string): "pt-br" | "en" {
  return /^pt(-|$)/i.test(locale) ? "pt-br" : "en";
}

/** Guia / documentação, no idioma da interface. */
export function docsUrl(locale: string): string {
  return `${SITE_URL}/${siteLanguage(locale)}/`;
}

/** Página "Ajuda e feedback" do site, no idioma da interface. */
export function helpPageUrl(locale: string): string {
  return `${SITE_URL}/${siteLanguage(locale)}/guides/help/`;
}

/** Perguntas e ideias (GitHub Discussions). */
export function discussionsUrl(): string {
  return `${REPO_URL}/discussions`;
}

/** Formulário de sugestão de funcionalidade (sem nenhum dado preenchido). */
export function featureRequestUrl(): string {
  return `${REPO_URL}/issues/new?template=feature_request.yml`;
}

// Formas aceitas: semver estrito (X.Y.Z, com pré-lançamento e build opcionais, até 40 caracteres)
// código de idioma ("pt-BR", "en"). Fora disso, o campo simplesmente não vai.
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** Versão no formato aceito, ou null (vazia, "unknown", hostil, longa demais). */
export function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length <= 40 && VERSION_RE.test(v) ? v : null;
}

/** Link do formulário de bug com versão e idioma preenchidos (e só isso). */
export function bugReportUrl(info: { version?: unknown; locale?: unknown }): string {
  const params = new URLSearchParams({ template: "bug_report.yml" });
  const version = safeVersion(info.version);
  if (version) params.set("version", version);
  const locale = typeof info.locale === "string" ? info.locale.trim() : "";
  if (LOCALE_RE.test(locale)) params.set("locale", locale);
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
