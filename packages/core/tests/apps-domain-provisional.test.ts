/**
 * Reconhecimento do endereço provisório (<projeto>-<sufixo>.localhost) com que um
 * projeto nasce: num painel público ele não abre no computador da pessoa.
 */
import { describe, expect, it } from "vitest";
import { isLocalPanelHost, isProvisionalDomain, showsProvisionalNotice } from "../src/apps-domain";

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

describe("isLocalPanelHost", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "painel.localhost"])("%s é local", (h) => expect(isLocalPanelHost(h)).toBe(true));
  it.each(["painel.example.com", "203.0.113.10"])("%s é público", (h) => expect(isLocalPanelHost(h)).toBe(false));
});

describe("showsProvisionalNotice", () => {
  it("só avisa com provisório num painel público", () => {
    expect(showsProvisionalNotice("loja-p4r7m.localhost", "painel.example.com")).toBe(true);
    expect(showsProvisionalNotice("loja-p4r7m.localhost", "localhost")).toBe(false);
    expect(showsProvisionalNotice("loja.apps.example.com", "painel.example.com")).toBe(false);
  });
});
