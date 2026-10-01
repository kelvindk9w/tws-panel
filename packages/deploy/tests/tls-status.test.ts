/**
 * tls-status.test.ts — estado do certificado HTTPS de um domínio, para a
 * Visão geral do projeto (antes só o log do deploy dizia se o HTTPS ficou
 * pronto). Servidor TLS local com certificado gerado pelo openssl.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { certificateStatus } from "../src/tls-status.js";

let server: tls.Server;
let port: number;
let cert: string;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paas-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    "-subj", "/CN=loja.exemplo.test/O=Autoridade Teste", "-addext", "subjectAltName=DNS:loja.exemplo.test",
  ], { stdio: "ignore" });
  cert = readFileSync(path.join(dir, "cert.pem"), "utf8");
  server = tls.createServer({ key: readFileSync(path.join(dir, "key.pem")), cert }, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
});

describe("certificateStatus", () => {
  it("certificado válido para o domínio: ok, emissor e validade", async () => {
    const r = await certificateStatus({ host: "127.0.0.1", port, servername: "loja.exemplo.test", ca: cert });
    expect(r.ok).toBe(true);
    expect(r.issuer).toBe("Autoridade Teste");
    expect(new Date(r.validTo!).getTime()).toBeGreaterThan(Date.now());
    expect(r.error).toBeNull();
  });

  it("certificado que não é de uma autoridade confiável: não ok, com o motivo", async () => {
    const r = await certificateStatus({ host: "127.0.0.1", port, servername: "loja.exemplo.test" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/self.signed/i);
  });

  it("nome que o certificado não cobre: não ok", async () => {
    const r = await certificateStatus({ host: "127.0.0.1", port, servername: "outro.exemplo.test", ca: cert });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outro\.exemplo\.test|altname|does not match/i);
  });

  it("ninguém escutando: não ok, sem travar", async () => {
    const r = await certificateStatus({ host: "127.0.0.1", port: 1, servername: "x.test", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
