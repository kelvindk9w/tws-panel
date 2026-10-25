/**
 * Certificados já emitidos, lidos do armazenamento do Caddy (sem handshake TLS,
 * que num nome sob demanda dispararia a emissão).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../src/exec.js", () => ({ run: runMock }));

import { CaddyManager } from "../src/caddy.js";
import { CADDY_CERTIFICATES_DIR, LIST_CERTIFICATES_SCRIPT, parseIssuedCertificates } from "../src/caddy-storage.js";

let curta = "";
let longa = "";
let semOrganizacao = "";

function gerar(dir: string, name: string, days: number, subj: string): string {
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", String(days), "-keyout", path.join(dir, `${name}.key`), "-out", path.join(dir, `${name}.pem`), "-subj", subj],
    { stdio: "ignore" },
  );
  return readFileSync(path.join(dir, `${name}.pem`), "utf8");
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "paas-storage-"));
  curta = gerar(dir, "curta", 10, "/CN=curta/O=Autoridade Teste");
  longa = gerar(dir, "longa", 80, "/CN=longa/O=Outra Autoridade");
  semOrganizacao = gerar(dir, "sem", 40, "/CN=so-o-cn");
});

const bloco = (issuerDir: string, host: string, pem: string) => `### ${CADDY_CERTIFICATES_DIR}/${issuerDir}/${host}/${host}.crt\n${pem}\n`;

describe("parseIssuedCertificates", () => {
  it("lê o nome, o emissor e a validade de cada certificado", () => {
    const out = parseIssuedCertificates(bloco("acme-v02.api.letsencrypt.org-directory", "app.cliente.example", curta));
    const item = out.get("app.cliente.example")!;
    expect(item).toMatchObject({ ok: true, issuer: "Autoridade Teste", error: null });
    const dias = (Date.parse(item.validTo!) - Date.parse(item.validFrom!)) / 86_400_000;
    expect(Math.round(dias)).toBe(10);
  });

  it("emissor sem organização usa o CN", () => {
    expect(parseIssuedCertificates(bloco("x", "a.example.com", semOrganizacao)).get("a.example.com")!.issuer).toBe("so-o-cn");
  });

  it("o mesmo nome em dois emissores fica com a validade mais longa, em qualquer ordem", () => {
    const a = parseIssuedCertificates(bloco("le", "a.example.com", curta) + bloco("zerossl", "a.example.com", longa));
    const b = parseIssuedCertificates(bloco("zerossl", "a.example.com", longa) + bloco("le", "a.example.com", curta));
    expect(a.get("a.example.com")!.issuer).toBe("Outra Autoridade");
    expect(b.get("a.example.com")!.issuer).toBe("Outra Autoridade");
  });

  it("ignora curinga, nome fora do formato, arquivo de outro nome, lixo e certificado ilegível", () => {
    const lixo = [
      bloco("le", "wildcard_.example.com", curta),
      bloco("le", "sem-ponto", curta),
      bloco("le", "MAIÚSCULA.example.com", curta),
      `### ${CADDY_CERTIFICATES_DIR}/le/a.example.com/outro.crt\n${curta}\n`,
      `### ${CADDY_CERTIFICATES_DIR}/le/b.example.com/b.example.com.crt\nnão é certificado\n`,
      `### ${CADDY_CERTIFICATES_DIR}/le/c.example.com/c.example.com.crt\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`,
      `### ${CADDY_CERTIFICATES_DIR}/le/d.example.com/d.example.com.crt`,
      "texto antes do primeiro marcador\n",
    ].join("");
    expect(parseIssuedCertificates(lixo).size).toBe(0);
    expect(parseIssuedCertificates("").size).toBe(0);
  });

  it("vários nomes na mesma saída", () => {
    const out = parseIssuedCertificates(bloco("le", "a.example.com", curta) + bloco("le", "b.example.com", longa));
    expect([...out.keys()].sort()).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("CaddyManager.issuedCertificates", () => {
  beforeEach(() => runMock.mockReset());

  it("roda o script no container e devolve o que leu", async () => {
    runMock.mockResolvedValue({ code: 0, stdout: bloco("le", "a.example.com", curta), stderr: "" });
    const out = await new CaddyManager("/tmp/x").issuedCertificates();
    expect(out!.has("a.example.com")).toBe(true);
    expect(runMock).toHaveBeenCalledWith("docker", ["exec", "paas-caddy", "sh", "-c", LIST_CERTIFICATES_SCRIPT], { timeoutMs: 30_000 });
  });

  it("container parado ou leitura que falha: null (não sei), nunca lista vazia", async () => {
    runMock.mockResolvedValue({ code: 1, stdout: "", stderr: "No such container" });
    expect(await new CaddyManager("/tmp/x").issuedCertificates()).toBeNull();
  });

  it("o script só lista arquivos .crt do armazenamento do Caddy e nunca escreve", () => {
    expect(LIST_CERTIFICATES_SCRIPT).toContain(`${CADDY_CERTIFICATES_DIR}/*/*/*.crt`);
    expect(LIST_CERTIFICATES_SCRIPT).not.toMatch(/>\s*\//);
  });
});
