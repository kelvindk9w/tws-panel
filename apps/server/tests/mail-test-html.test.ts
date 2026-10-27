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

  it("os links abrem fora do iframe (sem efeito dentro do sandbox)", () => {
    const out = renderMailHtml("<a href='https://app.example.com/x'>x</a>", []);
    expect(out).toContain('<base target="_blank">');
    expect(out).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("troca cid: pela imagem embutida, com ou sem <>, sem interpretar $ do endereço", () => {
    const out = renderMailHtml('<img src="cid:logo.png@x"><img src="CID:outro">', [
      { contentId: "<logo.png@x>", dataUri: "data:image/png;base64,AAA$&" },
      { contentId: "outro", dataUri: "data:image/gif;base64,BBB" },
    ]);
    expect(out).toContain('src="data:image/png;base64,AAA$&"');
    expect(out).toContain('src="data:image/gif;base64,BBB"');
    expect(out).not.toMatch(/cid:/i);
  });

  it("cid com caracteres especiais de expressão regular não quebra", () => {
    expect(renderMailHtml('<img src="cid:a(b)+c">', [{ contentId: "a(b)+c", dataUri: "data:image/png;base64,X" }])).toContain('src="data:image/png;base64,X"');
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
