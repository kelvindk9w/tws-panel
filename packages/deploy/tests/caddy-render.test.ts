/**
 * Renderização do Caddyfile — defesa em profundidade contra injeção de
 * diretiva via domínio.
 *
 * O domínio já é validado ao criar/atualizar o projeto (normalizeDomain), mas
 * o Caddyfile também é gerado a partir de projetos persistidos antes dessa
 * validação existir. Um domínio com `{`, `}` ou quebra de linha não pode virar
 * bloco de configuração.
 */
import { describe, expect, it } from "vitest";
import { renderCaddyfile } from "../src/caddy.js";

describe("renderCaddyfile", () => {
  it("gera um bloco por alvo válido", () => {
    const out = renderCaddyfile([{ domain: "loja.example.com", upstream: "paas-loja:3000", websocket: false }]);
    expect(out).toContain("loja.example.com {");
    expect(out).toContain("reverse_proxy paas-loja:3000");
  });

  it("usa http:// para domínios .localhost", () => {
    const out = renderCaddyfile([{ domain: "loja.localhost", upstream: "paas-loja:3000", websocket: false }]);
    expect(out).toContain("http://loja.localhost {");
  });

  it("descarta alvo cujo domínio não é um hostname válido", () => {
    const out = renderCaddyfile([
      { domain: "mal.com {\n\trespond \"invadido\"\n}\nadmin.com", upstream: "paas-mal:3000", websocket: false },
      { domain: "ok.example.com", upstream: "paas-ok:3000", websocket: false },
    ]);
    expect(out).not.toContain("invadido");
    expect(out).not.toContain("admin.com");
    expect(out).toContain("ok.example.com {");
  });

  it("descarta alvo cujo upstream não é host:porta", () => {
    const out = renderCaddyfile([
      { domain: "mal.example.com", upstream: "paas-mal:3000\n\trespond \"invadido\"", websocket: false },
    ]);
    expect(out).not.toContain("invadido");
  });
});
