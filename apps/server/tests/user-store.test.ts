/**
 * Testes do UserStore (user-store.ts): unicidade do admin, busca
 * case-insensitive, atualização de senha e tolerância a arquivo corrompido —
 * com arquivos reais em diretório temporário.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserStore } from "../src/services/user-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-users-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("UserStore", () => {
  it("arquivo ausente → sem admin; create persiste com modo 0600", async () => {
    const store = new UserStore(dir);
    expect(await store.hasAdmin()).toBe(false);

    const user = await store.create("Admin", "$argon2id$hash");
    expect(user.usernameLower).toBe("admin");
    expect(await store.hasAdmin()).toBe(true);

    const file = path.join(dir, "users.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // reload do zero: o usuário sobrevive ao "boot"
    const fresh = new UserStore(dir);
    expect(await fresh.hasAdmin()).toBe(true);
    expect((await fresh.findById(user.id))?.username).toBe("Admin");
  });

  it("segunda conta → erro admin_exists (unicidade mesmo na corrida)", async () => {
    const store = new UserStore(dir);
    await store.create("admin", "$argon2id$hash");
    await expect(store.create("outro", "$argon2id$hash2")).rejects.toThrow("admin_exists");
    // e o arquivo continua com exatamente um usuário
    const onDisk = JSON.parse(await readFile(path.join(dir, "users.json"), "utf8"));
    expect(onDisk.users).toHaveLength(1);
  });

  it("busca por username é case-insensitive; ids desconhecidos → null", async () => {
    const store = new UserStore(dir);
    await store.create("Kelvin", "$argon2id$hash");
    expect((await store.findByUsername("kelvin"))?.username).toBe("Kelvin");
    expect((await store.findByUsername("KELVIN"))?.username).toBe("Kelvin");
    expect(await store.findByUsername("ninguem")).toBeNull();
    expect(await store.findById("id-inexistente")).toBeNull();
  });

  it("updatePassword troca o hash, atualiza updatedAt e persiste", async () => {
    const store = new UserStore(dir);
    const user = await store.create("admin", "$argon2id$velho");
    const updated = await store.updatePassword(user.id, "$argon2id$novo");
    expect(updated?.passwordHash).toBe("$argon2id$novo");
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(user.updatedAt).getTime(),
    );
    // reload confirma a persistência
    const fresh = new UserStore(dir);
    expect((await fresh.findById(user.id))?.passwordHash).toBe("$argon2id$novo");
  });

  it("updatePassword de id inexistente → null sem gravar nada", async () => {
    const store = new UserStore(dir);
    await store.create("admin", "$argon2id$hash");
    expect(await store.updatePassword("nope", "$argon2id$novo")).toBeNull();
    const onDisk = JSON.parse(await readFile(path.join(dir, "users.json"), "utf8"));
    expect(onDisk.users[0].passwordHash).toBe("$argon2id$hash");
  });

  it("users.json corrompido ou sem array → store vazio sem lançar", async () => {
    await writeFile(path.join(dir, "users.json"), "{quebrado", "utf8");
    expect(await new UserStore(dir).hasAdmin()).toBe(false);

    await writeFile(path.join(dir, "users.json"), JSON.stringify({ users: "oops" }), "utf8");
    expect(await new UserStore(dir).hasAdmin()).toBe(false);
  });
});

describe("UserStore — falha de gravação", () => {
  const arquivo = () => path.join(dir, "users.json");

  it("create que não chega ao disco REJEITA e não deixa admin em memória; a tentativa seguinte funciona", async () => {
    const store = new UserStore(dir);
    // users.json vira diretório: a escrita falha com EISDIR
    await mkdir(arquivo());
    await expect(store.create("admin", "$argon2id$hash-1")).rejects.toMatchObject({
      code: "storage_write_failed",
    });
    expect(await store.hasAdmin()).toBe(false);
    expect(await store.findByUsername("admin")).toBeNull();

    // a cadeia de gravações continua saudável: com o disco de volta, grava
    await rm(arquivo(), { recursive: true });
    const user = await store.create("admin", "$argon2id$hash-1");
    const onDisk = JSON.parse(await readFile(arquivo(), "utf8"));
    expect(onDisk.users.map((u: { id: string }) => u.id)).toEqual([user.id]);
  });

  it("a mensagem do erro não vaza caminho nem código do sistema de arquivos", async () => {
    const store = new UserStore(dir);
    await mkdir(arquivo());
    const err = (await store.create("admin", "h").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(dir);
    expect(err.message).not.toMatch(/EISDIR/);
  });

  it("updatePassword que falha REJEITA: a senha antiga continua em memória e após recarregar do disco", async () => {
    const store = new UserStore(dir);
    const user = await store.create("admin", "$argon2id$hash-1");
    const conteudoAntes = await readFile(arquivo(), "utf8");

    await rm(arquivo());
    await mkdir(arquivo());
    await expect(store.updatePassword(user.id, "$argon2id$hash-2")).rejects.toMatchObject({
      code: "storage_write_failed",
    });
    expect((await store.findById(user.id))?.passwordHash).toBe("$argon2id$hash-1");
    // o objeto devolvido antes não foi mutado por baixo
    expect(user.passwordHash).toBe("$argon2id$hash-1");

    // "reinício": o disco tem o conteúdo de antes da tentativa
    await rm(arquivo(), { recursive: true });
    await writeFile(arquivo(), conteudoAntes, { mode: 0o600 });
    expect((await new UserStore(dir).findById(user.id))?.passwordHash).toBe("$argon2id$hash-1");

    // e a gravação seguinte, no mesmo processo, persiste normalmente
    await store.updatePassword(user.id, "$argon2id$hash-3");
    const onDisk = JSON.parse(await readFile(arquivo(), "utf8"));
    expect(onDisk.users[0].passwordHash).toBe("$argon2id$hash-3");
  });
});
