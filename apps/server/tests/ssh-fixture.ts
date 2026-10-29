/**
 * ssh-fixture.ts — chaves públicas SSH REAIS para os testes (geradas na hora; nada versionado como segredo).
 */
import { generateKeyPairSync } from "node:crypto";

function str(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function mpint(buf: Buffer): Buffer {
  const trimmed = buf[0] === 0 ? buf.subarray(1) : buf;
  return str(trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export function ed25519Line(comment = ""): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const blob = Buffer.concat([str(Buffer.from("ssh-ed25519")), str(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}

export function rsaLine(bits: number, comment = ""): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([
    str(Buffer.from("ssh-rsa")),
    mpint(Buffer.from(jwk.e as string, "base64url")),
    mpint(Buffer.from(jwk.n as string, "base64url")),
  ]);
  return `ssh-rsa ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}
