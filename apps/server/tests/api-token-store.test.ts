/**
 * api-token-store.test.ts — o cadastro de tokens de API: só o hash no disco
 * (0600, gravação atômica), validade com relógio congelado, revogação,
 * limite de ativos, arquivo ruim/ausente e falha de disco (falha fechada).
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_MAX_ACTIVE, API_TOKEN_PATTERN, API_TOKEN_PREFIX } from "@paas/core";
import { ApiTokenStore, tokenStatus } from "../src/services/api-token-store.js";

let dir: string;
let store: ApiTokenStore;
const logs: string[] = [];
const file = () => path.join(dir, "api-tokens.json");
const NOW = Date.parse("2026-10-22T12:00:00Z");
const hours = (n: number) => n * 3_600_000;

/** Põe um ARQUIVO no lugar da pasta de dados: toda gravação passa a falhar. */
async function breakDisk() {
  await store.flush();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await writeFile(dir, "no lugar da pasta");
}
async function fixDisk() {
  await rm(dir, { force: true });
  await mkdir(dir, { recursive: true });
}

async function make(name = "claude", ttlHours = 24, scope: "read" | "write" | "admin" = "read") {
  return store.create({ name, scope, ttlHours, userId: "u1" });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tokens-"));
  logs.length = 0;
  store = new ApiTokenStore(dir, (m) => logs.push(m));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await store.flush();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("criação e armazenamento", () => {
  it("o token tem prefixo e 256 bits; o arquivo guarda só o hash, com modo 0600", async () => {
    const { token, info } = await make("meu-assistente", 24, "write");
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(API_TOKEN_PATTERN.test(token)).toBe(true);
    // 43 caracteres base64url = 32 bytes = 256 bits
    expect(Buffer.from(token.slice(API_TOKEN_PREFIX.length), "base64url")).toHaveLength(32);

    const text = await readFile(file(), "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(API_TOKEN_PREFIX.length));
    const saved = JSON.parse(text).tokens[0];
    expect(saved.hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(saved).toMatchObject({ id: info.id, name: "meu-assistente", scope: "write", userId: "u1", lastUsedAt: null, revokedAt: null });
    expect(((await stat(file())).mode & 0o777).toString(8)).toBe("600");
    // gravação atômica: nenhum temporário sobra
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("dois tokens nunca são iguais", async () => {
    const a = await make("a");
    const b = await make("b");
    expect(a.token).not.toBe(b.token);
    expect(a.info.id).not.toBe(b.info.id);
  });

  it("a validade é a pedida (24 h) e o info nunca traz valor nem hash", async () => {
    const { info } = await make("x", 24);
    expect(info.createdAt).toBe(new Date(NOW).toISOString());
    expect(info.expiresAt).toBe(new Date(NOW + hours(24)).toISOString());
    expect(info.status).toBe("active");
    expect(JSON.stringify(await store.list())).not.toMatch(/hash|tws_pat_/);
  });

  it("limite de tokens ativos: o 21º é recusado; revogar um libera vaga", async () => {
    for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) await make(`t${i}`);
    await expect(make("extra")).rejects.toMatchObject({ code: "too_many_tokens", statusCode: 409 });
    const first = (await store.list()).at(-1)!;
    await store.revoke(first.id);
    await expect(make("extra")).resolves.toBeTruthy();
  });

  it("criações simultâneas não passam do limite", async () => {
    const results = await Promise.allSettled(Array.from({ length: API_TOKEN_MAX_ACTIVE + 8 }, (_, i) => make(`c${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(API_TOKEN_MAX_ACTIVE);
    expect((await store.list()).filter((t) => t.status === "active")).toHaveLength(API_TOKEN_MAX_ACTIVE);
    expect(JSON.parse(await readFile(file(), "utf8")).tokens).toHaveLength(API_TOKEN_MAX_ACTIVE);
  });

  it("nome repetido entre ativos é recusado (sem diferenciar maiúsculas); depois de revogado, pode reusar", async () => {
    const { info } = await make("Claude");
    await expect(make("claude")).rejects.toMatchObject({ code: "token_name_taken", statusCode: 409 });
    await store.revoke(info.id);
    await expect(make("claude")).resolves.toBeTruthy();
  });

  it("vencidos/revogados há mais de 90 dias saem do arquivo; os recentes ficam como histórico", async () => {
    const old = await make("velho", 1);
    const recent = await make("recente", 1);
    await store.revoke(recent.info.id);
    vi.setSystemTime(NOW + hours(24 * 89));
    await make("novo-1");
    expect((await store.list()).map((t) => t.name).sort()).toEqual(["novo-1", "recente", "velho"]);
    vi.setSystemTime(NOW + hours(24 * 100));
    await make("novo-2");
    const names = (await store.list()).map((t) => t.name);
    expect(names).toEqual(["novo-2", "novo-1"]);
    expect(old.info.name).toBe("velho");
  });
});

describe("resolve", () => {
  it("token certo vale; devolve escopo e dono", async () => {
    const { token, info } = await make("ok", 24, "admin");
    const found = await store.resolve(token);
    expect(found).toMatchObject({ id: info.id, scope: "admin", userId: "u1" });
  });

  it("formato errado, inexistente e adulterado dão o mesmo null", async () => {
    const { token } = await make();
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of ["", "abc", `${API_TOKEN_PREFIX}curto`, flipped, token + "x", token.toUpperCase(), `${API_TOKEN_PREFIX}${"A".repeat(43)}`]) {
      expect(await store.resolve(bad), bad).toBeNull();
    }
  });

  it("vence no instante da expiração (relógio congelado)", async () => {
    const { token } = await make("exp", 24);
    vi.setSystemTime(NOW + hours(24) - 1);
    expect(await store.resolve(token)).not.toBeNull();
    vi.setSystemTime(NOW + hours(24));
    expect(await store.resolve(token)).toBeNull();
    vi.setSystemTime(NOW + hours(24 * 400));
    expect(await store.resolve(token)).toBeNull();
    expect((await store.list())[0]!.status).toBe("expired");
  });

  it("revogado deixa de valer na hora e continua sem valer depois de recarregar do disco", async () => {
    const { token, info } = await make();
    expect(await store.revoke(info.id)).toMatchObject({ id: info.id, status: "revoked" });
    expect(await store.resolve(token)).toBeNull();
    const again = new ApiTokenStore(dir);
    expect(await again.resolve(token)).toBeNull();
    expect(await store.revoke(info.id)).toBeNull(); // já revogado
    expect(await store.revoke("0000000000000000")).toBeNull();
  });

  it("revogar durante o uso: o pedido que já resolveu termina, o seguinte é recusado", async () => {
    const { token, info } = await make();
    const first = await store.resolve(token);
    expect(first).not.toBeNull(); // o pedido em andamento já tem o registro e termina normalmente
    const revoking = store.revoke(info.id);
    const during = store.resolve(token); // chegou junto com a revogação: qualquer um dos dois resultados é válido...
    await revoking;
    await during;
    expect(await store.resolve(token)).toBeNull(); // ...mas depois que a revogação terminou, nunca mais
    expect(await store.resolve(token)).toBeNull();
  });

  it("revokeAll revoga só os ativos e devolve quantos", async () => {
    const a = await make("a");
    const b = await make("b");
    await store.revoke(b.info.id);
    expect(await store.revokeAll()).toBe(1);
    expect(await store.resolve(a.token)).toBeNull();
    expect(await store.revokeAll()).toBe(0);
  });

  it("o último uso é gravado no máximo uma vez por minuto", async () => {
    const { token } = await make();
    for (let i = 0; i < 20; i++) await store.resolve(token);
    await store.flush();
    const first = (await store.list())[0]!.lastUsedAt;
    expect(first).toBe(new Date(NOW).toISOString());
    const writes = async () => JSON.parse(await readFile(file(), "utf8")).tokens[0].lastUsedAt;
    expect(await writes()).toBe(first);

    vi.setSystemTime(NOW + 30_000);
    await store.resolve(token);
    await store.flush();
    expect(await writes()).toBe(first); // dentro do minuto: não regrava

    vi.setSystemTime(NOW + 61_000);
    await store.resolve(token);
    await store.flush();
    expect(await writes()).toBe(new Date(NOW + 61_000).toISOString());
  });
});

describe("arquivo ausente, corrompido ou ilegível (falha fechada)", () => {
  it("ausente: lista vazia e nenhum token vale", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.resolve(`${API_TOKEN_PREFIX}${"A".repeat(43)}`)).toBeNull();
  });

  it("JSON inválido: guardado à parte, lista vazia, token antigo não vale, painel segue", async () => {
    const { token } = await make();
    await store.flush();
    await writeFile(file(), "{ isto não é json");
    const fresh = new ApiTokenStore(dir, (m) => logs.push(m));
    expect(await fresh.resolve(token)).toBeNull();
    expect(await fresh.list()).toEqual([]);
    expect((await readdir(dir)).some((n) => n.startsWith("api-tokens.json.corrompido-"))).toBe(true);
    expect(logs.join("\n")).toContain("ilegível");
    expect((await fresh.create({ name: "novo", scope: "read", ttlHours: 1, userId: "u1" })).token).toBeTruthy();
  });

  it("registro malformado (escopo inventado, validade lixo, hash curto) invalida o arquivo inteiro", async () => {
    const good = { id: "a", name: "n", scope: "read", hash: "a".repeat(64), userId: "u", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", lastUsedAt: null, revokedAt: null };
    for (const bad of [
      { ...good, scope: "root" },
      { ...good, expiresAt: "ontem" },
      { ...good, hash: "abc" },
      { ...good, revokedAt: 5 },
      "texto",
      null,
    ]) {
      await writeFile(file(), JSON.stringify({ tokens: [good, bad] }));
      const fresh = new ApiTokenStore(dir);
      expect(await fresh.list(), JSON.stringify(bad)).toEqual([]);
    }
    await writeFile(file(), JSON.stringify({ tokens: "não é lista" }));
    expect(await new ApiTokenStore(dir).list()).toEqual([]);
  });

  it("erro de disco ao ler (não é 'não existe'): lança, não aceita nada e tenta de novo depois", async () => {
    await mkdir(file()); // um diretório no lugar do arquivo: EISDIR
    const fresh = new ApiTokenStore(dir);
    await expect(fresh.resolve(`${API_TOKEN_PREFIX}${"A".repeat(43)}`)).rejects.toThrow();
    await expect(fresh.list()).rejects.toThrow();
    await rm(file(), { recursive: true });
    expect(await fresh.list()).toEqual([]); // repetiu a leitura depois do erro
  });

  it("falha ao gravar: a criação desfaz, o erro é storage_write_failed e nada vira token", async () => {
    await store.list(); // carregado
    await breakDisk();
    await expect(make("x")).rejects.toMatchObject({ code: "storage_write_failed", statusCode: 500 });
    expect(await store.list()).toEqual([]);
    await fixDisk();
  });

  it("falha ao gravar a revogação: o token continua valendo e o erro chega a quem pediu", async () => {
    const { token, info } = await make();
    await breakDisk();
    await expect(store.revoke(info.id)).rejects.toMatchObject({ code: "storage_write_failed" });
    expect(await store.resolve(token)).not.toBeNull();
    await fixDisk();
  });

  it("falha ao gravar o 'último uso' não derruba o pedido (só registra no log)", async () => {
    const { token } = await make();
    await breakDisk();
    vi.setSystemTime(NOW + 120_000);
    expect(await store.resolve(token)).not.toBeNull();
    await store.flush();
    expect(logs.join("\n")).toContain("último uso não gravado");
    await fixDisk();
  });

  it("arquivo sem permissão de leitura: lança (falha fechada)", async () => {
    if (process.getuid?.() === 0) return; // root lê tudo
    await make();
    await store.flush();
    await chmod(file(), 0o000);
    try {
      await expect(new ApiTokenStore(dir).list()).rejects.toThrow();
    } finally {
      await chmod(file(), 0o600);
    }
  });
});

describe("tokenStatus", () => {
  it("revogado vence vencido; vencido vence ativo", () => {
    expect(tokenStatus({ expiresAt: "2000-01-01T00:00:00Z", revokedAt: "2000-01-01T00:00:00Z" }, NOW)).toBe("revoked");
    expect(tokenStatus({ expiresAt: "2000-01-01T00:00:00Z", revokedAt: null }, NOW)).toBe("expired");
    expect(tokenStatus({ expiresAt: "2099-01-01T00:00:00Z", revokedAt: null }, NOW)).toBe("active");
  });
});
