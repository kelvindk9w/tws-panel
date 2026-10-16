/**
 * health-check.test.ts — etapa 5/5 do deploy: o site respondeu pelo proxy?
 *
 * Achado 12 da revisão: com domínio real, o Caddy responde 308 (HTTP→HTTPS)
 * na porta 80 sem tocar no backend, e a fase HTTP passava sempre; na fase
 * HTTPS, um 502/503 do backend (a página "temporariamente indisponível")
 * era tratado como certificado pendente e o deploy terminava "concluído".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpGet, httpsGet, isHttpsRedirect, waitHealthy, type Probe, type ProbeResult } from "../src/health-check.js";

const DOMAIN = "loja.exemplo.test";
const REDIRECT: ProbeResult = { ok: true, status: 308, location: `https://${DOMAIN}/` };
const TLS_PENDING: ProbeResult = { ok: false, error: "tlsv1 alert internal error" };

/** Relógio falso: cada `sleep` avança o tempo, sem esperar de verdade. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** Sonda que devolve as respostas em ordem (a última se repete). */
function seq(...results: ProbeResult[]): Probe & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    return results[Math.min(fn.calls - 1, results.length - 1)]!;
  }) as Probe & { calls: number };
  fn.calls = 0;
  return fn;
}

function run(probeHttp: Probe, probeHttps: Probe, domain = DOMAIN) {
  const log: string[] = [];
  const c = clock();
  const done = waitHealthy({
    host: "paas-caddy",
    httpPort: 80,
    httpsPort: 443,
    domain,
    onLog: (s) => log.push(s),
    probeHttp,
    probeHttps,
    ...c,
  });
  return { done, log };
}

describe("waitHealthy — o backend precisa responder", () => {
  it("HTTP 200 e HTTPS 200: passa e diz que o site está no ar", async () => {
    const { done, log } = run(seq({ ok: true, status: 200 }), seq({ ok: true, status: 200 }));
    await done;
    expect(log.join("")).toMatch(/HTTPS pronto/);
  });

  it("domínio .localhost: só a fase HTTP (não há HTTPS)", async () => {
    const https = seq({ ok: true, status: 200 });
    const { done } = run(seq({ ok: true, status: 200 }), https, "loja.localhost");
    await done;
    expect(https.calls).toBe(0);
  });

  it("HTTP sem resposta até o prazo: falha com o último erro", async () => {
    const { done, log } = run(seq({ ok: false, error: "connect ECONNREFUSED" }), seq({ ok: true, status: 200 }));
    await expect(done).rejects.toThrow(/health check falhou após 60s \(connect ECONNREFUSED\)/);
    expect(log.join("")).toMatch(/Última resposta/);
  });

  it("HTTP 503 até o prazo: falha (a página 'indisponível' do Caddy não é saúde)", async () => {
    const { done } = run(seq({ ok: false, status: 503 }), seq({ ok: true, status: 200 }));
    await expect(done).rejects.toThrow(/HTTP 503/);
  });

  it("redirecionamento HTTP→HTTPS do Caddy + backend 502 pelo HTTPS: o deploy FALHA", async () => {
    const { done, log } = run(seq(REDIRECT), seq({ ok: false, status: 502 }));
    await expect(done).rejects.toThrow(/HTTP 502/);
    expect(log.join("")).not.toMatch(/certificado HTTPS ainda não ficou pronto/);
  });

  it("redirecionamento do Caddy não é anunciado como 'o site responde'", async () => {
    const { done, log } = run(seq(REDIRECT), seq({ ok: true, status: 200 }));
    await done;
    expect(log.join("")).not.toMatch(/Health check OK — o proxy responde/);
    expect(log.join("")).toMatch(/HTTPS pronto/);
  });

  it("backend responde com certificado válido depois de um 502 passageiro: passa", async () => {
    const { done, log } = run(seq(REDIRECT), seq({ ok: false, status: 502 }, { ok: true, status: 200 }));
    await done;
    expect(log.join("")).toMatch(/HTTPS pronto/);
  });

  it("app confirmado pelo HTTP e certificado ainda não saiu: só avisa (DNS propagando)", async () => {
    const { done, log } = run(seq({ ok: true, status: 200 }), seq(TLS_PENDING));
    await done;
    expect(log.join("")).toMatch(/O site responde, mas o certificado HTTPS ainda não ficou pronto/);
  });

  it("só o redirecionamento e o certificado não saiu: avisa que o app NÃO foi confirmado", async () => {
    const { done, log } = run(seq(REDIRECT), seq(TLS_PENDING));
    await done;
    const text = log.join("");
    expect(text).not.toMatch(/O site responde/);
    expect(text).toMatch(/não deu para confirmar que a aplicação responde/);
  });

  it("certificado válido e resposta 4xx na raiz: o backend respondeu — avisa sem falhar", async () => {
    const { done, log } = run(seq(REDIRECT), seq({ ok: false, status: 404 }));
    await done;
    expect(log.join("")).toMatch(/respondeu HTTP 404/);
  });

  // Qualquer status abaixo de 500 é o app respondendo (a raiz pode exigir
  // login, pedir outro método, etc.): avisa, sem reprovar e sem esperar o prazo.
  it("HTTP 404/401 direto do app (domínio local): passa com aviso na primeira resposta", async () => {
    const http = seq({ ok: false, status: 401 });
    const { done, log } = run(http, seq(), "loja.localhost");
    await done;
    expect(http.calls).toBe(1);
    expect(log.join("")).toMatch(/respondeu HTTP 401/);
  });

  it("HTTP 4xx direto do app e depois HTTPS 200: passa", async () => {
    const http = seq({ ok: false, status: 404 });
    const https = seq({ ok: true, status: 200 });
    const { done, log } = run(http, https);
    await done;
    expect(http.calls).toBe(1);
    expect(log.join("")).toMatch(/HTTPS pronto/);
  });

  it("HTTPS 4xx na raiz: avisa na primeira resposta, sem esperar os 90 s", async () => {
    const https = seq({ ok: false, status: 403 });
    const { done, log } = run(seq(REDIRECT), https);
    await done;
    expect(https.calls).toBe(1);
    expect(log.join("")).toMatch(/respondeu HTTP 403/);
  });

  it("HTTPS 502 seguido de 404: continua tentando e termina no aviso", async () => {
    const https = seq({ ok: false, status: 502 }, { ok: false, status: 404 });
    const { done, log } = run(seq(REDIRECT), https);
    await done;
    expect(https.calls).toBe(2);
    expect(log.join("")).toMatch(/respondeu HTTP 404/);
  });

  it("HTTP 5xx continua reprovando", async () => {
    const { done } = run(seq({ ok: false, status: 500 }), seq());
    await expect(done).rejects.toThrow(/HTTP 500/);
  });

  it("redirecionamento do próprio app para outro endereço HTTPS conta como resposta do app", async () => {
    const { done, log } = run(
      seq({ ok: true, status: 302, location: "https://login.outro.test/" }),
      seq(TLS_PENDING),
    );
    await done;
    expect(log.join("")).toMatch(/O site responde, mas o certificado/);
  });
});

describe("isHttpsRedirect — o redirecionamento do Caddy, não o app", () => {
  it("3xx para o HTTPS do mesmo host (sem diferença de maiúsculas): é o redirecionamento do proxy", () => {
    expect(isHttpsRedirect({ ok: true, status: 308, location: "https://LOJA.exemplo.test/" }, DOMAIN)).toBe(true);
  });
  it("3xx para HTTP, para outro host, sem Location ou com Location relativo: é o app", () => {
    expect(isHttpsRedirect({ ok: true, status: 302, location: `http://${DOMAIN}/x` }, DOMAIN)).toBe(false);
    expect(isHttpsRedirect({ ok: true, status: 302, location: "https://outro.test/" }, DOMAIN)).toBe(false);
    expect(isHttpsRedirect({ ok: true, status: 302 }, DOMAIN)).toBe(false);
    expect(isHttpsRedirect({ ok: true, status: 302, location: "/login" }, DOMAIN)).toBe(false);
  });
  it("não-3xx ou sem status: não é redirecionamento", () => {
    expect(isHttpsRedirect({ ok: true, status: 200, location: `https://${DOMAIN}/` }, DOMAIN)).toBe(false);
    expect(isHttpsRedirect({ ok: false, error: "timeout" }, DOMAIN)).toBe(false);
  });
});

describe("sondas HTTP e HTTPS de verdade", () => {
  let plain: http.Server;
  let plainPort: number;
  let secure: https.Server;
  let securePort: number;
  let cert: string;

  beforeAll(async () => {
    plain = http.createServer((req, res) => {
      if (req.headers.host === "redir.test") {
        res.writeHead(308, { Location: "https://redir.test/" });
        res.end();
      } else if (req.headers.host === "lento.test") {
        // nunca responde: a sonda desiste pelo timeout
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    plainPort = (plain.address() as { port: number }).port;

    const dir = mkdtempSync(path.join(tmpdir(), "paas-health-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
        "-subj", `/CN=${DOMAIN}`, "-addext", `subjectAltName=DNS:${DOMAIN}`,
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(path.join(dir, "cert.pem"), "utf8");
    secure = https.createServer({ key: readFileSync(path.join(dir, "key.pem")), cert }, (_req, res) => {
      res.writeHead(502);
      res.end();
    });
    await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
    securePort = (secure.address() as { port: number }).port;
  });
  afterAll(() => {
    plain.closeAllConnections();
    plain.close();
    secure.close();
  });

  it("HTTP 200: ok, sem Location", async () => {
    expect(await httpGet("127.0.0.1", plainPort, "app.test")).toEqual({ ok: true, status: 200 });
  });

  it("HTTP 308 com Location: devolve o destino", async () => {
    expect(await httpGet("127.0.0.1", plainPort, "redir.test")).toEqual({
      ok: true,
      status: 308,
      location: "https://redir.test/",
    });
  });

  it("HTTP sem resposta: timeout", async () => {
    expect(await httpGet("127.0.0.1", plainPort, "lento.test", 100)).toEqual({ ok: false, error: "timeout" });
  });

  it("conexão recusada: erro", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const r = await httpGet("127.0.0.1", port, "app.test");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("HTTPS com certificado válido e backend 502: status, sem erro de TLS", async () => {
    expect(await httpsGet("127.0.0.1", securePort, DOMAIN, 5_000, cert)).toEqual({ ok: false, status: 502 });
  });

  it("HTTPS com certificado que não é de autoridade confiável: erro de TLS", async () => {
    const r = await httpsGet("127.0.0.1", securePort, DOMAIN);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/self.signed/i);
  });
});
