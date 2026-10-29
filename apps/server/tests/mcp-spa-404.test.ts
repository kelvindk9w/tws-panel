/**
 * mcp-spa-404.test.ts — com o build do frontend presente (produção e CI), o /mcp desligado e as rotas /api
 * inexistentes continuam sendo 404 de verdade: o fallback da SPA nunca serve o index.html para elas.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { isApiOrMcpPath } from "../src/app.js";

let dist = "";
let panel: RealPanel;
let saved: string | undefined;

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), "paas-web-dist-"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>painel</title>");
  saved = process.env.WEB_DIST;
  process.env.WEB_DIST = dist;
  panel = await startRealPanel();
}, 120_000);
afterAll(async () => {
  await panel.close();
  if (saved === undefined) delete process.env.WEB_DIST;
  else process.env.WEB_DIST = saved;
  await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("fallback da SPA com o frontend compilado", () => {
  it("uma página da tela recebe o index.html (é o que acontece em produção)", async () => {
    for (const url of ["/", "/projetos/abc", "/mcpx", "/mcp-docs"]) {
      const res = await panel.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain("<title>painel</title>");
    }
  });

  it("/mcp e /mcp/* desligado: 404 em qualquer método, igual ao de uma rota inexistente, sem index.html", async () => {
    const referencia = await panel.app.inject({ method: "POST", url: "/rota-que-nao-existe", payload: {} });
    expect(referencia.statusCode).toBe(404);
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
      for (const url of ["/mcp", "/mcp/", "/mcp/qualquer", "/mcp?x=1", "//mcp", "/MCP", "/%6dcp"]) {
        const res = await panel.app.inject({ method, url, ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }) });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body, `${method} ${url}`).not.toContain("<title>");
        expect(res.body, `${method} ${url}`).toBe(referencia.body);
      }
    }
  });

  it("/api inexistente (GET) também é 404 de verdade, e a API continua funcionando", async () => {
    for (const url of ["/api", "/api/", "/api/nada", "/api/nada?x=1", "//api/nada"]) {
      const res = await panel.app.inject({ method: "GET", url, headers: { cookie: panel.cookie } });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("<title>");
    }
    expect((await panel.app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
  });

  it("isApiOrMcpPath reconhece só /api e /mcp (com ou sem subcaminho, query, barras duplas ou %)", () => {
    for (const url of ["/api", "/api/x", "/mcp", "/mcp/x", "/mcp?a=b", "//mcp", "/%6dcp", "/MCP", "/api#x", "/mcp/%E0%A4%A"]) {
      expect(isApiOrMcpPath(url), url).toBe(true);
    }
    for (const url of ["/", "/mcpx", "/apiary", "/painel/mcp", "/projetos"]) expect(isApiOrMcpPath(url), url).toBe(false);
  });
});
