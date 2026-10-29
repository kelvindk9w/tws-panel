/**
 * access.ts do core: leitura de chave pública SSH (tipo, tamanho RSA), regra de chave nova,
 * senha do Linux e código por e-mail.
 */
import { describe, expect, it } from "vitest";
import { checkNewSshPublicKey, isEmailCodeAction, linuxPasswordErrors, looksLikeEmailCode, parseSshPublicKey } from "../src/access";
import { ed25519Line, rsaLine } from "./ssh-fixture";

describe("parseSshPublicKey", () => {
  it("lê ed25519 com e sem comentário", () => {
    const line = ed25519Line("notebook 2026");
    const key = parseSshPublicKey(line)!;
    expect(key.type).toBe("ssh-ed25519");
    expect(key.comment).toBe("notebook 2026");
    expect(key.bits).toBeNull();
    expect(parseSshPublicKey(ed25519Line())!.comment).toBe("");
  });

  it("mede o tamanho de uma chave RSA", () => {
    expect(parseSshPublicKey(rsaLine(2048))!.bits).toBe(2048);
    expect(parseSshPublicKey(rsaLine(3072, "a@b"))!.bits).toBe(3072);
  });

  it("recusa opções na frente, tipo errado, blob que não bate com o tipo e lixo", () => {
    const line = ed25519Line();
    expect(parseSshPublicKey(`command="rm -rf /" ${line}`)).toBeNull();
    expect(parseSshPublicKey("")).toBeNull();
    expect(parseSshPublicKey("ssh-dss AAAA")).toBeNull();
    // blob de ed25519 declarado como ecdsa
    expect(parseSshPublicKey(line.replace("ssh-ed25519", "ecdsa-sha2-nistp256"))).toBeNull();
    // base64 que não carrega o nome do tipo
    expect(parseSshPublicKey(`ssh-ed25519 ${"A".repeat(68)}`)).toBeNull();
    expect(parseSshPublicKey(`${line}'; rm -rf / #`)).toBeNull();
    // blob cujo nome interno do tipo difere do declarado (mesmo tamanho)
    const swapped = Buffer.from(line.split(" ")[1]!, "base64");
    swapped.write("ssh-ed25518", 4);
    expect(parseSshPublicKey(`ssh-ed25519 ${swapped.toString("base64")}`)).toBeNull();
    // base64 com tamanho impossível (resto 1)
    expect(parseSshPublicKey(`ssh-ed25519 ${"A".repeat(45)}`)).toBeNull();
  });

  it("recusa blob RSA com módulo inconsistente", () => {
    const bytes = Buffer.from(rsaLine(2048).split(" ")[1]!, "base64");
    const blobOf = (b: Buffer) => `ssh-rsa ${b.toString("base64")}`;
    // blob cortado antes do módulo (e antes do expoente)
    expect(parseSshPublicKey(blobOf(bytes.subarray(0, 40)))).toBeNull();
    expect(parseSshPublicKey(blobOf(bytes.subarray(0, 12)))).toBeNull();
    // módulo só de zeros
    const zeros = Buffer.concat([bytes.subarray(0, bytes.length - 257), Buffer.alloc(257)]);
    expect(parseSshPublicKey(blobOf(zeros))).toBeNull();
    // comprimento do expoente absurdo
    const badE = Buffer.from(bytes);
    badE.writeUInt32BE(9999, 4 + 7);
    expect(parseSshPublicKey(blobOf(badE))).toBeNull();
    // comprimento do módulo maior do que o que sobrou no blob
    const badN = Buffer.from(bytes);
    badN.writeUInt32BE(9999, bytes.length - 257 - 4);
    expect(parseSshPublicKey(blobOf(badN))).toBeNull();
  });
});

describe("checkNewSshPublicKey", () => {
  it("aceita ed25519 e RSA de 3072 bits", () => {
    expect(checkNewSshPublicKey(ed25519Line("x")).ok).toBe(true);
    expect(checkNewSshPublicKey(rsaLine(3072)).ok).toBe(true);
  });

  it("recusa RSA fraca e linha inválida com motivo em português", () => {
    const weak = checkNewSshPublicKey(rsaLine(2048));
    expect(weak).toMatchObject({ ok: false });
    expect((weak as { reason: string }).reason).toMatch(/2048 bits/);
    const bad = checkNewSshPublicKey("qualquer coisa");
    expect((bad as { reason: string }).reason).toMatch(/Chave pública inválida/);
  });
});

describe("linuxPasswordErrors / looksLikeEmailCode", () => {
  it("exige 12 a 128 caracteres e uma linha só", () => {
    expect(linuxPasswordErrors("curta")).toEqual(["pelo menos 12 caracteres"]);
    expect(linuxPasswordErrors("x".repeat(129))).toEqual(["no máximo 128 caracteres"]);
    expect(linuxPasswordErrors("uma senha longa boa\ncom quebra")).toEqual(["sem quebras de linha"]);
    expect(linuxPasswordErrors("uma senha longa boa")).toEqual([]);
  });

  it("código por e-mail são 6 dígitos, com espaços tolerados", () => {
    expect(looksLikeEmailCode("123456")).toBe(true);
    expect(looksLikeEmailCode("123 456")).toBe(true);
    expect(looksLikeEmailCode("12345")).toBe(false);
    expect(looksLikeEmailCode("abcdef")).toBe(false);
  });
});

describe("comentário da chave", () => {
  it("recusa NUL e caracteres de controle e aceita letras acentuadas", () => {
    for (const bad of ["a\u0000b", "a\u001b[2Jb", "a\tb", "a\u007fb"]) {
      expect(parseSshPublicKey(ed25519Line(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(parseSshPublicKey(ed25519Line("notebook do João"))!.comment).toBe("notebook do João");
  });
});

describe("ações do código por e-mail", () => {
  it("só as ações conhecidas", () => {
    expect(isEmailCodeAction("access.keys")).toBe(true);
    expect(isEmailCodeAction("toString")).toBe(false);
    expect(isEmailCodeAction(5)).toBe(false);
  });
});
