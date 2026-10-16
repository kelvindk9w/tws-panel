/**
 * certificate-file-id.test.ts — nome de arquivo/seção do certificado de um host.
 *
 * Achado 7 da revisão: a regra antiga trocava qualquer sequência que não
 * fosse letra ou número por hífen, e domínios distintos caíam no mesmo id
 * (a-b.exemplo.com e a.b-exemplo.com → a-b-exemplo-com). Um certificado
 * sobrescrevia o outro no painel, no Caddy e no Stalwart.
 */
import { describe, expect, it } from "vitest";
import { certificateFileId, legacyCertificateFileId } from "../src/index";

describe("certificateFileId", () => {
  it("domínios que só diferem na posição de ponto e hífen têm ids diferentes", () => {
    expect(certificateFileId("a-b.exemplo.com")).not.toBe(certificateFileId("a.b-exemplo.com"));
    expect(certificateFileId("mail.foo-bar.com")).not.toBe(certificateFileId("mail.foo.bar.com"));
  });

  it("nome sem hífen fica com o mesmo id de antes (nada a migrar)", () => {
    expect(certificateFileId("mail.exemplo.com.br")).toBe("mail-exemplo-com-br");
    expect(certificateFileId("mail.exemplo.com.br")).toBe(legacyCertificateFileId("mail.exemplo.com.br"));
  });

  it("hífen vira hífen duplo, ponto vira hífen; maiúsculas não importam", () => {
    expect(certificateFileId("Mail.Foo-Bar.com")).toBe("mail-foo--bar-com");
    expect(certificateFileId("xn--ls8h.exemplo.com")).toBe("xn----ls8h-exemplo-com");
  });

  it("só usa letras, números, hífen e sublinhado (arquivo e chave TOML sem aspas)", () => {
    for (const host of ["a-b.exemplo.com", "*.exemplo.com", "a_b.exemplo.com", "loja.exemplo.com.br"]) {
      expect(certificateFileId(host)).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("caracteres fora de hostname comum não colidem com o hífen", () => {
    expect(certificateFileId("*.exemplo.com")).toBe("_2a_-exemplo-com");
    expect(certificateFileId("*.exemplo.com")).not.toBe(certificateFileId("-.exemplo.com"));
    expect(certificateFileId("a_b.exemplo.com")).not.toBe(certificateFileId("a-b.exemplo.com"));
  });

  it("muitos nomes parecidos, nenhum id repetido", () => {
    const hosts = [
      "a-b.exemplo.com", "a.b-exemplo.com", "a.b.exemplo.com", "ab.exemplo.com", "a--b.exemplo.com",
      "mail.foo-bar.com", "mail.foo.bar.com", "mail-foo.bar.com", "mail-foo-bar.com",
    ];
    expect(new Set(hosts.map(certificateFileId)).size).toBe(hosts.length);
  });
});

describe("legacyCertificateFileId — a regra antiga, só para migrar o que já está gravado", () => {
  it("colide como antes", () => {
    expect(legacyCertificateFileId("a-b.exemplo.com")).toBe("a-b-exemplo-com");
    expect(legacyCertificateFileId("a.b-exemplo.com")).toBe("a-b-exemplo-com");
  });
});
