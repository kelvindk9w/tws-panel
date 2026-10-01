/**
 * tls-certificates.ts — certificado de verdade para mail.<domínio>.
 *
 * Validação real (01/10/2026): o Stalwart rodava com certificado autoassinado
 * e o projeto conectava em `paas-stalwart:587`. App que confere o certificado
 * (nodemailer com requireTLS e verificação padrão, caso do cassino) recusava:
 * o emissor não é confiável e o nome nunca bate. Agora o Caddy central emite o
 * certificado de mail.<domínio> e o painel o copia para o Stalwart. Aqui: a
 * leitura do certificado no volume do Caddy e as checagens que impedem de
 * instalar um par que o cliente recusaria (nome errado, vencido, chave de
 * outro certificado).
 *
 * Os certificados de teste são gerados com o openssl na hora (nada de chave
 * privada versionada no repositório).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let responder: (args: string[]) => Result = () => ({ code: 1, stdout: "", stderr: "" });

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return responder(args);
  }),
}));

const {
  CADDY_CERTIFICATES_DIR,
  certificateId,
  mailHostFor,
  pickNewest,
  readCaddyCertificate,
  validateCertificatePair,
} = await import("../src/tls-certificates.js");

let dir = "";
const pem: Record<string, { cert: string; key: string }> = {};

/** Certificado EC (como o Caddy emite) para `host`, válido por `days` dias. */
function issue(name: string, host: string, days: number, subj = `/O=CA de Teste/CN=${host}`): void {
  const key = path.join(dir, `${name}.chave`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", String(days),
      "-subj", subj, "-addext", `subjectAltName=DNS:${host}`,
    ],
    { stdio: "ignore" },
  );
  pem[name] = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "paas-mail-tls-"));
  issue("curto", "mail.exemplo.com", 20);
  issue("longo", "mail.exemplo.com", 80);
  issue("outro", "mail.outro.com", 30);
  issue("soCn", "mail.exemplo.com", 30, "/CN=Emissor Sem Organizacao");
  issue("semNome", "mail.exemplo.com", 30, "/C=BR");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
});

describe("nomes", () => {
  it("o servidor de e-mail de um domínio é mail.<domínio>", () => {
    expect(mailHostFor("exemplo.com.br")).toBe("mail.exemplo.com.br");
  });

  it("id do certificado no config do Stalwart: só letras, números e hífen", () => {
    expect(certificateId("mail.exemplo.com.br")).toBe("mail-exemplo-com-br");
  });
});

describe("validateCertificatePair", () => {
  it("par certo: devolve emissor, validade e impressão digital", () => {
    const c = validateCertificatePair("mail.exemplo.com", pem.curto!.cert, pem.curto!.key);
    expect(c).not.toBeNull();
    expect(c!.host).toBe("mail.exemplo.com");
    expect(c!.issuer).toBe("CA de Teste");
    expect(new Date(c!.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(c!.fingerprint).toMatch(/^[0-9A-F:]+$/);
    expect(c!.cert).toBe(pem.curto!.cert);
    expect(c!.key).toBe(pem.curto!.key);
  });

  it("emissor sem organização: usa o nome (CN); sem nenhum dos dois: null", () => {
    expect(validateCertificatePair("mail.exemplo.com", pem.soCn!.cert, pem.soCn!.key)?.issuer).toBe("Emissor Sem Organizacao");
    expect(validateCertificatePair("mail.exemplo.com", pem.semNome!.cert, pem.semNome!.key)?.issuer).toBeNull();
  });

  it("nome diferente: recusa (o cliente recusaria do mesmo jeito)", () => {
    expect(validateCertificatePair("mail.exemplo.com", pem.outro!.cert, pem.outro!.key)).toBeNull();
  });

  it("vencido: recusa", () => {
    const daqui100Dias = new Date(Date.now() + 100 * 86_400_000);
    expect(validateCertificatePair("mail.exemplo.com", pem.curto!.cert, pem.curto!.key, daqui100Dias)).toBeNull();
  });

  it("chave de outro certificado: recusa (o Stalwart não teria como fechar o TLS)", () => {
    expect(validateCertificatePair("mail.exemplo.com", pem.curto!.cert, pem.longo!.key)).toBeNull();
  });

  it("conteúdo que não é certificado: recusa sem lançar", () => {
    expect(validateCertificatePair("mail.exemplo.com", "lixo", "lixo")).toBeNull();
  });
});

describe("pickNewest", () => {
  it("fica com o que vence por último; lista vazia = nenhum", () => {
    const a = validateCertificatePair("mail.exemplo.com", pem.curto!.cert, pem.curto!.key)!;
    const b = validateCertificatePair("mail.exemplo.com", pem.longo!.cert, pem.longo!.key)!;
    expect(pickNewest([a, b])).toBe(b);
    expect(pickNewest([b, a])).toBe(b);
    expect(pickNewest([])).toBeNull();
  });
});

describe("readCaddyCertificate", () => {
  const LE = `${CADDY_CERTIFICATES_DIR}/acme-v02.api.letsencrypt.org-directory/mail.exemplo.com/mail.exemplo.com`;
  const ZERO = `${CADDY_CERTIFICATES_DIR}/acme.zerossl.com-v2-dv90/mail.exemplo.com/mail.exemplo.com`;

  function caddy(files: Record<string, string>, found = Object.keys(files).filter((f) => f.endsWith(".crt"))) {
    return (args: string[]): Result => {
      if (args.includes("find")) return { code: 0, stdout: found.join("\n") + "\n", stderr: "" };
      const file = args[args.length - 1]!;
      return file in files ? { code: 0, stdout: files[file]!, stderr: "" } : { code: 1, stdout: "", stderr: "No such file" };
    };
  }

  it("procura em qualquer emissor do Caddy (Let's Encrypt ou ZeroSSL) e fica com o mais novo", async () => {
    responder = caddy({
      [`${LE}.crt`]: pem.curto!.cert,
      [`${LE}.key`]: pem.curto!.key,
      [`${ZERO}.crt`]: pem.longo!.cert,
      [`${ZERO}.key`]: pem.longo!.key,
    });
    const c = await readCaddyCertificate("mail.exemplo.com");
    expect(c?.cert).toBe(pem.longo!.cert);
    // argumentos separados, nunca shell: o nome vai como argumento do find
    expect(calls[0]).toEqual([
      "exec", "paas-caddy", "find", CADDY_CERTIFICATES_DIR, "-type", "f", "-name", "mail.exemplo.com.crt",
    ]);
  });

  it("container do Caddy configurável", async () => {
    responder = caddy({ [`${LE}.crt`]: pem.curto!.cert, [`${LE}.key`]: pem.curto!.key });
    await readCaddyCertificate("mail.exemplo.com", { caddyContainer: "outro-caddy" });
    expect(calls[0]?.[1]).toBe("outro-caddy");
  });

  it("ainda não emitido (find vazio ou Caddy fora do ar): null", async () => {
    responder = caddy({}, []);
    expect(await readCaddyCertificate("mail.exemplo.com")).toBeNull();
    responder = () => ({ code: 1, stdout: "", stderr: "No such container: paas-caddy" });
    expect(await readCaddyCertificate("mail.exemplo.com")).toBeNull();
  });

  it("arquivo da chave ausente ou par inválido: ignora aquele emissor", async () => {
    responder = caddy({ [`${LE}.crt`]: pem.curto!.cert });
    expect(await readCaddyCertificate("mail.exemplo.com")).toBeNull();
    responder = caddy({ [`${LE}.crt`]: pem.curto!.cert, [`${LE}.key`]: pem.longo!.key });
    expect(await readCaddyCertificate("mail.exemplo.com")).toBeNull();
  });

  it("caminho devolvido fora da pasta de certificados é ignorado", async () => {
    responder = caddy({ "/etc/passwd.crt": pem.curto!.cert, "/etc/passwd.key": pem.curto!.key }, ["/etc/passwd.crt"]);
    expect(await readCaddyCertificate("mail.exemplo.com")).toBeNull();
  });

  it("nome fora do formato de hostname: nem consulta o Caddy", async () => {
    responder = caddy({});
    expect(await readCaddyCertificate("mail.exemplo.com -o -name *")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
