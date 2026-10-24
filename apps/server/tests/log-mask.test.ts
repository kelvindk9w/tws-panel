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

  it("palavra comum em maiúsculas (PRODUCTION) também é trivial", () => {
    const mask = buildLogMasker(["PRODUCTION", "LocalHost"]);
    expect(mask("env PRODUCTION em LocalHost")).toBe("env PRODUCTION em LocalHost");
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

describe("buildLogMasker: padrões ampliados (Cookie, sessão, JWT, chaves, JSON, formulário)", () => {
  const mask = buildLogMasker([]);

  it("Cookie e Set-Cookie: o valor inteiro some até o fim da linha", () => {
    expect(mask("Cookie: sid=abc123; theme=dark")).toBe(`Cookie: ${LOG_MASK}`);
    expect(mask("set-cookie: token=xyz; Path=/; HttpOnly")).toBe(`set-cookie: ${LOG_MASK}`);
  });

  it("session=, sessionid=, PHPSESSID=, JSESSIONID=", () => {
    expect(mask("GET /x?session=abcdef12&a=1")).toBe(`GET /x?session=${LOG_MASK}&a=1`);
    expect(mask("sessionid=ab12cd34")).toBe(`sessionid=${LOG_MASK}`);
    expect(mask("PHPSESSID=ab12cd34; x=1")).toBe(`PHPSESSID=${LOG_MASK}; x=1`);
    expect(mask("jsessionid=ab12cd34")).toBe(`jsessionid=${LOG_MASK}`);
    expect(mask("sessions=3")).toBe("sessions=3");
  });

  it("JWT (três partes base64url começando em eyJ)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(mask(`user token ${jwt} ok`)).toBe(`user token ${LOG_MASK} ok`);
    expect(mask("eyJ sem pontos")).toBe("eyJ sem pontos");
  });

  it("secret_key=, secret-key:, api_key, access_key, private_key", () => {
    expect(mask("secret_key=abcd1234")).toBe(`secret_key=${LOG_MASK}`);
    expect(mask("AWS_SECRET_KEY: abcd1234")).toBe(`AWS_SECRET_KEY: ${LOG_MASK}`);
    expect(mask("secret-key = abcd1234")).toBe(`secret-key = ${LOG_MASK}`);
  });

  it("JSON dentro de texto (aspas escapadas)", () => {
    expect(mask('msg="{\\"password\\":\\"abc12345\\",\\"u\\":1}"')).toBe(`msg="{\\"password\\":\\"${LOG_MASK}\\",\\"u\\":1}"`);
  });

  it("valor com aspas ou barra: a forma escapada de JSON também é mascarada", () => {
    const m = buildLogMasker(['se"gre\\do-123']);
    expect(m('{"k":"se\\"gre\\\\do-123"}')).toBe(`{"k":"${LOG_MASK}"}`);
  });

  it("forma de formulário (espaço vira +) do valor também é mascarada", () => {
    const m = buildLogMasker(["minha senha longa"]);
    expect(m("body=minha+senha+longa&x=1")).toBe(`body=${LOG_MASK}&x=1`);
  });
});

describe("buildLogMasker: desempenho com entradas patológicas (nenhum padrão pode ser quadrático)", () => {
  const SIZE = 16 * 1024;
  const hostile: Array<[string, string]> = [
    ["esquema longo sem ://", "a.".repeat(SIZE / 2)],
    ["esquemas colados", "a://".repeat(SIZE / 4)],
    ["esquema e usuário sem arroba", "a://:".repeat(SIZE / 5)],
    ["://", "x".repeat(SIZE - 4) + "://:"],
    ["bearer com espaços", "bearer " + " ".repeat(SIZE)],
    ["bearer repetido", "bearer ".repeat(SIZE / 7)],
    ["authorization com espaços", "authorization" + " ".repeat(SIZE)],
    ["authorization repetido", "authorization: ".repeat(SIZE / 15)],
    ["password com espaços", "password" + " ".repeat(SIZE)],
    ["password repetido", "password ".repeat(SIZE / 9)],
    ["token= longo", "token=" + "a".repeat(SIZE)],
    ["token: e espaços", "token:" + " ".repeat(SIZE)],
    ["cookie com espaços", "cookie" + " ".repeat(SIZE)],
    ["cookie repetido", "cookie: ".repeat(SIZE / 8)],
    ["session= repetido", "session=".repeat(SIZE / 8)],
    ["jwt sem pontos", "eyJ" + "a".repeat(SIZE)],
    ["jwt repetido", "eyJaaaaaa.".repeat(SIZE / 10)],
    ["tws_pat_ repetido", "tws_pat_".repeat(SIZE / 8)],
    ["aspas escapadas", '\\"password\\":'.repeat(SIZE / 14)],
    ["letras e pontos alternados", "a.b-c+d".repeat(SIZE / 7)],
  ];
  const secrets = Array.from({ length: 200 }, (_v, i) => `valor-secreto-numero-${i}-xyz`);

  for (const [name, input] of hostile) {
    it(`200 linhas de 16 KiB: ${name}`, () => {
      const mask = buildLogMasker(secrets);
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) mask(input);
      expect(performance.now() - t0).toBeLessThan(2500);
    });
  }

  it("a máscara continua mascarando postgres/redis com a correção de desempenho", () => {
    const m = buildLogMasker([]);
    expect(m("a.b.c postgres://app:S3nh4@db:5432/x")).toBe(`a.b.c postgres://app:${LOG_MASK}@db:5432/x`);
    expect(m(" redis+tls://:pw@cache")).toBe(` redis+tls://:${LOG_MASK}@cache`);
  });
});
