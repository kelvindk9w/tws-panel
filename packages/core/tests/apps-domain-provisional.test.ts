/**
 * Reconhecimento do endereço provisório (<projeto>-<sufixo>.localhost) com que um
 * projeto nasce: num painel público ele não abre no computador da pessoa.
 */
import { describe, expect, it } from "vitest";
import { isProvisionalDomain, showsProvisionalNotice } from "../src/apps-domain";

describe("isProvisionalDomain", () => {
  it.each(["loja-p4r7m.localhost", "minha-loja-k3x9q2ab.localhost", "a-b-c-23456.localhost"])("reconhece %s", (d) => {
    expect(isProvisionalDomain(d)).toBe(true);
  });
  it.each(["loja.localhost", "loja-p4r7.localhost", "loja-p4r7m.example.com", "loja-p4r7m.localhost.example.com", "localhost", "loja-P4R7M.localhost", "loja-p4r7l.localhost", ""])(
    "não reconhece %s",
    (d) => {
      expect(isProvisionalDomain(d)).toBe(false);
    },
  );
});

describe("showsProvisionalNotice", () => {
  it("só avisa com provisório quando o servidor diz que o painel é público", () => {
    expect(showsProvisionalNotice("loja-p4r7m.localhost", true)).toBe(true);
    expect(showsProvisionalNotice("loja-p4r7m.localhost", false)).toBe(false);
    expect(showsProvisionalNotice("loja.apps.example.com", true)).toBe(false);
  });
});
