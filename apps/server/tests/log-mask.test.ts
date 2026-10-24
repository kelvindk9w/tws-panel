/**
 * log-mask.test.ts — limpeza e máscara de segredos do texto dos logs dos
 * containers (aba Logs do projeto). Melhor esforço: valores das variáveis do
 * próprio projeto (não triviais) e padrões óbvios (Bearer, senha em URL).
 */
import { describe, expect, it } from "vitest";
import {
  LOG_LINE_MAX,
  LOG_MASK,
  LOG_SECRET_MIN,
  buildLogMasker,
  cleanLogText,
} from "../src/services/log-mask.js";

describe("buildLogMasker: valores das variáveis do projeto", () => {
  it("mascara o valor em qualquer posição da linha, todas as ocorrências", () => {
    const mask = buildLogMasker(["s3cr3t-Valor-9"]);
    expect(mask("login com s3cr3t-Valor-9 e de novo s3cr3t-Valor-9!")).toBe(`login com ${LOG_MASK} e de novo ${LOG_MASK}!`);
  });

  it("valor curto (menos de 8 caracteres) não é mascarado: viraria ruído", () => {
    expect(LOG_SECRET_MIN).toBe(8);
    const mask = buildLogMasker(["1234567", "8080", "abc"]);
    expect(mask("porta 8080 senha 1234567 abc")).toBe("porta 8080 senha 1234567 abc");
  });

  it("valor com exatamente 8 caracteres é mascarado (limite)", () => {
    const mask = buildLogMasker(["12345678"]);
    expect(mask("x 12345678 y")).toBe(`x ${LOG_MASK} y`);
  });

  it("o mais longo vence quando um valor contém o outro", () => {
    const mask = buildLogMasker(["abcdefgh", "abcdefgh-extra-12"]);
    expect(mask("v=abcdefgh-extra-12 w=abcdefgh")).toBe(`v=${LOG_MASK} w=${LOG_MASK}`);
  });

  it("valor com caracteres de regex vale literalmente", () => {
    const mask = buildLogMasker(["a.b*c+d?(e)[f]{g}|h^$"]);
    expect(mask("t a.b*c+d?(e)[f]{g}|h^$ fim")).toBe(`t ${LOG_MASK} fim`);
    expect(mask("t aXbbbbcd?(e)[f]{g}|h^$ fim")).toBe("t aXbbbbcd?(e)[f]{g}|h^$ fim");
  });

  it("a forma codificada na URL do valor também é mascarada", () => {
    const mask = buildLogMasker(["p@ss word/123"]);
    expect(mask("GET /x?k=p%40ss%20word%2F123")).toBe(`GET /x?k=${LOG_MASK}`);
  });

  it("valor de várias linhas (certificado): cada linha longa é mascarada", () => {
    const mask = buildLogMasker(["-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END KEY-----"]);
    expect(mask("dump MIIEvQIBADANBgkqhkiG9w0B fim")).toBe(`dump ${LOG_MASK} fim`);
  });

  it("valores triviais de ambiente (production, localhost…) não são mascarados", () => {
    const mask = buildLogMasker(["production", "Development", "localhost", "127.0.0.1"]);
    expect(mask("NODE_ENV=production em localhost 127.0.0.1")).toBe("NODE_ENV=production em localhost 127.0.0.1");
  });

  it("lista vazia e valores repetidos não quebram", () => {
    expect(buildLogMasker([])("nada a fazer")).toBe("nada a fazer");
    expect(buildLogMasker(["repetido-123", "repetido-123"])("a repetido-123")).toBe(`a ${LOG_MASK}`);
  });
});

describe("buildLogMasker: padrões óbvios", () => {
  const mask = buildLogMasker([]);

  it("Bearer: o token some, a palavra fica", () => {
    expect(mask("Authorization: Bearer eyJhbGciOi.abc-def_ghi=")).toBe(`Authorization: Bearer ${LOG_MASK}`);
    expect(mask("header bearer abc123XYZ789 fim")).toBe(`header bearer ${LOG_MASK} fim`);
  });

  it("Basic também", () => {
    expect(mask("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: Basic ${LOG_MASK}`);
  });

  it("senha em URL de conexão: usuário e servidor ficam", () => {
    expect(mask("conectando postgres://app:S3nh4Forte@db:5432/app")).toBe(`conectando postgres://app:${LOG_MASK}@db:5432/app`);
    expect(mask("redis://:umaSenha@cache:6379")).toBe(`redis://:${LOG_MASK}@cache:6379`);
    expect(mask("mongodb+srv://u:p@ss@h.example.com/db")).toBe(`mongodb+srv://u:${LOG_MASK}@h.example.com/db`);
  });

  it("URL sem senha não muda", () => {
    expect(mask("GET https://example.com/a:b@c")).toBe("GET https://example.com/a:b@c");
    expect(mask("postgres://app@db/app")).toBe("postgres://app@db/app");
  });

  it("senha=valor, password: valor, JSON, token de API do painel", () => {
    expect(mask("password=abc123")).toBe(`password=${LOG_MASK}`);
    expect(mask('{"password":"abc 123","user":"x"}')).toBe(`{"password":"${LOG_MASK} 123","user":"x"}`);
    expect(mask("api_key: k-9f8e7d")).toBe(`api_key: ${LOG_MASK}`);
    expect(mask("usando tws_pat_AbCdEf-123_xyz agora")).toBe(`usando ${LOG_MASK} agora`);
  });

  it("texto comum não é tocado", () => {
    const line = "GET /health 200 3ms - token expirado para o usuário";
    expect(mask(line)).toBe(line);
  });

  it("DB_PASSWORD e POSTGRES_PASSWORD (prefixo com sublinhado) também", () => {
    expect(mask("DB_PASSWORD=hunter22")).toBe(`DB_PASSWORD=${LOG_MASK}`);
    expect(mask("POSTGRES_PASSWORD: hunter22")).toBe(`POSTGRES_PASSWORD: ${LOG_MASK}`);
    expect(mask("mypasswordless=ok")).toBe("mypasswordless=ok");
  });

  it("linha enorme é processada em tempo curto (sem regex catastrófica)", () => {
    const line = "a".repeat(LOG_LINE_MAX) + "://" + "b:".repeat(500);
    const t0 = Date.now();
    mask(line);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("cleanLogText", () => {
  it("tira cores ANSI e caracteres de controle, mantém tab", () => {
    expect(cleanLogText("\u001b[31mERRO\u001b[0m\tfalhou\u0007\u0000")).toBe("ERRO\tfalhou");
  });

  it("tira o \\r final", () => {
    expect(cleanLogText("linha\r")).toBe("linha");
  });

  it("a máscara vale ANTES do corte: segredo na fronteira não vaza o começo", () => {
    const secret = "SEGREDO-MUITO-LONGO-123";
    const line = "z".repeat(LOG_LINE_MAX - 5) + secret;
    const out = cleanLogText(line, buildLogMasker([secret]));
    expect(out).not.toContain("SEGRE");
    expect(out.startsWith("z".repeat(LOG_LINE_MAX - 5) + LOG_MASK.slice(0, 5))).toBe(true);
  });

  it("corta linha acima do limite com reticências", () => {
    const out = cleanLogText("x".repeat(LOG_LINE_MAX + 50));
    expect(out).toBe("x".repeat(LOG_LINE_MAX) + "…");
  });

  it("linha no limite exato não é cortada", () => {
    expect(cleanLogText("y".repeat(LOG_LINE_MAX))).toBe("y".repeat(LOG_LINE_MAX));
  });
});
