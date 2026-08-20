/**
 * Testes do SessionStore (session-store.ts): segredo HMAC persistido e
 * reutilizado entre boots, purga de sessões expiradas, resolução de cookie
 * (assinatura, expiração, formato) e revogação — sempre com arquivos reais
 * em diretório temporário, verificando o ESTADO resultante em disco.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type Session } from "../src/services/session-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-sessions-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const USER = { id: "u1", username: "admin" };

async function readSessionsFile(): Promise<{ sessions: Session[] }> {
  return JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8"));
}

describe("segredo de sessão", () => {
  it("é gerado no primeiro boot com modo 0600 e REUTILIZADO nos boots seguintes", async () => {
    const first = new SessionStore(dir);
    await first.init();
    const { cookieValue } = await first.create(USER);

    const secretFile = path.join(dir, "session-secret");
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);

    // "reinicia o processo": novo store no mesmo diretório
    const second = new SessionStore(dir);
    await second.init();
    // o cookie assinado antes do boot continua válido → mesmo segredo
    const session = await second.resolve(cookieValue);
    expect(session?.username).toBe("admin");
  });

  it("segredo inválido em disco (curto demais) é substituído por um novo", async () => {
    await writeFile(path.join(dir, "session-secret"), "curto\n", "utf8");
    const store = new SessionStore(dir);
    await store.init();
    const { cookieValue } = await store.create(USER);
    expect(await store.resolve(cookieValue)).not.toBeNull();
    // e o arquivo passou a conter um segredo forte (64 hex chars)
    const raw = (await readFile(path.join(dir, "session-secret"), "utf8")).trim();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("create/resolve sem init() explícito inicializam o store automaticamente", async () => {
    const store = new SessionStore(dir);
    const { cookieValue } = await store.create(USER); // sem init() antes
    expect(await store.resolve(cookieValue)).not.toBeNull();
  });
});

describe("carga e purga", () => {
  it("sessions.json corrompido → store vazio, sem lançar", async () => {
    await writeFile(path.join(dir, "sessions.json"), "{json quebrado", "utf8");
    const store = new SessionStore(dir);
    await store.init();
    expect(await store.resolve("qualquer.coisa")).toBeNull();
  });

  it("sessions.json sem array → store vazio", async () => {
    await writeFile(path.join(dir, "sessions.json"), JSON.stringify({ sessions: { oops: true } }), "utf8");
    const store = new SessionStore(dir);
    await store.init();
    expect(await store.resolve("qualquer.coisa")).toBeNull();
  });

  it("sessões expiradas são descartadas no boot (e o arquivo é regravado sem elas)", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const expired: Session = {
      id: "expirada",
      userId: "u1",
      username: "admin",
      createdAt: past,
      expiresAt: past,
      ip: null,
      userAgent: null,
    };
    const valid: Session = { ...expired, id: "valida", createdAt: past, expiresAt: future };
    await writeFile(path.join(dir, "sessions.json"), JSON.stringify({ sessions: [expired, valid] }), "utf8");

    const store = new SessionStore(dir);
    await store.init();
    await store.resolve("x.y"); // força o ensureLoaded (purga)

    const onDisk = await readSessionsFile();
    expect(onDisk.sessions.map((s) => s.id)).toEqual(["valida"]);
  });
});

describe("resolve — verificação do cookie", () => {
  it("cookie vazio/ausente → null", async () => {
    const store = new SessionStore(dir);
    await store.init();
    expect(await store.resolve(undefined)).toBeNull();
    expect(await store.resolve("")).toBeNull();
  });

  it("formatos malformados → null (sem ponto, id vazio, assinatura curta)", async () => {
    const store = new SessionStore(dir);
    await store.init();
    await store.create(USER);
    expect(await store.resolve("sem-ponto")).toBeNull();
    expect(await store.resolve(".assinatura-sem-id")).toBeNull();
    expect(await store.resolve("abc123.curta")).toBeNull();
  });

  it("assinatura válida de sessão destruída → null (id desconhecido)", async () => {
    const store = new SessionStore(dir);
    await store.init();
    const { session, cookieValue } = await store.create(USER);
    await store.destroy(session.id);
    expect(await store.resolve(cookieValue)).toBeNull();
  });

  it("sessão que expira DEPOIS do boot é destruída na resolução", async () => {
    vi.useFakeTimers();
    const store = new SessionStore(dir);
    await store.init();
    const { session, cookieValue } = await store.create(USER);

    // avança o relógio além do TTL (12h) e tenta usar o cookie
    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
    expect(await store.resolve(cookieValue)).toBeNull();

    // a sessão foi removida de verdade (não só rejeitada)
    const onDisk = await readSessionsFile();
    expect(onDisk.sessions.some((s) => s.id === session.id)).toBe(false);
  });

  it("metadados (ip/userAgent) são persistidos com a sessão", async () => {
    const store = new SessionStore(dir);
    await store.init();
    const { cookieValue } = await store.create(USER, { ip: "10.0.0.1", userAgent: "Teste/1.0" });
    const session = await store.resolve(cookieValue);
    expect(session).toMatchObject({ ip: "10.0.0.1", userAgent: "Teste/1.0" });
  });
});

describe("revogação", () => {
  it("destroy de id inexistente não grava o arquivo", async () => {
    const store = new SessionStore(dir);
    await store.init();
    await store.destroy("inexistente");
    // nada foi persistido — o arquivo nem existe
    await expect(stat(path.join(dir, "sessions.json"))).rejects.toThrow();
  });

  it("destroyOthersForUser invalida só as outras sessões do mesmo usuário", async () => {
    const store = new SessionStore(dir);
    await store.init();
    const a1 = await store.create(USER);
    const a2 = await store.create(USER);
    const b = await store.create({ id: "u2", username: "outro" });

    const removed = await store.destroyOthersForUser("u1", a1.session.id);
    expect(removed).toBe(1);
    expect(await store.resolve(a1.cookieValue)).not.toBeNull(); // atual sobrevive
    expect(await store.resolve(a2.cookieValue)).toBeNull(); // outra sessão morreu
    expect(await store.resolve(b.cookieValue)).not.toBeNull(); // outro usuário intacto

    // segunda chamada sem nada a remover → 0
    expect(await store.destroyOthersForUser("u1", a1.session.id)).toBe(0);
  });

  it("a assinatura usa o segredo do disco (HMAC-SHA256 do id)", async () => {
    const store = new SessionStore(dir);
    await store.init();
    const { session, cookieValue } = await store.create(USER);
    const secret = Buffer.from(
      (await readFile(path.join(dir, "session-secret"), "utf8")).trim(),
      "hex",
    );
    const expected = createHmac("sha256", secret).update(session.id).digest("hex");
    expect(cookieValue).toBe(`${session.id}.${expected}`);
  });
});
