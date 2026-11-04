/**
 * mail-test-html.ts — o HTML não confiável de um e-mail de teste, preparado para o iframe.
 */
import { describe, expect, it, vi } from "vitest";
import { SAFE_INLINE_IMAGE, embedInlineImages, mailHtmlCsp, renderMailHtml } from "../src/services/mail-test-html.js";

describe("mailHtmlCsp", () => {
  it("por padrão: sandbox total, nada carrega de fora, sem scripts nem formulários", () => {
    const csp = mailHtmlCsp(false);
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("img-src data:;");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("form-action 'none'");
  });

  it("imagens remotas só quando a pessoa pede, e só imagens", () => {
    const csp = mailHtmlCsp(true);
    expect(csp).toContain("img-src data: https: http:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("allow-scripts");
  });
});

describe("renderMailHtml", () => {
  it("tira o redirecionamento por <meta>, o <base> do e-mail e os scripts", () => {
    const out = renderMailHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example.net"><base href="https://evil.example.net/"><script>alert(1)</script><p>oi</p>',
      [],
    );
    expect(out).not.toMatch(/refresh/i);
    expect(out).not.toContain("evil.example.net");
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>oi</p>");
  });

  it("B1: nenhum <meta http-equiv> sobrevive, nem com o valor escrito em entidades HTML", () => {
    const out = renderMailHtml(
      '<meta http-equiv="&#114;efresh" content="0;url=https://evil.example.net"><META CONTENT="0;url=https://evil.example.net" HTTP-EQUIV=&#x72;efresh><meta http-equiv=set-cookie content="a=b"><p>oi</p>',
      [],
    );
    expect(out).not.toContain("evil.example.net");
    expect(out).not.toMatch(/http-equiv/i);
    expect(out).toContain("<p>oi</p>");
  });

  it("os links abrem fora do iframe (sem efeito dentro do sandbox)", () => {
    const out = renderMailHtml("<a href='https://app.example.com/x'>x</a>", []);
    expect(out).toContain('<base target="_blank">');
    expect(out).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("troca cid: pela imagem embutida, com ou sem <>, sem interpretar $ do endereço", () => {
    const out = renderMailHtml('<img src="cid:logo.png@x"><img src="CID:outro">', [
      { contentId: "<logo.png@x>", dataUri: "data:image/png;base64,AAA+/=" },
      { contentId: "outro", dataUri: "data:image/gif;base64,BBBB" },
    ]);
    expect(out).toContain('src="data:image/png;base64,AAA+/="');
    expect(out).toContain('src="data:image/gif;base64,BBBB"');
    expect(out).not.toMatch(/cid:/i);
  });

  it("cid com caracteres especiais de expressão regular não quebra", () => {
    expect(renderMailHtml('<img src="cid:a(b)+c">', [{ contentId: "a(b)+c", dataUri: "data:image/png;base64,WA==" }])).toContain('src="data:image/png;base64,WA=="');
  });
});

describe("renderMailHtml: limpeza por parser (vetores de XSS)", () => {
  const body = (out: string): string => out.slice(out.indexOf("<body>") + 6, out.lastIndexOf("</body>"));
  /** Nada que execute ou navegue pode sobrar no corpo limpo. */
  const harmless = (out: string): void => {
    const b = body(out);
    expect(b).not.toMatch(/<\s*script/i);
    expect(b).not.toMatch(/\son[a-z]+\s*=/i);
    expect(b).not.toMatch(/javascript:/i);
    expect(b).not.toMatch(/<\s*(iframe|object|embed|form|meta|base|link|svg|math)\b/i);
  };

  it.each([
    ["tag recomposta pela remoção ingênua", "<scr<script>ipt>alert(1)</scr</script>ipt><p>x</p>"],
    ["fechamento com espaços e tabs", "<script>alert(1)</script\t\n bar><p>x</p>"],
    ["maiúsculas e minúsculas misturadas", "<ScRiPt SRC=//evil.example.net/x.js></sCrIpT><p>x</p>"],
    ["svg com onload", "<svg onload=alert(1)><circle/></svg><p>x</p>"],
    ["img com javascript:", "<img src=javascript:alert(1)><p>x</p>"],
    ["img com onerror", '<img src="x" onerror="alert(1)"><p>x</p>'],
    ["javascript: com entidades e tab", '<a href="&#106;ava&#x09;script&colon;alert(1)">x</a><p>x</p>'],
    ["javascript: com espaço antes e controle dentro", '<a href=" \u0001java\nscript:alert(1)">x</a><p>x</p>'],
    ["comentário condicional", "<!--[if gte mso 9]><script>alert(1)</script><![endif]--><p>x</p>"],
    ["comentário condicional revelado", "<![if !IE]><script>alert(1)</script><![endif]><p>x</p>"],
    ["iframe, object, embed", '<iframe src="https://evil.example.net"></iframe><object data="x"></object><embed src="x"><p>x</p>'],
    ["form com botão", '<form action="https://evil.example.net"><input name=a><button>ok</button></form><p>x</p>'],
    ["link e base", '<link rel=stylesheet href="https://evil.example.net/a.css"><base href="https://evil.example.net/"><p>x</p>'],
    ["math/svg com script dentro", "<math><mi xlink:href=javascript:alert(1)>x</mi></math><svg><script>alert(1)</script></svg><p>x</p>"],
    ["atributo on* com maiúsculas", '<p ONCLICK="alert(1)" OnMouseOver=alert(1)>x</p>'],
    ["data:text/html em href", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a><p>x</p>'],
    ["srcdoc e formaction", '<p srcdoc="<script>alert(1)</script>" formaction="javascript:alert(1)">x</p>'],
    ["noscript e template", "<noscript><p title=\"</noscript><script>alert(1)</script>\"></noscript><template><script>alert(1)</script></template><p>x</p>"],
  ])("%s", (_name, html) => {
    const out = renderMailHtml(html, []);
    harmless(out);
    // (na tag recomposta o que sobra é TEXTO escapado e inerte, não código)
    if (!_name.includes("recomposta")) expect(body(out)).not.toContain("alert(1)");
    else expect(body(out)).toContain("&gt;");
  });

  it("img com data:image/svg ou javascript: perde o src; http(s) e data:image comum ficam", () => {
    const out = body(
      renderMailHtml(
        '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="javascript:alert(1)"><img src="https://img.example.com/a.png"><img src="data:image/png;base64,iVBOR=">',
        [],
      ),
    );
    expect(out).not.toContain("svg");
    expect(out).not.toContain("javascript");
    expect(out).toContain('src="https://img.example.com/a.png"');
    expect(out).toContain('src="data:image/png;base64,iVBOR="');
  });

  it("links http(s), mailto, tel e âncora ficam; o resto perde o href", () => {
    const out = body(renderMailHtml('<a href="https://a.example.com/x?a=1&b=2">1</a><a href="mailto:a@example.com">2</a><a href="tel:+5511">3</a><a href="#top">4</a><a href="ftp://x">5</a><a href="vbscript:x">6</a>', []));
    expect(out).toContain('href="https://a.example.com/x?a=1&amp;b=2"');
    expect(out).toContain('href="mailto:a@example.com"');
    expect(out).toContain('href="tel:+5511"');
    expect(out).toContain('href="#top"');
    expect(out).not.toContain("ftp:");
    expect(out).not.toContain("vbscript");
  });

  it("o conteúdo do e-mail continua legível: tabelas, estilos simples e texto com entidades", () => {
    const out = body(renderMailHtml('<table width="600" bgcolor="#fff"><tr><td style="color:red;padding:4px"><b>Olá &amp; bem-vindo</b> &lt;tag&gt;</td></tr></table><style>.a{color:blue}</style>', []));
    expect(out).toContain('<table width="600" bgcolor="#fff">');
    expect(out).toContain('style="color:red;padding:4px"');
    expect(out).toContain("<b>Olá &amp; bem-vindo</b> &lt;tag&gt;");
    expect(out).toContain("<style>.a{color:blue}</style>");
  });

  it("CSS perigoso (@import, expression, javascript:) é descartado, no atributo e no <style>", () => {
    const out = body(renderMailHtml('<p style="background:url(javascript:alert(1))">a</p><p style="width:expression(alert(1))">b</p><style>@import url(https://evil.example.net/a.css);</style><style>p{color:red}</style><style>a{x:y}</style" ><p>c</p>', []));
    expect(out).not.toMatch(/javascript|expression|@import|evil\.example/i);
    expect(out).toContain("<style>p{color:red}</style>");
  });

  it("cid: dentro de style e de src vira a imagem; texto do e-mail não vira HTML", () => {
    const out = body(renderMailHtml('<td style="background:url(cid:bg)">&lt;script&gt;alert(1)&lt;/script&gt;</td><img src="cid:bg">', [{ contentId: "bg", dataUri: "data:image/png;base64,AAAA" }]));
    expect(out).toContain("background:url(data:image/png;base64,AAAA)");
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("embedInlineImages", () => {
  const png = (n: number) => ({ body: Buffer.alloc(n, 1), contentType: "image/PNG; name=x" });

  it("sem cid: no HTML, nem busca as partes", async () => {
    const get = vi.fn();
    expect(await embedInlineImages("<p>oi</p>", [{ partId: "1", contentId: "a" }], get)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("embute só imagens comuns e pequenas; SVG, grande demais e falha ficam de fora", async () => {
    const parts: Record<string, { body: Buffer; contentType: string } | Error> = {
      "1": png(3),
      "2": { body: Buffer.from("<svg onload=alert(1)>"), contentType: "image/svg+xml" },
      "3": png(1_600_000),
      "4": new Error("sumiu"),
      "5": { body: Buffer.from("x"), contentType: "text/html" },
    };
    const get = async (id: string) => {
      const p = parts[id]!;
      if (p instanceof Error) throw p;
      return p;
    };
    const out = await embedInlineImages(
      '<img src="cid:a">',
      ["1", "2", "3", "4", "5"].map((id) => ({ partId: id, contentId: `c${id}` })),
      get,
    );
    expect(out).toEqual([{ contentId: "c1", dataUri: `data:image/png;base64,${Buffer.alloc(3, 1).toString("base64")}` }]);
  });

  it("no máximo 20 imagens e 6 MB no total", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ partId: String(i), contentId: `c${i}` }));
    expect(await embedInlineImages("cid:x", many, async () => png(10))).toHaveLength(20);
    const big = Array.from({ length: 6 }, (_, i) => ({ partId: String(i), contentId: `c${i}` }));
    expect(await embedInlineImages("cid:x", big, async () => png(1_400_000))).toHaveLength(4);
  });
});

describe("SAFE_INLINE_IMAGE", () => {
  it("só imagens comuns; SVG e HTML nunca aparecem no corpo", () => {
    for (const t of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) expect(SAFE_INLINE_IMAGE.test(t), t).toBe(true);
    for (const t of ["image/svg+xml", "text/html", "application/pdf", "image/png; x=1"]) expect(SAFE_INLINE_IMAGE.test(t), t).toBe(false);
  });
});
