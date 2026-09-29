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

/**
 * Acesso ao painel por HTTPS (https://<ip-com-hífens>.sslip.io): o Caddy
 * central atende também o painel. O bloco dele é FIXO — o Caddyfile é
 * regenerado inteiro a cada deploy, e um deploy nunca pode apagar o acesso
 * ao painel nem sequestrar o domínio dele.
 */
describe("renderCaddyfile — site do painel", () => {
  const PANEL = { domain: "203-0-113-10.sslip.io", upstream: "tws-panel:9000" };

  it("sem projetos: o painel é servido (em vez do 404 geral)", () => {
    const out = renderCaddyfile([], PANEL);
    expect(out).toContain("203-0-113-10.sslip.io {");
    expect(out).toContain("reverse_proxy tws-panel:9000");
    expect(out).not.toContain("respond 404");
  });

  it("com projetos: o painel continua presente junto deles", () => {
    const out = renderCaddyfile([{ domain: "loja.example.com", upstream: "paas-loja:3000", websocket: false }], PANEL);
    expect(out).toContain("203-0-113-10.sslip.io {");
    expect(out).toContain("loja.example.com {");
  });

  it("terminal ao vivo: o bloco do painel não segura a saída em buffer", () => {
    const out = renderCaddyfile([], PANEL);
    const block = out.slice(out.indexOf("203-0-113-10.sslip.io {"));
    expect(block).toContain("flush_interval -1");
  });

  it("projeto com o mesmo domínio do painel é descartado (não sequestra o acesso)", () => {
    const out = renderCaddyfile([{ domain: PANEL.domain, upstream: "paas-intruso:80", websocket: false }], PANEL);
    expect(out).not.toContain("paas-intruso");
    expect(out.match(/203-0-113-10\.sslip\.io \{/g)).toHaveLength(1);
  });

  it("domínio do painel inválido é ignorado (defesa em profundidade)", () => {
    const out = renderCaddyfile([], { domain: "x.com {\n respond hi\n}", upstream: "tws-panel:9000" });
    expect(out).not.toContain("respond hi");
    expect(out).toContain("respond 404");
  });
});
