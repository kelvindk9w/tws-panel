/**
 * Aviso de valor estranho em variável de HOST (SITE_HOST=http://…).
 *
 * Caso real: o dono salvou SITE_HOST=http://site e CARTEIRA_HOST=https://carteira…;
 * o compose esperava só o nome do host, o Caddy do projeto montou "http://http://…"
 * e a tela ficou em branco sem nenhuma pista. A regra é pequena e conservadora:
 * só nomes terminados em _HOST/_HOSTNAME/_DOMAIN, nunca *_URL*.
 */
import { describe, expect, it } from "vitest";
import {
  checkHostVariable,
  hostVariableLogLines,
  isHostVariableName,
  isSecretVariableName,
} from "../src/env-hosts";

describe("isHostVariableName", () => {
  it("vale para _HOST, _HOSTNAME, _DOMAIN e os nomes soltos, sem diferenciar caixa", () => {
    for (const n of ["SITE_HOST", "CARTEIRA_HOSTNAME", "APP_DOMAIN", "HOST", "domain", "site_host"]) {
      expect(isHostVariableName(n)).toBe(true);
    }
  });

  it("não vale para URL, plural, prefixo ou sufixo parecido", () => {
    for (const n of ["SITE_URL", "BASE_URL_HOST_X", "ALLOWED_HOSTS", "PGHOST", "HOSTING", "SITE_HOSTED", "DOMAINS"]) {
      expect(isHostVariableName(n)).toBe(false);
    }
  });

  it("DOCKER_HOST fica de fora: o esquema (unix://, tcp://) faz parte do valor", () => {
    expect(isHostVariableName("DOCKER_HOST")).toBe(false);
  });
});

describe("isSecretVariableName", () => {
  it("reconhece nome com cara de segredo", () => {
    for (const n of ["DB_PASSWORD", "api_key", "AUTH_HOST", "JWT_SECRET", "GITHUB_TOKEN"]) {
      expect(isSecretVariableName(n)).toBe(true);
    }
    expect(isSecretVariableName("SITE_HOST")).toBe(false);
  });
});

describe("checkHostVariable", () => {
  it("valor correto, vazio ou sem relação não gera aviso", () => {
    expect(checkHostVariable("SITE_HOST", "site.example.com")).toBeNull();
    expect(checkHostVariable("SITE_HOST", "localhost")).toBeNull();
    expect(checkHostVariable("DB_HOST", "10.0.0.5")).toBeNull();
    expect(checkHostVariable("DB_HOST", "::1")).toBeNull();
    expect(checkHostVariable("SITE_HOST", "")).toBeNull();
    expect(checkHostVariable("SITE_HOST", "   ")).toBeNull();
    expect(checkHostVariable("SITE_URL", "https://site.example.com/")).toBeNull();
  });

  it("não avisa em socket unix, interpolação nem lista separada por vírgula", () => {
    expect(checkHostVariable("DB_HOST", "/var/run/postgresql")).toBeNull();
    expect(checkHostVariable("SITE_HOST", "${OUTRO_HOST}")).toBeNull();
    expect(checkHostVariable("SITE_DOMAIN", "a.example.com, b.example.com")).toBeNull();
  });

  it("esquema: sugere só o nome do host", () => {
    expect(checkHostVariable("SITE_HOST", "http://site.example.com")).toEqual({
      problems: ["scheme"],
      suggestion: "site.example.com",
      hasCredentials: false,
    });
    expect(checkHostVariable("CARTEIRA_HOST", "https://carteira.example.com")?.suggestion).toBe("carteira.example.com");
  });

  it("barra final e caminho", () => {
    expect(checkHostVariable("SITE_HOST", "site.example.com/")).toMatchObject({ problems: ["path"], suggestion: "site.example.com" });
    expect(checkHostVariable("SITE_HOST", "site.example.com/app?x=1#y")).toMatchObject({ problems: ["path"], suggestion: "site.example.com" });
    expect(checkHostVariable("SITE_HOST", "https://site.example.com/")).toMatchObject({ problems: ["scheme", "path"] });
  });

  it("porta (inclusive IPv6 entre colchetes), mas IPv6 sem colchetes não é porta", () => {
    expect(checkHostVariable("MAIL_HOST", "mail.example.com:587")).toMatchObject({ problems: ["port"], suggestion: "mail.example.com" });
    expect(checkHostVariable("MAIL_HOST", "[::1]:25")).toMatchObject({ problems: ["port"], suggestion: "[::1]" });
    expect(checkHostVariable("MAIL_HOST", "http://app.example.com:8080/x")).toMatchObject({
      problems: ["scheme", "path", "port"],
      suggestion: "app.example.com",
    });
  });

  it("espaço no meio ou nas pontas", () => {
    expect(checkHostVariable("SITE_HOST", " site.example.com")).toMatchObject({ problems: ["space"], suggestion: "site.example.com" });
    expect(checkHostVariable("SITE_HOST", "site.example.com ")).toMatchObject({ problems: ["space"] });
    expect(checkHostVariable("SITE_HOST", "site example.com")).toMatchObject({ problems: ["space"], suggestion: "site" });
  });

  it("credenciais na frente do host são marcadas e não entram na sugestão", () => {
    expect(checkHostVariable("SITE_HOST", "https://usuario:senha@site.example.com")).toEqual({
      problems: ["scheme"],
      suggestion: "site.example.com",
      hasCredentials: true,
    });
  });

  it("sem nada aproveitável, não há sugestão", () => {
    expect(checkHostVariable("SITE_HOST", "http://")).toMatchObject({ problems: ["scheme"], suggestion: null });
    expect(checkHostVariable("SITE_HOST", "#fragmento")).toMatchObject({ suggestion: null });
  });
});

describe("hostVariableLogLines", () => {
  it("uma linha de aviso por variável estranha, com a sugestão", () => {
    const lines = hostVariableLogLines({ SITE_HOST: "http://site.example.com", OK_HOST: "ok.example.com", SITE_URL: "http://x/" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("SITE_HOST");
    expect(lines[0]).toContain("esquema");
    expect(lines[0]).toContain("site.example.com");
    expect(lines[0].endsWith("\n")).toBe(true);
  });

  it("lista todos os problemas encontrados", () => {
    const [line] = hostVariableLogLines({ A_HOST: "https://a.example.com:8443/x y" });
    for (const palavra of ["esquema", "barra", "porta", "espaço"]) expect(line).toContain(palavra);
  });

  it("nunca imprime o valor de variável com nome de segredo nem o de valor com credenciais", () => {
    const lines = hostVariableLogLines({
      AUTH_HOST: "https://segredo-do-host.example.com",
      SITE_HOST: "https://usuario:senha-secreta@site.example.com",
    });
    expect(lines).toHaveLength(2);
    const texto = lines.join("");
    expect(texto).not.toContain("segredo-do-host");
    expect(texto).not.toContain("senha-secreta");
    expect(texto).not.toContain("usuario");
    expect(texto).not.toContain("site.example.com");
    expect(texto).toContain("AUTH_HOST");
    expect(texto).toContain("SITE_HOST");
  });

  it("nunca imprime o valor original, só a sugestão", () => {
    const [line] = hostVariableLogLines({ SITE_HOST: "http://site.example.com/caminho-longo" });
    expect(line).not.toContain("caminho-longo");
  });

  it("sem variável estranha, nenhuma linha", () => {
    expect(hostVariableLogLines({})).toEqual([]);
  });
});
