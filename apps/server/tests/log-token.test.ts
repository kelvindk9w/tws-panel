/**
 * log-token.test.ts — lote 7, M3: o setup token da URL não pode ir para o log.
 * A configuração testada é a MESMA que o app.ts usa (log-config.ts).
 */
import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions, scrubUrl } from "../src/log-config.js";
import terminalRoutes from "../src/routes/terminal.js";
import { buildAuthTestApp, closeAuthTestApp } from "./test-utils.js";

describe("log HTTP não registra o setup token", () => {
  it("requisição com ?token= : a linha de log não contém o segredo", async () => {
    const linhas: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        linhas.push(String(chunk));
        cb();
      },
    });
    const app = Fastify({ logger: { ...loggerOptions("info"), stream } });
    app.get("/api/terminal/ws", async () => ({ ok: true }));
    await app.inject({
      method: "GET",
      url: "/api/terminal/ws?clientId=aba-1&token=SEGREDO123",
      headers: { "x-setup-token": "SEGREDO456", cookie: "paas_session=SEGREDO789" },
    });
    await app.close();
    const todo = linhas.join("\n");
    expect(todo).toContain("/api/terminal/ws"); // o log continua útil
    expect(todo).toContain("clientId=aba-1");
    expect(todo).not.toContain("SEGREDO123");
    expect(todo).not.toContain("SEGREDO456");
    expect(todo).not.toContain("SEGREDO789");
  });
});

describe("scrubUrl", () => {
  it.each([
    ["/api/x", "/api/x"],
    ["/api/x?a=1", "/api/x?a=1"],
    ["/api/x?token=abc", "/api/x?token=[redacted]"],
    ["/api/x?a=1&token=abc&b=2", "/api/x?a=1&token=[redacted]&b=2"],
    ["/api/x?TOKEN=abc", "/api/x?TOKEN=[redacted]"],
    ["/api/x?%74oken=abc", "/api/x?%74oken=[redacted]"],
    ["/api/x?access_token=abc&password=p", "/api/x?access_token=[redacted]&password=[redacted]"],
    ["/api/x?semvalor&token", "/api/x?semvalor&token=[redacted]"],
    ["/api/x?%E0%A4%A=1", "/api/x?%E0%A4%A=1"],
  ])("%s", (entrada, esperado) => {
    expect(scrubUrl(entrada)).toBe(esperado);
  });
});

describe("pedido recusado por validação também não registra o token", () => {
  it("terminal: token válido + clientId inválido → o aviso do error handler não traz o segredo", async () => {
    const linhas: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        linhas.push(String(chunk));
        cb();
      },
    });
    const ctx = await buildAuthTestApp("SEGREDO-VALIDO", { logger: { ...loggerOptions("info"), stream } });
    try {
      await ctx.app.register(terminalRoutes);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/terminal/ws?token=SEGREDO-VALIDO&clientId=com%20espaco!",
      });
      expect(res.statusCode).toBe(400);
      const todo = linhas.join("\n");
      expect(todo).toContain("recusada por validação");
      expect(todo).not.toContain("SEGREDO-VALIDO");
    } finally {
      await closeAuthTestApp(ctx);
    }
  });
});

describe("log HTTP não registra token de API", () => {
  it("scrubUrl troca o token em qualquer parte do endereço e os parâmetros com cara de token", () => {
    const t = "tws_pat_" + "Ab-_".repeat(10);
    expect(scrubUrl(`/api/x?foo=${t}&bar=1`)).toBe("/api/x?foo=[redacted]&bar=1");
    expect(scrubUrl(`/api/${t}/y`)).toBe("/api/[redacted]/y");
    expect(scrubUrl(`/api/x?access_token=1&api_token=2&bearer=3&authorization=4&ok=5`)).toBe(
      "/api/x?access_token=[redacted]&api_token=[redacted]&bearer=[redacted]&authorization=[redacted]&ok=5",
    );
    expect(scrubUrl(`/api/x?v=${t.toUpperCase()}`)).not.toContain("AB-_");
  });

  it("o cabeçalho Authorization não vai para a linha de log", async () => {
    const linhas: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        linhas.push(String(chunk));
        cb();
      },
    });
    const app = Fastify({ logger: { ...loggerOptions("info"), stream } });
    app.get("/api/x", async (req) => {
      req.log.info({ req: { headers: req.headers } }, "dentro da rota");
      return { ok: true };
    });
    const t = "tws_pat_" + "Z".repeat(43);
    await app.inject({ method: "GET", url: `/api/x?q=${t}`, headers: { authorization: `Bearer ${t}` } });
    await app.close();
    expect(linhas.join("\n")).not.toContain(t);
  });
});
