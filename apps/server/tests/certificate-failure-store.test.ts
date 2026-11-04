/**
 * Início da falha de emissão por nome (certificate-failure-store.ts): guarda
 * o instante mais antigo, zera, esquece nomes que sumiram e ignora lixo no arquivo.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CertificateFailureStore } from "../src/services/certificate-failure-store.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
const file = () => path.join(dir, "certificates", "failure-since.json");
const A = "a.exemplo.com.br";
const B = "b.exemplo.com.br";
const T1 = "2027-03-01T00:00:00.000Z";
const T2 = "2027-03-02T00:00:00.000Z";
const T3 = "2027-03-03T00:00:00.000Z";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cert-since-"));
});
afterEach(async () => {
  await removeDir(dir);
});

describe("CertificateFailureStore", () => {
  it("guarda o instante mais antigo: o do log, o já guardado ou agora (nessa ordem de preferência por antiguidade)", async () => {
    const s = new CertificateFailureStore(dir);
    expect(await s.record(A, null, T2)).toBe(T2);
    expect(await s.record(A, T3, T3)).toBe(T2);
    expect(await s.record(A, T1, T3)).toBe(T1);
    expect(await s.record(B, T3, T2)).toBe(T3);
  });

  it("sobrevive a outra instância (reinício) e o arquivo é 0600", async () => {
    await new CertificateFailureStore(dir).record(A, T1, T2);
    expect(await new CertificateFailureStore(dir).record(A, null, T3)).toBe(T1);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it("clear esquece um nome (e não faz nada se ele não está lá); prune esquece quem não está na lista", async () => {
    const s = new CertificateFailureStore(dir);
    await s.record(A, T1, T1);
    await s.record(B, T1, T1);
    await s.clear("c.exemplo.com.br");
    await s.clear(A);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ [B]: T1 });
    await s.prune(new Set([B]));
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ [B]: T1 });
    await s.prune(new Set());
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({});
  });

  it("entradas inválidas no arquivo são ignoradas; arquivo que não é um objeto é tratado como vazio", async () => {
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), JSON.stringify({ [A]: "não é data", "nome inválido": T1, [B]: T1 }));
    const s = new CertificateFailureStore(dir);
    expect(await s.record(A, null, T3)).toBe(T3);
    expect(await s.record(B, null, T3)).toBe(T1);
    // nome fora do formato de domínio não volta do arquivo nem pela leitura
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ [A]: T3, [B]: T1 });
    await writeFile(file(), JSON.stringify([1, 2]));
    expect(await new CertificateFailureStore(dir).record(A, null, T2)).toBe(T2);
  });
});
