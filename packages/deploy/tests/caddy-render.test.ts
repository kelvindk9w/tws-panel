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

  it("sem projetos: o painel é servido; outros hosts em HTTP caem na página de domínio não configurado", () => {
    const out = renderCaddyfile([], PANEL);
    expect(out).toContain("203-0-113-10.sslip.io {");
    expect(out).toContain("reverse_proxy tws-panel:9000");
    expect(out.indexOf("203-0-113-10.sslip.io {")).toBeLessThan(out.indexOf("http:// {"));
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
    expect(out).toMatch(/http:\/\/ \{[\s\S]*` 404/);
  });
});

/**
 * Vários domínios no mesmo projeto (validação real, 30/09/2026): o endereço
 * automático sslip.io e um subdomínio próprio (devlink.tws.tec.br) servidos
 * juntos, cada um com o seu certificado.
 */
describe("renderCaddyfile — domínios adicionais do projeto", () => {
  it("todos os domínios do projeto no mesmo bloco", () => {
    const out = renderCaddyfile([
      { domain: "devlink.203-0-113-10.sslip.io", aliases: ["devlink.tws.tec.br", "www.devlink.com"], upstream: "devlink:80", websocket: false },
    ]);
    expect(out).toContain("devlink.203-0-113-10.sslip.io, devlink.tws.tec.br, www.devlink.com {");
  });

  it("domínio adicional com caractere perigoso é descartado (o resto segue)", () => {
    const out = renderCaddyfile([
      { domain: "app.exemplo.com", aliases: ["ok.exemplo.com", "mal}.exemplo.com"], upstream: "app:80", websocket: false },
    ]);
    expect(out).toContain("app.exemplo.com, ok.exemplo.com {");
    expect(out).not.toContain("mal}");
  });

  it("domínio adicional igual ao do painel não sequestra o acesso ao painel", () => {
    const out = renderCaddyfile(
      [{ domain: "app.exemplo.com", aliases: ["painel.exemplo.com"], upstream: "app:80", websocket: false }],
      { domain: "painel.exemplo.com", upstream: "tws-panel:9000" },
    );
    expect(out).toContain("app.exemplo.com {");
    expect(out.match(/painel\.exemplo\.com/g)).toHaveLength(1);
  });
});

/**
 * Páginas de erro (validação real, 30/09/2026): ao parar um projeto, o
 * visitante via a página de erro crua do navegador/proxy. Agora: uma página
 * neutra de "temporariamente indisponível" (o visitante é o cliente do dono do
 * site — nada de propaganda; a TWS só numa linha discreta no rodapé) e, para
 * domínio que aponta para o servidor sem estar em projeto nenhum, "domínio
 * ainda não configurado".
 */
describe("renderCaddyfile — páginas de erro", () => {
  const out = renderCaddyfile(
    [{ domain: "site.exemplo.com", upstream: "site:80", websocket: false }],
    { domain: "painel.exemplo.com", upstream: "tws-panel:9000" },
  );

  it("projeto fora do ar (502/503/504) → página de indisponível, status 503", () => {
    const bloco = out.slice(out.indexOf("site.exemplo.com {"));
    expect(bloco).toMatch(/handle_errors 502 503 504/);
    expect(bloco).toContain("temporariamente indisponível");
    expect(bloco).toMatch(/respond `[\s\S]*` 503/);
  });

  it("o bloco do painel não ganha a página de indisponível", () => {
    const painel = out.slice(out.indexOf("painel.exemplo.com {"), out.indexOf("site.exemplo.com {"));
    expect(painel).not.toContain("handle_errors");
  });

  it("domínio desconhecido em HTTP → página 'domínio ainda não configurado', status 404", () => {
    expect(out).toMatch(/http:\/\/ \{[\s\S]*ainda não está configurado[\s\S]*404/);
  });

  it("o HTML das páginas não tem chaves nem crases (seriam lidos como variáveis/fim de texto pelo Caddy)", () => {
    const corpos = [...out.matchAll(/respond `([\s\S]*?)`/g)].map((m) => m[1]!);
    expect(corpos.length).toBeGreaterThanOrEqual(2);
    for (const c of corpos) expect(c).not.toMatch(/[{}`]/);
  });
});
