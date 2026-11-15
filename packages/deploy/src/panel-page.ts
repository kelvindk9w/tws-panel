/**
 * panel-page.ts — o cabeçalho que marca as páginas de erro de projeto servidas pelo próprio Caddy
 * ("Atualizando", "temporariamente indisponível", "em manutenção").
 *
 * Quem lê é o health check do deploy: sem a marca, a página do painel (503) se confunde com uma resposta do
 * app, e o log diria "a aplicação respondeu HTTP 503" quando, na verdade, o app respondeu 502 ou nem
 * respondeu. Fica fora de caddy.ts (que depende do Docker) para ser testado sem ele.
 *
 * Valor: `pagina=<atualizando|indisponivel|manutencao>; app=<status do app>; proxy=<status do erro no Caddy>`.
 *  - `app`: o status que o app respondeu, quando a resposta dele foi trocada pela página (só durante o deploy,
 *    pelo handle_response); vazio quando o app não respondeu.
 *  - `proxy`: o status do erro no Caddy — 502 (sem conexão com o app), 504 (o app não respondeu a tempo) ou
 *    503 (a resposta do app foi trocada pela página).
 * Nunca leva a mensagem do erro: ela traria nomes e endereços internos para quem visita.
 */

/** Nome do cabeçalho (o Node entrega em minúsculas). */
export const PANEL_PAGE_HEADER = "X-Tws-Painel";

export type PanelPageKind = "atualizando" | "indisponivel" | "manutencao";

export interface PanelPageInfo {
  kind: PanelPageKind;
  /** Status que o app respondeu (trocado pela página), ou null se ele não respondeu. */
  appStatus: number | null;
  /** Status do erro no Caddy (502, 503, 504), ou null se não veio. */
  proxyStatus: number | null;
}

const KINDS: readonly PanelPageKind[] = ["atualizando", "indisponivel", "manutencao"];

function statusOf(value: string | undefined): number | null {
  if (value === undefined || !/^[1-5][0-9]{2}$/.test(value)) return null;
  return Number(value);
}

/** Lê o cabeçalho; null quando ele não veio ou não é do painel (o app pode mandar qualquer coisa). */
export function parsePanelPage(header: string | string[] | undefined): PanelPageInfo | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw.length > 200) return null;
  const fields = new Map<string, string>();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const kind = fields.get("pagina") as PanelPageKind | undefined;
  if (!kind || !KINDS.includes(kind)) return null;
  return { kind, appStatus: statusOf(fields.get("app")), proxyStatus: statusOf(fields.get("proxy")) };
}

const PAGE_NAMES: Record<PanelPageKind, string> = {
  atualizando: '"Atualizando"',
  indisponivel: '"temporariamente indisponível"',
  manutencao: '"em manutenção"',
};

/** O que aconteceu com o app, em português, para o log do deploy ("o app respondeu HTTP 502"). */
export function describeAppOutcome(page: PanelPageInfo): string {
  if (page.appStatus !== null) return `o app respondeu HTTP ${page.appStatus}`;
  if (page.proxyStatus === 504) return "o app aceitou a conexão mas não respondeu a tempo";
  if (page.proxyStatus === 502) return "o proxy não conseguiu conexão com o app";
  return "o app não respondeu";
}

/** Linha completa: quem respondeu (a página do painel) e o que o app fez. */
export function describePanelPage(status: number | undefined, page: PanelPageInfo): string {
  return `HTTP ${status ?? "?"} da página ${PAGE_NAMES[page.kind]} do painel: ${describeAppOutcome(page)}`;
}
