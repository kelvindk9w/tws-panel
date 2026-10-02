/**
 * Leitura do log do Caddy central para a página Certificados.
 *
 * Formato: uma linha JSON por evento (logger zap do Caddy). As mensagens de
 * emissão vêm do certmagic: "obtaining certificate", "certificate obtained
 * successfully", "could not get certificate from issuer" (campos
 * identifier/issuer/error), "will retry" (erro com o nome entre colchetes no
 * começo, attempt, retrying_in em segundos) e, do cliente ACME,
 * "trying to solve challenge" / "challenge failed" (identifier,
 * challenge_type, problem{type,detail}).
 *
 * Linhas de log são dados NÃO confiáveis: só campos são extraídos, o texto
 * mostrado é limitado e sem caracteres de controle.
 */
import { describe, expect, it } from "vitest";
import { explainIssueError, parseCaddyCertificateLog, sanitizeLogText } from "../src/caddy-log.js";

const OBTIDO =
  '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"mail.exemplo.com.br","issuer":"acme-v02.api.letsencrypt.org-directory"}';
const TENTANDO =
  '{"level":"info","logger":"http.acme_client","msg":"trying to solve challenge","identifier":"mail.exemplo.com.br","challenge_type":"tls-alpn-01"}';
const FALHA_EMISSOR = JSON.stringify({
  level: "error",
  ts: 1790000000.5,
  logger: "tls.obtain",
  msg: "could not get certificate from issuer",
  identifier: "loja.exemplo.com.br",
  issuer: "acme-v02.api.letsencrypt.org-directory",
  error:
    "HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A for loja.exemplo.com.br - check that a DNS record exists for this domain",
});
const DESAFIO_FALHOU = JSON.stringify({
  level: "error",
  ts: 1790000100,
  logger: "http.acme_client",
  msg: "challenge failed",
  identifier: "app.exemplo.com.br",
  challenge_type: "http-01",
  problem: {
    type: "urn:ietf:params:acme:error:connection",
    detail: "203.0.113.10: Fetching http://app.exemplo.com.br/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)",
  },
});
const VAI_TENTAR = JSON.stringify({
  level: "error",
  ts: 1790000200,
  logger: "tls.obtain",
  msg: "will retry",
  error:
    "[painel.exemplo.com.br] Obtain: [painel.exemplo.com.br] solving challenge: painel.exemplo.com.br: [painel.exemplo.com.br] authorization failed: HTTP 403 urn:ietf:params:acme:error:unauthorized - 2606:4700::1: Invalid response from https://painel.exemplo.com.br/.well-known/acme-challenge/x: 521",
  attempt: 1,
  retrying_in: 60,
  elapsed: 1.2,
  max_duration: 2592000,
});
const LIMITE = JSON.stringify({
  level: "error",
  ts: "2026-10-01T10:00:00.000Z",
  logger: "tls.obtain",
  msg: "could not get certificate from issuer",
  identifier: "site.exemplo.com.br",
  error:
    "HTTP 429 urn:ietf:params:acme:error:rateLimited - too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2026-10-03 12:00:00 UTC: see https://letsencrypt.org/docs/rate-limits/",
});

describe("parseCaddyCertificateLog", () => {
  it("lê os formatos reais: sucesso e desafio em andamento", () => {
    const events = parseCaddyCertificateLog([TENTANDO, OBTIDO].join("\n"));
    expect(events.get("mail.exemplo.com.br")?.kind).toBe("obtained");
    const soTentando = parseCaddyCertificateLog(TENTANDO);
    expect(soTentando.get("mail.exemplo.com.br")?.kind).toBe("trying");
  });

  it("guarda o ÚLTIMO evento de cada nome (sucesso depois de falha vale sucesso, e vice-versa)", () => {
    const falhaDepois = JSON.stringify({ ...JSON.parse(FALHA_EMISSOR), identifier: "mail.exemplo.com.br" });
    expect(parseCaddyCertificateLog([OBTIDO, falhaDepois].join("\n")).get("mail.exemplo.com.br")?.kind).toBe("error");
    expect(parseCaddyCertificateLog([falhaDepois, OBTIDO].join("\n")).get("mail.exemplo.com.br")?.kind).toBe("obtained");
  });

  it("erro do emissor: guarda o texto do erro e a hora (ts em segundos)", () => {
    const ev = parseCaddyCertificateLog(FALHA_EMISSOR).get("loja.exemplo.com.br")!;
    expect(ev.kind).toBe("error");
    expect(ev.detail).toContain("NXDOMAIN");
    expect(ev.at).toBe(new Date(1790000000500).toISOString());
  });

  it("desafio falhou: usa problem.detail", () => {
    const ev = parseCaddyCertificateLog(DESAFIO_FALHOU).get("app.exemplo.com.br")!;
    expect(ev.kind).toBe("error");
    expect(ev.detail).toContain("Timeout during connect");
    expect(ev.detail).toContain("urn:ietf:params:acme:error:connection");
  });

  it("'will retry' sem identifier: o nome sai do começo do erro, entre colchetes; guarda retrying_in", () => {
    const ev = parseCaddyCertificateLog(VAI_TENTAR).get("painel.exemplo.com.br")!;
    expect(ev.kind).toBe("error");
    expect(ev.retryingInSeconds).toBe(60);
  });

  it("aceita identifiers (lista) e server_name", () => {
    const a = JSON.stringify({ level: "error", logger: "tls.obtain", msg: "could not get certificate from issuer", identifiers: ["x.exemplo.com.br"], error: "boom" });
    const b = JSON.stringify({ level: "info", logger: "tls.obtain", msg: "obtaining certificate", server_name: "y.exemplo.com.br" });
    const ev = parseCaddyCertificateLog([a, b].join("\n"));
    expect(ev.get("x.exemplo.com.br")?.kind).toBe("error");
    expect(ev.get("y.exemplo.com.br")?.kind).toBe("trying");
  });

  it("ignora o que não é JSON, JSON que não é objeto, mensagens sem relação e nomes fora do formato", () => {
    const lixo = [
      "texto solto",
      "[1,2,3]",
      '{"level":"info","msg":"serving initial configuration"}',
      '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"a b; rm -rf /"}',
      '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":{"x":1}}',
      "{quebrado",
    ].join("\n");
    expect(parseCaddyCertificateLog(lixo).size).toBe(0);
  });

  it("nome em maiúsculas é normalizado; wildcard é aceito", () => {
    const l = JSON.stringify({ level: "info", logger: "tls.obtain", msg: "certificate obtained successfully", identifier: "*.Exemplo.com.br" });
    expect(parseCaddyCertificateLog(l).has("*.exemplo.com.br")).toBe(true);
  });

  it("texto do erro limitado e sem caracteres de controle", () => {
    const enorme = JSON.stringify({
      level: "error",
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      identifier: "z.exemplo.com.br",
      error: "\u001b[31mvermelho\u0007 " + "a".repeat(5000),
    });
    const ev = parseCaddyCertificateLog(enorme).get("z.exemplo.com.br")!;
    expect(ev.detail!.length).toBeLessThanOrEqual(300);
    expect(ev.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("linha gigante é descartada sem travar", () => {
    const gigante = '{"identifier":"g.exemplo.com.br","msg":"certificate obtained successfully","pad":"' + "x".repeat(200_000) + '"}';
    expect(parseCaddyCertificateLog(gigante).size).toBe(0);
  });
});

describe("sanitizeLogText", () => {
  it("tira controle, junta espaços e corta com reticências", () => {
    expect(sanitizeLogText("a\n\tb\u0000c", 300)).toBe("a b c");
    expect(sanitizeLogText("x".repeat(20), 10)).toBe("xxxxxxxxx…");
  });
});

describe("explainIssueError — causa provável em linguagem de leigo", () => {
  const now = new Date("2026-10-01T12:00:00Z");

  it("DNS inexistente → dns", () => {
    const e = explainIssueError(JSON.parse(FALHA_EMISSOR).error, now);
    expect(e.cause).toBe("dns");
    expect(e.message).toMatch(/DNS/);
  });

  it("timeout / conexão recusada → porta 80 ou 443 fechada", () => {
    const e = explainIssueError("urn:ietf:params:acme:error:connection - Timeout during connect (likely firewall problem)", now);
    expect(e.cause).toBe("firewall");
    expect(e.message).toMatch(/80/);
    expect(e.message).toMatch(/443/);
  });

  it("resposta 521 / ALPN da Cloudflare → nuvem laranja", () => {
    expect(explainIssueError(JSON.parse(VAI_TENTAR).error, now).cause).toBe("cloudflare");
    expect(explainIssueError('Cannot negotiate ALPN protocol "acme-tls/1" for tls-alpn-01 challenge', now).cause).toBe("cloudflare");
  });

  it("unauthorized sem sinal de Cloudflare → DNS aponta para outro lugar", () => {
    const e = explainIssueError("HTTP 403 urn:ietf:params:acme:error:unauthorized - Invalid response from http://x/: 404", now);
    expect(e.cause).toBe("dns");
  });

  it("limite do Let's Encrypt: diz a partir de quando dá para tentar de novo", () => {
    const e = explainIssueError(JSON.parse(LIMITE).error, now);
    expect(e.cause).toBe("rate_limit");
    expect(e.retryAfter).toBe("2026-10-03T12:00:00.000Z");
    expect(e.message).toMatch(/03\/10\/2026/);
  });

  it("limite sem data → mensagem genérica de espera", () => {
    const e = explainIssueError("urn:ietf:params:acme:error:rateLimited - too many failed authorizations recently", now);
    expect(e.cause).toBe("rate_limit");
    expect(e.retryAfter).toBeNull();
  });

  it("CAA proibindo o emissor → caa", () => {
    expect(explainIssueError("urn:ietf:params:acme:error:caa - CAA record for exemplo.com.br prevents issuance", now).cause).toBe("caa");
  });

  it("desconhecido → mensagem genérica, sem inventar causa", () => {
    const e = explainIssueError("algo estranho", now);
    expect(e.cause).toBe("unknown");
    expect(e.detail).toBe("algo estranho");
  });
});
