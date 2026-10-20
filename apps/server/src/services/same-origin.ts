/**
 * same-origin.ts — o pedido do navegador veio do próprio painel? (achado M1)
 *
 * O `sslip.io` não está na lista de sufixos públicos: outro `*.sslip.io` conta
 * como "mesmo site" do painel e o navegador manda o cookie mesmo com
 * SameSite. Por isso a escrita só passa quando o navegador diz que a origem é
 * o próprio painel (`Sec-Fetch-Site`) ou, sem esse cabeçalho, quando o `Origin`
 * aponta para o host do painel. Cliente que não é navegador (curl, scripts)
 * não manda nenhum dos dois e não é vetor de CSRF: segue só com a autenticação.
 */

/** O Origin do navegador aponta para outro host que não o do painel? */
export function isCrossOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== (host ?? "");
  } catch {
    return true; // Origin malformado ("null", lixo): não é o painel
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface RequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * O pedido (de qualquer método) veio de outro site/origem, segundo o navegador?
 * `Sec-Fetch-Site` é posto pelo navegador e a página não consegue forjá-lo: se
 * diz `same-origin`/`none`, vale (é o que mantém o dev nativo funcionando, onde
 * o proxy do Vite reescreve o Host mas o Origin segue o da página). Sem ele,
 * confere o `Origin` contra o `Host`.
 */
export function isCrossSiteRequest(request: Pick<RequestLike, "headers">, allowedOrigins: readonly string[] = []): boolean {
  const origin = one(request.headers.origin);
  // Origem que o operador liberou de propósito (ALLOWED_ORIGINS, a mesma lista do CORS).
  if (origin !== undefined && allowedOrigins.includes(origin)) return false;
  const site = one(request.headers["sec-fetch-site"]);
  if (site === "same-origin" || site === "none") return false;
  // "same-site" também é recusado: é exatamente o caso de outro *.sslip.io.
  if (site !== undefined) return true;
  return isCrossOrigin(origin, one(request.headers.host));
}

/** Escrita que o navegador diz ter nascido em outro site/origem? */
export function isCrossSiteWrite(request: RequestLike, allowedOrigins: readonly string[] = []): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  return isCrossSiteRequest(request, allowedOrigins);
}
