/**
 * Rotas da página Certificados: validação de schema na borda HTTP, limite
 * de frequência do "Tentar emitir agora", recusa clara do par manual e a
 * chave privada nunca na resposta.
 *
 * Serviço real com dependências dublês (sem Docker); certificados gerados
 * com o openssl na hora.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type Project } from "@paas/core";
import certificatesRoutes from "../src/routes/certificates.js";
import { CertificateService, type CertificateDeps } from "../src/services/certificate-service.js";
import { ManualCertificateStore } from "../src/services/certificate-store.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let pemDir = "";
const pem: Record<string, { cert: string; key: string }> = {};
function issue(name: string, san: string): void {
  const key = path.join(pemDir, `${name}.chave`);
  const cert = path.join(pemDir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", "365",
      "-subj", "/O=Empresa Exemplo CA/CN=teste", "-addext", `subjectAltName=${san}`,
    ],
    { stdio: "ignore" },
  );
  pem[name] = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

beforeAll(() => {
  pemDir = mkdtempSync(path.join(tmpdir(), "paas-cert-routes-pem-"));
  issue("loja", "DNS:loja.exemplo.com.br");
  issue("outro", "DNS:outro.exemplo.net");
});
afterAll(() => rmSync(pemDir, { recursive: true, force: true }));

let ctx: AuthTestContext;
let app: FastifyInstance;
let deps: { [K in keyof CertificateDeps]-?: ReturnType<typeof vi.fn> };
let now = 0;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  now = Date.now() + 5_000;
  deps = {
    listProjects: vi.fn(async () => [{ id: "p1", name: "Loja", domain: "loja.exemplo.com.br", aliases: [] } as unknown as Project]),
    panelDomain: vi.fn(() => "painel.exemplo.com.br"),
    mailHosts: vi.fn(async () => ["mail.exemplo.com.br"]),
    proxyRunning: vi.fn(async () => true),
    servedCertificate: vi.fn(async () => ({ ok: false, issuer: null, validTo: null, error: "tlsv1 alert internal error" })),
    caddyLogs: vi.fn(async () => ""),
    refreshProxy: vi.fn(async () => undefined),
    removeManualFiles: vi.fn(async () => undefined),
    syncMailTls: vi.fn(async () => undefined),
    resolve4: vi.fn(async () => []),
  };
  const service = new CertificateService(new ManualCertificateStore(ctx.dir), deps as unknown as CertificateDeps, {
    audit: ctx.auditService,
    now: () => now,
  });
  await app.register(certificatesRoutes, { service });
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("GET /api/certificates", () => {
  it("lista com dono, modo e estado", async () => {
    const res = await app.inject({ method: "GET", url: "/api/certificates", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proxyRunning).toBe(true);
    expect(body.items.map((i: { host: string }) => i.host)).toEqual([
      "painel.exemplo.com.br",
      "loja.exemplo.com.br",
      "mail.exemplo.com.br",
    ]);
    expect(body.items[0]).toMatchObject({ mode: "automatic", state: "issuing", canRetry: true });
  });

  it("filtros válidos e inválidos", async () => {
    const mail = await app.inject({ method: "GET", url: "/api/certificates?kind=mail", headers: auth });
    expect(mail.json().items).toHaveLength(1);
    const bad = await app.inject({ method: "GET", url: "/api/certificates?kind=outro", headers: auth });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: "GET", url: "/api/certificates?x=1", headers: auth });
    expect(extra.statusCode).toBe(400);
  });

  it("sem autenticação: recusa", async () => {
    const res = await app.inject({ method: "GET", url: "/api/certificates" });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("POST /api/certificates/:host/retry", () => {
  it("202 e depois 429 com o tempo restante (1 por minuto por nome)", async () => {
    const first = await app.inject({ method: "POST", url: "/api/certificates/loja.exemplo.com.br/retry", headers: auth });
    expect(first.statusCode).toBe(202);
    expect(deps.refreshProxy).toHaveBeenCalledWith({ force: true });
    now += 10_000;
    const second = await app.inject({ method: "POST", url: "/api/certificates/loja.exemplo.com.br/retry", headers: auth });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "retry_too_soon", retryAfterSeconds: 50 });
  });

  it("nome fora do formato: 400 já na borda; nome desconhecido: 404", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/certificates/a%20b;rm/retry", headers: auth });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: "POST", url: "/api/certificates/nada.exemplo.com.br/retry", headers: auth });
    expect(unknown.statusCode).toBe(404);
  });

  it("certificado já válido: 409 explicando que não precisa", async () => {
    deps.servedCertificate.mockResolvedValue({ ok: true, issuer: "Let's Encrypt", validTo: new Date(now + 80 * 86400_000).toISOString(), error: null });
    const res = await app.inject({ method: "POST", url: "/api/certificates/loja.exemplo.com.br/retry", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_valid");
    expect(res.json().message).toMatch(/Não é preciso/);
  });
});

describe("PUT/DELETE /api/certificates/:host/manual", () => {
  it("instala: 200 com o item no modo manual e SEM a chave", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/certificates/loja.exemplo.com.br/manual",
      headers: auth,
      payload: { certificate: pem.loja!.cert, privateKey: pem.loja!.key },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ host: "loja.exemplo.com.br", mode: "manual" });
    expect(res.body).not.toContain("PRIVATE KEY");
    expect(res.body).not.toContain(pem.loja!.key.split("\n")[1]!);
  });

  it("par que não serve: 400 com o motivo e sem ecoar a chave", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/certificates/loja.exemplo.com.br/manual",
      headers: auth,
      payload: { certificate: pem.loja!.cert, privateKey: pem.outro!.key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("key_mismatch");
    expect(res.body).not.toContain(pem.outro!.key.split("\n")[1]!);
  });

  it("schema: campos obrigatórios, nada além deles e tamanho máximo", async () => {
    const url = "/api/certificates/loja.exemplo.com.br/manual";
    const semChave = await app.inject({ method: "PUT", url, headers: auth, payload: { certificate: pem.loja!.cert } });
    expect(semChave.statusCode).toBe(400);
    const extra = await app.inject({
      method: "PUT",
      url,
      headers: auth,
      payload: { certificate: pem.loja!.cert, privateKey: pem.loja!.key, host: "outro" },
    });
    expect(extra.statusCode).toBe(400);
    const enorme = await app.inject({
      method: "PUT",
      url,
      headers: auth,
      payload: { certificate: "x".repeat(70_000), privateKey: pem.loja!.key },
    });
    expect(enorme.statusCode).toBe(400);
    // a resposta de validação não ecoa o conteúdo enviado
    expect(semChave.body).not.toContain("BEGIN CERTIFICATE");
  });

  it("voltar para automático: 200; sem manual: 404", async () => {
    const url = "/api/certificates/loja.exemplo.com.br/manual";
    await app.inject({ method: "PUT", url, headers: auth, payload: { certificate: pem.loja!.cert, privateKey: pem.loja!.key } });
    const del = await app.inject({ method: "DELETE", url, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(del.json().item.mode).toBe("automatic");
    const again = await app.inject({ method: "DELETE", url, headers: auth });
    expect(again.statusCode).toBe(404);
  });
});
