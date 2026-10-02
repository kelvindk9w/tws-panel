/**
 * inspectCertificatePair — conferência do certificado MANUAL (página
 * Certificados): mesma regra de validateCertificatePair (nome certo, dentro
 * da validade, chave que pertence ao certificado), mas dizendo o MOTIVO da
 * recusa para a pessoa corrigir. Wildcard que cubra o nome é aceito.
 *
 * Certificados gerados com o openssl na hora (nada de chave versionada).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectCertificatePair, validateCertificatePair } from "../src/tls-certificates.js";

let dir = "";
const pem: Record<string, { cert: string; key: string }> = {};

function issue(name: string, san: string, days: number, extra: string[] = []): void {
  const key = path.join(dir, `${name}.chave`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", String(days),
      "-subj", "/O=CA de Teste/CN=teste", "-addext", `subjectAltName=${san}`, ...extra,
    ],
    { stdio: "ignore" },
  );
  pem[name] = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "paas-cert-pair-"));
  issue("site", "DNS:loja.exemplo.com.br", 90);
  issue("curinga", "DNS:*.exemplo.com.br,DNS:exemplo.com.br", 365);
  issue("outro", "DNS:outro.exemplo.net", 90);
  // chave protegida por senha (comum em certificado comprado)
  const enc = path.join(dir, "cifrada.chave");
  execFileSync("openssl", [
    "pkcs8", "-topk8", "-in", path.join(dir, "site.chave"), "-out", enc, "-passout", "pass:segredo-de-teste",
  ]);
  pem.cifrada = { cert: pem.site!.cert, key: readFileSync(enc, "utf8") };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("inspectCertificatePair", () => {
  it("par certo: ok, com emissor, validade, nomes cobertos e impressão digital", () => {
    const r = inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.site!.key);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.certificate.issuer).toBe("CA de Teste");
    expect(r.certificate.names).toEqual(["loja.exemplo.com.br"]);
    expect(new Date(r.certificate.validFrom).getTime()).toBeLessThanOrEqual(Date.now());
    expect(r.certificate.fingerprint).toMatch(/^[0-9A-F:]+$/);
  });

  it("wildcard que cobre o nome é aceito; o domínio de dois níveis abaixo não", () => {
    expect(inspectCertificatePair("app.exemplo.com.br", pem.curinga!.cert, pem.curinga!.key).ok).toBe(true);
    const fundo = inspectCertificatePair("a.b.exemplo.com.br", pem.curinga!.cert, pem.curinga!.key);
    expect(fundo).toMatchObject({ ok: false, reason: "wrong_name" });
  });

  it("nome errado: diz quais nomes o certificado cobre", () => {
    const r = inspectCertificatePair("loja.exemplo.com.br", pem.outro!.cert, pem.outro!.key);
    expect(r).toMatchObject({ ok: false, reason: "wrong_name" });
    if (!r.ok) expect(r.message).toContain("outro.exemplo.net");
  });

  it("vencido / ainda não vale", () => {
    const depois = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    expect(inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.site!.key, depois)).toMatchObject({ ok: false, reason: "expired" });
    const antes = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    expect(inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.site!.key, antes)).toMatchObject({ ok: false, reason: "not_yet_valid" });
  });

  it("chave de outro certificado", () => {
    expect(inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.outro!.key)).toMatchObject({ ok: false, reason: "key_mismatch" });
  });

  it("chave protegida por senha: pede a chave sem senha", () => {
    const r = inspectCertificatePair("loja.exemplo.com.br", pem.cifrada!.cert, pem.cifrada!.key);
    expect(r).toMatchObject({ ok: false, reason: "encrypted_key" });
  });

  it("texto que não é certificado / chave que não é chave", () => {
    expect(inspectCertificatePair("loja.exemplo.com.br", "lixo", pem.site!.key)).toMatchObject({ ok: false, reason: "invalid_certificate" });
    expect(inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, "lixo")).toMatchObject({ ok: false, reason: "invalid_key" });
  });

  it("chave colada no campo do certificado: recusa e explica", () => {
    const r = inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert + pem.site!.key, pem.site!.key);
    expect(r).toMatchObject({ ok: false, reason: "invalid_certificate" });
    if (!r.ok) expect(r.message).toMatch(/chave/i);
  });

  it("a mensagem de recusa nunca repete a chave", () => {
    const r = inspectCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.outro!.key);
    if (!r.ok) expect(r.message).not.toContain(pem.outro!.key.slice(40, 80));
  });

  it("validateCertificatePair continua igual (null quando recusa) e aceita wildcard", () => {
    expect(validateCertificatePair("loja.exemplo.com.br", pem.site!.cert, pem.outro!.key)).toBeNull();
    expect(validateCertificatePair("app.exemplo.com.br", pem.curinga!.cert, pem.curinga!.key)?.host).toBe("app.exemplo.com.br");
  });
});
