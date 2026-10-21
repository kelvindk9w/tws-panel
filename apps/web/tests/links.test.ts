/**
 * links.test.ts — endereços de ajuda/feedback num módulo só e PRIVACIDADE do
 * link de relato de problema: só versão do painel e idioma podem sair daqui.
 */
import { describe, expect, it } from "vitest";
import {
  appsDomainGuideUrl,
  bugReportUrl,
  discussionsUrl,
  docsUrl,
  featureRequestUrl,
  helpPageUrl,
  restoreGuideUrl,
  REPO_URL,
  SITE_URL,
  siteLanguage,
} from "../src/lib/links";

/** Parâmetros que o link do bug pode, no máximo, carregar. */
const ALLOWED_PARAMS = ["template", "version", "locale"];

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("endereços por idioma", () => {
  it("pt-BR → /pt-br/; qualquer outro idioma → /en/", () => {
    expect(siteLanguage("pt-BR")).toBe("pt-br");
    expect(siteLanguage("pt")).toBe("pt-br");
    expect(siteLanguage("en")).toBe("en");
    expect(siteLanguage("es")).toBe("en");
    expect(siteLanguage("")).toBe("en");
  });

  it("guia e página de ajuda seguem o idioma da interface", () => {
    expect(docsUrl("pt-BR")).toBe(`${SITE_URL}/pt-br/`);
    expect(docsUrl("en")).toBe(`${SITE_URL}/en/`);
    expect(helpPageUrl("pt-BR")).toBe(`${SITE_URL}/pt-br/guides/help/`);
    expect(helpPageUrl("en")).toBe(`${SITE_URL}/en/guides/help/`);
    expect(restoreGuideUrl("pt-BR")).toBe(`${SITE_URL}/pt-br/guides/restore-new-server/`);
    expect(restoreGuideUrl("en")).toBe(`${SITE_URL}/en/guides/restore-new-server/`);
  });

  it("guia do domínio de aplicações segue o idioma e aponta para a âncora da Parte 2", () => {
    expect(appsDomainGuideUrl("pt-BR")).toBe(`${SITE_URL}/pt-br/getting-started/complete-guide/#dominio-de-aplicacoes`);
    expect(appsDomainGuideUrl("en")).toBe(`${SITE_URL}/en/getting-started/complete-guide/#dominio-de-aplicacoes`);
  });

  it("Discussions e formulário de funcionalidade apontam para o repositório", () => {
    expect(discussionsUrl()).toBe(`${REPO_URL}/discussions`);
    expect(featureRequestUrl()).toBe(`${REPO_URL}/issues/new?template=feature_request.yml`);
    expect(SITE_URL).toBe("https://kelvindk9w.github.io/tws-panel");
    expect(REPO_URL).toBe("https://github.com/kelvindk9w/tws-panel");
  });
});

describe("link de relato de problema (bug_report.yml)", () => {
  it("leva o formulário, a versão e o idioma — e mais nada", () => {
    const url = bugReportUrl({ version: "0.1.0", locale: "pt-BR" });
    expect(url.startsWith(`${REPO_URL}/issues/new?`)).toBe(true);
    const p = params(url);
    expect(p.get("template")).toBe("bug_report.yml");
    expect(p.get("version")).toBe("0.1.0");
    expect(p.get("locale")).toBe("pt-BR");
    expect([...p.keys()].sort()).toEqual(["locale", "template", "version"]);
  });

  it("sem versão conhecida, a versão não vai (nem vazia, nem 'unknown')", () => {
    for (const version of [undefined, null, "", "   ", "unknown"]) {
      const p = params(bugReportUrl({ version, locale: "en" }));
      expect(p.has("version")).toBe(false);
      expect(p.get("locale")).toBe("en");
    }
  });

  it("nenhum parâmetro fora da lista permitida, qualquer que seja a entrada", () => {
    const hostile = [
      "0.1.0&title=segredo",
      "0.1.0&body=senha",
      "1.0#fragmento",
      "1.0\nbody=linha2",
      "1.0\r\nassignees=x",
      "%26evil%3D1",
      "1.0 2.0",
      "<script>alert(1)</script>",
      "../../etc/passwd",
      "x".repeat(500),
      "203.0.113.10",
      "https://meu-dominio.example.com",
    ];
    for (const version of hostile) {
      for (const locale of ["pt-BR", "en", "pt-BR&labels=x", "en\nbody=y", "#x", "es"]) {
        const url = bugReportUrl({ version, locale });
        const p = params(url);
        for (const key of p.keys()) expect(ALLOWED_PARAMS).toContain(key);
        // a URL final não carrega fragmento nem quebra de linha crua
        expect(new URL(url).hash).toBe("");
        expect(url).not.toMatch(/[\r\n\s]/);
        expect(url).not.toMatch(/evil|segredo|senha|body=|title=|assignees|labels=/);
      }
    }
  });

  it("valor hostil é descartado, valor válido é preservado", () => {
    expect(params(bugReportUrl({ version: "0.1.0&x=1", locale: "en" })).has("version")).toBe(false);
    expect(params(bugReportUrl({ version: "1.2.3-beta.1+build.5", locale: "en" })).get("version")).toBe("1.2.3-beta.1+build.5");
    expect(params(bugReportUrl({ version: "0.1.0", locale: "en&x=1" })).has("locale")).toBe(false);
  });

  it("IP, domínio e números fora do formato semver são descartados da versão", () => {
    for (const version of ["192.168.0.1", "203.0.113.10", "painel.example.com", "1.2", "1", "01.2.3", "1.2.3.4", "v1.2.3", "1.2.3-", "1.2.3+", "1.2.3-a..b", "1.2.3-" + "a".repeat(40)]) {
      expect(params(bugReportUrl({ version, locale: "en" })).has("version"), version).toBe(false);
    }
    for (const version of ["0.1.0", "10.20.30", "1.2.3-rc.1", "1.2.3-alpha-1+build.7", "1.0.0+20130313144700"]) {
      expect(params(bugReportUrl({ version, locale: "en" })).get("version"), version).toBe(version);
    }
  });

  it("o '+' da versão sai codificado (não vira espaço no formulário)", () => {
    const url = bugReportUrl({ version: "1.2.3+build.5", locale: "en" });
    expect(url).toContain("version=1.2.3%2Bbuild.5");
  });

  it("ignora campos extras passados por engano (IP, domínio, e-mail, usuário, caminho)", () => {
    const extra = {
      version: "0.1.0",
      locale: "en",
      ip: "203.0.113.10",
      domain: "example.com",
      email: "a@example.com",
      user: "admin",
      path: "/opt/tws-panel",
      os: "Ubuntu 24.04",
    };
    const p = params(bugReportUrl(extra));
    expect([...p.keys()].sort()).toEqual(["locale", "template", "version"]);
    expect(bugReportUrl(extra)).not.toMatch(/203|example|admin|opt|Ubuntu/);
  });
});
