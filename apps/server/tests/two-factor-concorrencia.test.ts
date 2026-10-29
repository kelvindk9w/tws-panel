/**
 * two-factor-concorrencia.test.ts — uso único do código da verificação em
 * duas etapas sob concorrência real (achado 5 da revisão).
 *
 * O UserStore e o TwoFactorService são os de verdade, gravando numa pasta
 * temporária; as verificações saem juntas, com Promise.all, e o relógio é o
 * do sistema. Antes da correção, verify() lia o usuário fora da fila do
 * UserStore: duas verificações em paralelo aceitavam o mesmo código, e duas
 * com códigos de recuperação diferentes devolviam à lista um código já usado.
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { TwoFactorService } from "../src/services/two-factor.js";
import { UserStore, type StoredUser } from "../src/services/user-store.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
let users: UserStore;
let tf: TwoFactorService;
let user: StoredUser;
let secret: string;
let recovery: string[];

function codigoAgora(): string {
  return totpCode(secret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-2fa-race-"));
  users = new UserStore(dir);
  tf = new TwoFactorService(dir, users);
  const criado = await users.create("admin", "hash");
  ({ secret } = tf.beginSetup(criado));
  // o código da ativação ocupa um passo; o passo anterior não vale mais
  // depois dele, então o teste usa um código de outro passo da janela
  const passo = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  recovery = await tf.enable(criado, totpCode(secret, passo - 1));
  user = (await users.findById(criado.id))!;
});

afterEach(async () => {
  await removeDir(dir);
});

describe("verificação em duas etapas com pedidos em paralelo", () => {
  it("o mesmo código do app enviado duas vezes ao mesmo tempo só vale uma vez", async () => {
    const code = codigoAgora();
    const resultados = await Promise.all([tf.verify(user, code), tf.verify(user, code), tf.verify(user, code)]);
    expect(resultados.filter((r) => r?.method === "totp")).toHaveLength(1);
  });

  it("o mesmo código de recuperação enviado duas vezes ao mesmo tempo só vale uma vez", async () => {
    const resultados = await Promise.all([tf.verify(user, recovery[0]!), tf.verify(user, recovery[0]!)]);
    expect(resultados.filter((r) => r?.method === "recovery")).toHaveLength(1);
    const atual = (await new UserStore(dir).findById(user.id))!;
    expect(atual.twoFactor?.recoveryHashes).toHaveLength(9);
  });

  it("dois códigos de recuperação diferentes ao mesmo tempo: os dois são consumidos (nenhum volta a valer)", async () => {
    const resultados = await Promise.all([tf.verify(user, recovery[1]!), tf.verify(user, recovery[2]!)]);
    expect(resultados.every((r) => r?.method === "recovery")).toBe(true);
    const atual = (await new UserStore(dir).findById(user.id))!;
    expect(atual.twoFactor?.recoveryHashes).toHaveLength(8);
    // e o código já usado não entra de novo, nem com o usuário antigo em mãos
    expect(await tf.verify(user, recovery[1]!)).toBeNull();
  });

  it("verificação com o usuário antigo em mãos depois de desativar não aceita nada", async () => {
    await tf.disable(user);
    expect(await tf.verify(user, codigoAgora())).toBeNull();
    expect(await tf.verify(user, recovery[3]!)).toBeNull();
  });

  it("UserStore.updateTwoFactor: usuário inexistente devolve null; next null desativa; sem next não grava", async () => {
    expect(await users.updateTwoFactor("nao-existe", () => ({ result: 1 }))).toBeNull();
    const antes = await readFile(path.join(dir, "users.json"), "utf8");
    expect(await users.updateTwoFactor(user.id, (tf) => ({ result: tf?.recoveryHashes.length }))).toBe(10);
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe(antes);
    expect(await users.updateTwoFactor(user.id, () => ({ result: "ok", next: null }))).toBe("ok");
    expect((await new UserStore(dir).findById(user.id))?.twoFactor).toBeNull();
  });

  it("primeiro uso em paralelo gera UMA chave de cifra (a segunda ativação continua legível)", async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), "paas-2fa-key-"));
    try {
      const store = new UserStore(dir2);
      const servico = new TwoFactorService(dir2, store);
      const u = await store.create("outro", "hash");
      const { secret: s } = servico.beginSetup(u);
      const passo = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
      // enable() e uma verificação de outro usuário-fantasma disputam a criação da chave
      const fantasma = { ...u, id: "fantasma", twoFactor: { iv: "", tag: "", data: "", lastStep: null, recoveryHashes: [], enabledAt: "" } };
      await Promise.all([servico.enable(u, totpCode(s, passo - 1)), servico.verify(fantasma, "000000").catch(() => null)]);
      const relido = new TwoFactorService(dir2, new UserStore(dir2));
      const salvo = (await new UserStore(dir2).findById(u.id))!;
      expect(await relido.verify(salvo, totpCode(s, passo))).toMatchObject({ method: "totp" });
      expect((await readdir(dir2)).filter((n) => n.startsWith("two-factor-key"))).toEqual(["two-factor-key"]);
      expect((await readFile(path.join(dir2, "two-factor-key"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await removeDir(dir2);
    }
  });
});
