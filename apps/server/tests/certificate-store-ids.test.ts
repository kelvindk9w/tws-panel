/**
 * certificate-store-ids.test.ts — um par de arquivos por domínio no painel.
 *
 * Achado 7 da revisão: <dataDir>/certificates/<id>.crt/.key usava a regra
 * que troca ponto e hífen pela mesma coisa; a-b.exemplo.com e
 * a.b-exemplo.com gravavam no mesmo arquivo e o segundo apagava o primeiro.
 *
 * Migração: o que já está gravado com o nome antigo passa para o nome novo
 * na primeira leitura — conferindo a impressão digital do índice, para que
 * um arquivo antigo que ficou com o certificado de OUTRO domínio (a colisão)
 * não seja entregue com o nome errado.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InspectedCertificate } from "@paas/mailer";
import { ManualCertificateStore } from "../src/services/certificate-store.js";

let pemDir = "";
const pem: Record<string, { cert: string; key: string }> = {};

function issue(host: string): void {
  const key = path.join(pemDir, `${host}.chave`);
  const cert = path.join(pemDir, `${host}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", "30",
      "-subj", "/O=Empresa Exemplo CA/CN=teste", "-addext", `subjectAltName=DNS:${host}`,
    ],
    { stdio: "ignore" },
  );
  pem[host] = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

function inspected(host: string): InspectedCertificate {
  const x = new X509Certificate(pem[host]!.cert);
  return {
    host,
    cert: pem[host]!.cert,
    key: pem[host]!.key,
    fingerprint: x.fingerprint256,
    issuer: "Empresa Exemplo CA",
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    names: [host],
  };
}

beforeAll(() => {
  pemDir = mkdtempSync(path.join(tmpdir(), "paas-cert-ids-pem-"));
  issue("a-b.exemplo.com");
  issue("a.b-exemplo.com");
  issue("loja.exemplo.com");
  issue("a.b.exemplo.com");
});
afterAll(() => rmSync(pemDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-cert-ids-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const certsDir = () => path.join(dataDir, "certificates");

describe("ManualCertificateStore — domínios parecidos não dividem arquivos", () => {
  it("instala a-b.exemplo.com e a.b-exemplo.com: cada um continua com o seu par", async () => {
    const store = new ManualCertificateStore(dataDir);
    await store.install("a-b.exemplo.com", inspected("a-b.exemplo.com"), "2026-10-16T00:00:00.000Z");
    await store.install("a.b-exemplo.com", inspected("a.b-exemplo.com"), "2026-10-16T00:00:00.000Z");
    const pairs = await store.pairs();
    expect(pairs.find((p) => p.host === "a-b.exemplo.com")?.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    expect(pairs.find((p) => p.host === "a.b-exemplo.com")?.cert).toBe(pem["a.b-exemplo.com"]!.cert);
    expect((await store.forHost("a-b.exemplo.com"))?.cert).toBe(pem["a-b.exemplo.com"]!.cert);
  });

  it("remover um não apaga o par do outro", async () => {
    const store = new ManualCertificateStore(dataDir);
    await store.install("a-b.exemplo.com", inspected("a-b.exemplo.com"), "2026-10-16T00:00:00.000Z");
    await store.install("a.b-exemplo.com", inspected("a.b-exemplo.com"), "2026-10-16T00:00:00.000Z");
    expect(await store.remove("a.b-exemplo.com")).toBe(true);
    expect((await store.pairs()).map((p) => p.host)).toEqual(["a-b.exemplo.com"]);
  });
});

describe("ManualCertificateStore — migração dos arquivos com o nome antigo", () => {
  async function legacy(hosts: string[], fileHost: Record<string, string>): Promise<void> {
    await mkdir(certsDir(), { recursive: true, mode: 0o700 });
    const metas = hosts.map((h) => {
      const i = inspected(h);
      return { host: h, issuer: i.issuer, validFrom: i.validFrom, validTo: i.validTo, names: i.names, fingerprint: i.fingerprint, installedAt: "2026-10-01T00:00:00.000Z" };
    });
    await writeFile(path.join(certsDir(), "manual.json"), JSON.stringify({ certificates: metas }), { mode: 0o600 });
    for (const [legacyId, host] of Object.entries(fileHost)) {
      await writeFile(path.join(certsDir(), `${legacyId}.crt`), pem[host]!.cert, { mode: 0o600 });
      await writeFile(path.join(certsDir(), `${legacyId}.key`), pem[host]!.key, { mode: 0o600 });
    }
  }

  it("par gravado com o nome antigo continua valendo e passa para o nome novo", async () => {
    await legacy(["a-b.exemplo.com"], { "a-b-exemplo-com": "a-b.exemplo.com" });
    const store = new ManualCertificateStore(dataDir);
    const pairs = await store.pairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    expect(existsSync(path.join(certsDir(), "a--b-exemplo-com.crt"))).toBe(true);
    expect(existsSync(path.join(certsDir(), "a--b-exemplo-com.key"))).toBe(true);
    expect(existsSync(path.join(certsDir(), "a-b-exemplo-com.crt"))).toBe(false);
  });

  it("colisão antiga: o arquivo comum é do último instalado — só ele herda; o outro fica sem par (não recebe o certificado errado)", async () => {
    // a.b-exemplo.com foi instalado por último e sobrescreveu a-b-exemplo-com.*
    await legacy(["a-b.exemplo.com", "a.b-exemplo.com"], { "a-b-exemplo-com": "a.b-exemplo.com" });
    const store = new ManualCertificateStore(dataDir);
    const pairs = await store.pairs();
    expect(pairs.map((p) => p.host)).toEqual(["a.b-exemplo.com"]);
    expect(pairs[0]!.cert).toBe(pem["a.b-exemplo.com"]!.cert);
    expect(await store.forHost("a-b.exemplo.com")).toBeNull();
  });

  it("remover antes de migrar: o par antigo do host sai junto; o de outro host fica", async () => {
    await legacy(["a-b.exemplo.com", "a.b-exemplo.com"], { "a-b-exemplo-com": "a.b-exemplo.com" });
    const store = new ManualCertificateStore(dataDir);
    expect(await store.remove("a-b.exemplo.com")).toBe(true);
    // o arquivo antigo é do a.b-exemplo.com: continua lá
    expect(existsSync(path.join(certsDir(), "a-b-exemplo-com.crt"))).toBe(true);
    expect(await store.remove("a.b-exemplo.com")).toBe(true);
    expect(existsSync(path.join(certsDir(), "a-b-exemplo-com.crt"))).toBe(false);
    expect(existsSync(path.join(certsDir(), "a-b-exemplo-com.key"))).toBe(false);
  });

  it("duas leituras ao mesmo tempo migram uma vez só", async () => {
    await legacy(["a-b.exemplo.com"], { "a-b-exemplo-com": "a-b.exemplo.com" });
    const store = new ManualCertificateStore(dataDir);
    const [x, y] = await Promise.all([store.pairs(), store.pairs()]);
    expect(x[0]!.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    expect(y[0]!.cert).toBe(pem["a-b.exemplo.com"]!.cert);
  });

  // O id NOVO de a.b.exemplo.com (sem hífen) é igual ao id ANTIGO de
  // a-b.exemplo.com: enquanto o par antigo não for migrado, o arquivo
  // a-b-exemplo-com.* é do a-b, e o a.b não pode servi-lo.
  describe("id novo de um nome sem hífen = id antigo de um nome com hífen", () => {
    const BOTH = ["a-b.exemplo.com", "a.b.exemplo.com"];

    it("o nome sem hífen não serve o certificado do outro; o do hífen migra e mantém o seu", async () => {
      await legacy(BOTH, { "a-b-exemplo-com": "a-b.exemplo.com" });
      const store = new ManualCertificateStore(dataDir);
      const pairs = await store.pairs();
      expect(pairs.map((p) => p.host)).toEqual(["a-b.exemplo.com"]);
      expect(pairs[0]!.cert).toBe(pem["a-b.exemplo.com"]!.cert);
      expect(await store.forHost("a.b.exemplo.com")).toBeNull();
      expect((await store.forHost("a-b.exemplo.com"))?.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    });

    it("lendo o nome sem hífen primeiro, nada muda de lugar e o outro ainda migra depois", async () => {
      await legacy(BOTH, { "a-b-exemplo-com": "a-b.exemplo.com" });
      const store = new ManualCertificateStore(dataDir);
      expect(await store.forHost("a.b.exemplo.com")).toBeNull();
      expect((await store.forHost("a-b.exemplo.com"))?.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    });

    it("remover o nome sem hífen antes da migração não apaga o arquivo do outro", async () => {
      await legacy(BOTH, { "a-b-exemplo-com": "a-b.exemplo.com" });
      const store = new ManualCertificateStore(dataDir);
      expect(await store.remove("a.b.exemplo.com")).toBe(true);
      expect((await store.pairs())[0]!.cert).toBe(pem["a-b.exemplo.com"]!.cert);
    });

    it("instalar o nome sem hífen antes da migração não sobrescreve o arquivo do outro", async () => {
      await legacy(["a-b.exemplo.com"], { "a-b-exemplo-com": "a-b.exemplo.com" });
      const store = new ManualCertificateStore(dataDir);
      await store.install("a.b.exemplo.com", inspected("a.b.exemplo.com"), "2026-10-16T00:00:00.000Z");
      const pairs = await store.pairs();
      expect(pairs.find((p) => p.host === "a-b.exemplo.com")?.cert).toBe(pem["a-b.exemplo.com"]!.cert);
      expect(pairs.find((p) => p.host === "a.b.exemplo.com")?.cert).toBe(pem["a.b.exemplo.com"]!.cert);
    });

    it("o arquivo é mesmo do nome sem hífen (fingerprint bate): ele o usa normalmente", async () => {
      await legacy(["a.b.exemplo.com"], { "a-b-exemplo-com": "a.b.exemplo.com" });
      const store = new ManualCertificateStore(dataDir);
      expect((await store.pairs())[0]!.cert).toBe(pem["a.b.exemplo.com"]!.cert);
    });
  });

  it("nome sem hífen: o id não mudou, nada é mexido", async () => {
    await legacy(["loja.exemplo.com"], { "loja-exemplo-com": "loja.exemplo.com" });
    const store = new ManualCertificateStore(dataDir);
    expect((await store.pairs())[0]!.cert).toBe(pem["loja.exemplo.com"]!.cert);
    expect(existsSync(path.join(certsDir(), "loja-exemplo-com.crt"))).toBe(true);
  });

  it("arquivo antigo ilegível ou que não é certificado: o host fica sem par", async () => {
    await legacy(["a-b.exemplo.com"], {});
    await writeFile(path.join(certsDir(), "a-b-exemplo-com.crt"), "lixo", { mode: 0o600 });
    await writeFile(path.join(certsDir(), "a-b-exemplo-com.key"), "lixo", { mode: 0o600 });
    const store = new ManualCertificateStore(dataDir);
    expect(await store.pairs()).toEqual([]);
  });
});
