/**
 * mail-test-html.ts — o HTML de um e-mail de teste, preparado para ser mostrado num iframe do painel.
 *
 * O HTML vem do app do projeto (e este de quem o escreveu): é NÃO CONFIÁVEL. A proteção real é do
 * navegador — a resposta leva `Content-Security-Policy` com `sandbox` (sem scripts, sem formulários,
 * sem acesso ao painel) e, por padrão, sem imagem remota. O que se faz aqui só tira o que a CSP não
 * alcança (redirecionamento por <meta>, <base> do e-mail) e embute as imagens do próprio e-mail (cid:).
 * A limpeza é feita por PARSER com lista de permissões (parse5), nunca por regex sobre o HTML.
 */
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

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

// ---------------------------------------------------------------------------
// Limpeza do HTML por PARSER (parse5), com lista de permissões. Nada de regex sobre o HTML: o parser decodifica
// entidades, entende comentários (inclusive condicionais), maiúsculas, atributos sem aspas e tags mal fechadas
// (`</script\t\n bar>`, `<scr<script>ipt>`), e só o que a lista permite é escrito de volta.
// ---------------------------------------------------------------------------

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

/** Tags de e-mail comuns que passam. O resto é desembrulhado (fica o texto) ou, se perigoso, descartado com o conteúdo. */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div",
  "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "style",
]);
/** Descartadas COM o conteúdo (script, frames, objetos, campos de entrada, SVG/MathML, metadados). */
const DROP_WITH_CONTENT = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template", "svg", "math",
  "textarea", "select", "option", "button", "input", "link", "meta", "base", "head", "title", "audio", "video", "source", "track",
  "canvas", "dialog", "portal", "xmp", "plaintext",
]);
const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

/** Atributos permitidos em qualquer tag permitida (nenhum on*, nada de id/name/form/srcdoc). */
const GLOBAL_ATTRS = new Set(["class", "style", "title", "lang", "dir", "align", "valign", "width", "height", "bgcolor", "color", "border", "nowrap"]);
const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt"]),
  font: new Set(["face", "size"]),
  table: new Set(["cellpadding", "cellspacing", "summary"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type"]),
  li: new Set(["value"]),
};

/** Controles, espaços e invisíveis antes do esquema não enganam o navegador (`java\tscript:`): saem antes de comparar. */
function stripUrlNoise(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    const noise = c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff;
    if (!noise) out += ch;
  }
  return out;
}
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=]*$/i;
const CSS_DANGER = /expression\s*\(|javascript:|vbscript:|behaviou?r\s*:|-moz-binding|@import|@charset/i;

/** `href`: só http(s), mailto, tel e âncora (`#`). O valor já vem decodificado pelo parser. */
function safeHref(value: string): string | null {
  return /^(?:https?:|mailto:|tel:|#)/i.test(stripUrlNoise(value)) ? value.trim() : null;
}

/** `src` de imagem: http(s) ou data:image/<tipo comum>;base64 (nunca SVG, javascript: ou outro esquema). */
function safeSrc(value: string): string | null {
  const v = stripUrlNoise(value);
  return /^https?:/i.test(v) || SAFE_DATA_IMAGE.test(v) ? value.trim() : null;
}

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** CSS do e-mail: null se tem algo perigoso; `<` nunca sai (não fecha o <style> por engano). */
function safeCss(css: string): string | null {
  return CSS_DANGER.test(css) ? null : css.replace(/</g, "\\3c ");
}

/** `cid:xxx` vira o data: URI da imagem embutida correspondente (sem regex: o id pode ter qualquer caractere). */
function replaceCid(text: string, cid: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [id, uri] of cid) {
    const needle = `cid:${id}`;
    let from = 0;
    for (;;) {
      const at = out.toLowerCase().indexOf(needle, from);
      if (at < 0) break;
      out = out.slice(0, at) + uri + out.slice(at + needle.length);
      from = at + uri.length;
    }
  }
  return out;
}

function serialize(nodes: ReadonlyArray<Node>, cid: ReadonlyMap<string, string>): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      out += escapeText((node as TextNode).value);
      continue;
    }
    // comentários (inclusive condicionais `<!--[if mso]>`), doctype e tudo o que não é elemento: descartados
    if (!("tagName" in node)) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    const children = el.childNodes;
    if (!ALLOWED_TAGS.has(tag)) {
      out += serialize(children, cid); // desembrulha: o texto fica, a tag não
      continue;
    }
    if (tag === "style") {
      const css = safeCss(children.map((c) => (c as TextNode).value ?? "").join(""));
      if (css !== null) out += `<style>${replaceCid(css, cid)}</style>`;
      continue;
    }
    let attrs = "";
    for (const { name: rawName, value } of el.attrs) {
      const name = rawName.toLowerCase();
      if (name.startsWith("on") || !(GLOBAL_ATTRS.has(name) || TAG_ATTRS[tag]?.has(name))) continue;
      let v: string | null = value;
      if (name === "href") v = safeHref(value);
      else if (name === "src") v = safeSrc(replaceCid(value, cid));
      else if (name === "style") v = safeCss(value) === null ? null : replaceCid(value, cid);
      if (v !== null) attrs += ` ${name}="${escapeAttr(v)}"`;
    }
    out += VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${serialize(children, cid)}</${tag}>`;
  }
  return out;
}

/**
 * Devolve o documento HTML pronto. O corpo passa por um parser e por uma lista de permissões (sem script, frames,
 * formulários, meta/base/link, atributos on*, nem javascript:/data: perigoso em href/src); depois ainda vai para um
 * iframe com sandbox e CSP. Links ficam sem efeito dentro do iframe (sandbox sem popups): a tela lista os endereços à parte.
 */
export function renderMailHtml(html: string, images: ReadonlyArray<InlineImage>): string {
  const cid = new Map(images.map((image) => [image.contentId.replace(/^<|>$/g, "").toLowerCase(), image.dataUri] as const));
  const body = serialize(parseFragment(html).childNodes, cid);
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<base target="_blank"><style>body{margin:12px;font-family:system-ui,sans-serif;word-wrap:break-word}</style></head><body>' +
    body +
    "</body></html>"
  );
}
