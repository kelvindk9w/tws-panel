/**
 * mail-test-html.ts — o HTML de um e-mail de teste, preparado para ser mostrado num iframe do painel.
 *
 * O HTML vem do app do projeto (e este de quem o escreveu): é NÃO CONFIÁVEL. A proteção real é do
 * navegador — a resposta leva `Content-Security-Policy` com `sandbox` (sem scripts, sem formulários,
 * sem acesso ao painel) e, por padrão, sem imagem remota. O que se faz aqui só tira o que a CSP não
 * alcança (redirecionamento por <meta>, <base> do e-mail) e embute as imagens do próprio e-mail (cid:).
 */

/** Imagens que podem aparecer embutidas no corpo; qualquer outra parte baixa como arquivo. SVG fica de fora (pode ter script). */
export const SAFE_INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

/** Cabeçalho CSP da página do e-mail. `remoteImages` libera imagens http(s); o resto fica fechado. */
export function mailHtmlCsp(remoteImages: boolean): string {
  return [
    "sandbox",
    "default-src 'none'",
    `img-src data:${remoteImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Teto de cada imagem embutida e do conjunto (viram data: no próprio HTML). */
const INLINE_IMAGE_MAX_BYTES = 1_500_000;
const INLINE_IMAGES_MAX_TOTAL = 6_000_000;
const INLINE_IMAGES_MAX_COUNT = 20;

export interface InlineImage {
  contentId: string;
  dataUri: string;
}

/**
 * As imagens embutidas (cid:) do corpo viram data: URI. O iframe é um sandbox sem origem: um pedido
 * dele ao painel não leva o cookie de sessão (SameSite=Strict), então a imagem não poderia ser
 * buscada pela rota de partes. Só imagens comuns e pequenas; SVG nunca.
 */
export async function embedInlineImages(
  html: string,
  inline: ReadonlyArray<{ partId: string; contentId: string }>,
  getPart: (partId: string) => Promise<{ body: Buffer; contentType: string }>,
): Promise<InlineImage[]> {
  if (!/cid:/i.test(html)) return [];
  const out: InlineImage[] = [];
  let total = 0;
  for (const part of inline.slice(0, INLINE_IMAGES_MAX_COUNT)) {
    try {
      const { body, contentType } = await getPart(part.partId);
      const type = contentType.split(";")[0]!.trim().toLowerCase();
      if (!SAFE_INLINE_IMAGE.test(type) || body.length > INLINE_IMAGE_MAX_BYTES || total + body.length > INLINE_IMAGES_MAX_TOTAL) continue;
      total += body.length;
      out.push({ contentId: part.contentId, dataUri: `data:${type};base64,${body.toString("base64")}` });
    } catch {
      // imagem que não veio: o corpo aparece sem ela
    }
  }
  return out;
}

/**
 * Devolve o documento HTML pronto. Links ficam sem efeito dentro do iframe (sandbox sem popups):
 * a tela lista os endereços à parte.
 */
export function renderMailHtml(html: string, images: ReadonlyArray<InlineImage>): string {
  let body = html
    // qualquer <meta http-equiv> (refresh, set-cookie…): o valor pode vir em entidades HTML (&#114;efresh), então não se compara, remove-se
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  for (const image of images) {
    const cid = image.contentId.replace(/^<|>$/g, "");
    body = body.replace(new RegExp(`cid:${escapeRegExp(cid)}`, "gi"), () => image.dataUri);
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<base target="_blank"><style>body{margin:12px;font-family:system-ui,sans-serif;word-wrap:break-word}</style></head><body>' +
    body +
    "</body></html>"
  );
}
