/**
 * Domínio de aplicações no proxy — o que o Caddyfile garante:
 *  - cada projeto sob a base (<projeto>-<sufixo>.apps.example.com) tem a sua
 *    rota EXPLÍCITA por host: o Caddy emite o certificado desse nome, como
 *    para qualquer domínio próprio;
 *  - NÃO há certificado curinga (bloco *.base), nem emissão sob demanda
 *    (on_demand_tls), nem diretiva global que a habilite: um nome aleatório sob
 *    a base, sem rota, não é atendido por HTTPS e não tem certificado emitido;
 *  - o curinga digitado por engano num domínio nunca vira bloco;
 *  - o catch-all em HTTP (404 "domínio não configurado") é o único bloco sem nome.
 *
 * (Teste de caracterização: descreve o comportamento do renderizador, que já
 * era assim; protege contra quem, no futuro, ligar curinga ou on-demand.)
 */
import { describe, expect, it } from "vitest";
import { renderCaddyfile } from "../src/caddy.js";

const app = (domain: string, port = 3000) => ({ domain, upstream: `paas-x:${port}`, websocket: false });

describe("renderCaddyfile — endereços sob o domínio de aplicações", () => {
  const out = renderCaddyfile([app("dev-link-k3x9q.apps.example.com"), app("loja-m4n5p.apps.example.com")]);

  it("um bloco por host, sem esquema (HTTPS automático) e com o upstream do projeto", () => {
    expect(out).toContain("\ndev-link-k3x9q.apps.example.com {\n");
    expect(out).toContain("\nloja-m4n5p.apps.example.com {\n");
    expect(out).not.toContain("http://dev-link-k3x9q");
  });

  it("não há bloco curinga, nem on_demand_tls, nem bloco global de opções", () => {
    expect(out).not.toMatch(/\*/);
    expect(out).not.toMatch(/on_demand/);
    expect(out).not.toMatch(/\bask\b/);
    expect(out).not.toMatch(/^\{$/m);
    expect(out).not.toMatch(/\btls\b/);
  });

  it("os únicos nomes do arquivo são os dos projetos; um nome aleatório sob a base não aparece em lugar nenhum", () => {
    const sites = out.split("\n").filter((l) => l.endsWith(" {") && !l.startsWith("\t"));
    expect(sites).toEqual(["dev-link-k3x9q.apps.example.com {", "loja-m4n5p.apps.example.com {", "http:// {"]);
    expect(out).not.toContain("paas-check-");
  });

  it("o bloco sem nome é só HTTP: nada ali pede certificado", () => {
    expect(out).toMatch(/\nhttp:\/\/ \{\n[\s\S]*respond `[\s\S]*` 404\n\}/);
  });

  it("curinga digitado num domínio (principal ou adicional) é descartado, não vira bloco", () => {
    const hostile = renderCaddyfile([
      app("*.apps.example.com"),
      { ...app("ok-aaaaa.apps.example.com"), aliases: ["*.outro.example.com", "{http.request.host}.example.com", "b-bbbbb.apps.example.com"] },
    ]);
    expect(hostile).not.toMatch(/\*/);
    expect(hostile).not.toContain("{http.request.host}");
    expect(hostile).toContain("ok-aaaaa.apps.example.com, b-bbbbb.apps.example.com {");
  });

  it("domínio com porta, barra, ponto e vírgula ou quebra de linha é descartado", () => {
    for (const domain of ["x-aaaaa.apps.example.com:8080", "x-aaaaa.apps.example.com/a", "x-aaaaa.apps.example.com;", "x-aaaaa.apps.example.com\nrespond 200", "x-aaaaa.apps.example.com ", "xn--.apps.example.com"]) {
      const text = renderCaddyfile([app(domain)]);
      expect(text, JSON.stringify(domain)).not.toContain("respond 200");
      expect(text.split("\n").filter((l) => l.endsWith(" {") && !l.startsWith("\t"))).toEqual(["http:// {"]);
    }
  });

  it("domínio do painel sob a base: o projeto não o sequestra", () => {
    const text = renderCaddyfile([app("painel.apps.example.com")], { domain: "painel.apps.example.com", upstream: "tws-panel:9000" });
    expect(text.match(/painel\.apps\.example\.com \{/g)).toHaveLength(1);
    expect(text).toContain("tws-panel:9000");
    expect(text).not.toContain("paas-x:3000");
  });
});
