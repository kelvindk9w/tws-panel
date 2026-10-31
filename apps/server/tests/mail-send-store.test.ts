/**
 * Armazenamento do registro de envios: permissões (0600/0700), retenção,
 * linhas corrompidas, enxugar o dia e a configuração normalizada.
 */
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAIL_SEND_CONTENT_DIRNAME } from "@paas/core";
import { MailSendStore, normalizeSettings, type StoredSend } from "../src/services/mail-send-store.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
let now = Date.parse("2026-10-22T12:00:00Z");
let store: MailSendStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-send-store-"));
  now = Date.parse("2026-10-22T12:00:00Z");
  store = new MailSendStore(dir, () => now);
});
afterEach(async () => {
  await removeDir(dir);
});

function rec(id: string, at: string, extra: Partial<StoredSend> = {}): StoredSend {
  return {
    id,
    at,
    from: "app@example.com",
    login: "app@example.com",
    mailbox: "app@example.com",
    origin: "project",
    projectId: "p1",
    projectName: "Loja",
    size: 10,
    attachments: [],
    recipients: [],
    content: "none",
    truncated: false,
    captured: true,
    ...extra,
  };
}

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("permissões", () => {
  it("metadados em pasta 0700 e arquivo 0600; conteúdo em pasta própria 0700 e arquivo 0600", async () => {
    await store.load();
    await store.put(rec("1", "2026-10-22T10:00:00.000Z"));
    await store.writeContent({ id: "1", subject: "s", body: "b", bodyTruncated: false, attachments: [], storedAt: "2026-10-22T10:00:00.000Z" });
    expect(await mode(store.dir)).toBe(0o700);
    expect(await mode(path.join(store.dir, "2026-10-22.jsonl"))).toBe(0o600);
    expect(await mode(store.contentDir)).toBe(0o700);
    expect(await mode(path.join(store.contentDir, "1.json"))).toBe(0o600);
    expect(path.basename(store.contentDir)).toBe(MAIL_SEND_CONTENT_DIRNAME);
    // o conteúdo NÃO fica junto dos metadados
    expect(path.dirname(store.contentDir)).toBe(dir);
    expect((await readFile(path.join(store.dir, "2026-10-22.jsonl"), "utf8")).includes('"body"')).toBe(false);
  });

  it("id fora do formato nunca vira caminho", async () => {
    await expect(store.writeContent({ id: "../x", subject: null, body: null, bodyTruncated: false, attachments: [], storedAt: "" })).rejects.toThrow(/inválido/);
    expect(await store.readContent("../x")).toBeNull();
  });
});

describe("leitura", () => {
  it("vale o último instantâneo; linha cortada e arquivo estranho são ignorados", async () => {
    await mkdir(store.dir, { recursive: true });
    const a = rec("5", "2026-10-22T10:00:00.000Z");
    const b = { ...a, size: 99 };
    await writeFile(path.join(store.dir, "2026-10-22.jsonl"), [JSON.stringify(a), JSON.stringify(b), '{"id":"6","at"', "", JSON.stringify({ id: "x1", recipients: [] }), JSON.stringify({ id: "7" })].join("\n"));
    await writeFile(path.join(store.dir, "notas.txt"), "oi");
    await store.load();
    await store.load();
    expect(store.all().map((r) => r.id)).toEqual(["5"]);
    expect(store.get("5")?.size).toBe(99);
  });

  it("sem pasta: vazio", async () => {
    await store.load();
    expect(store.all()).toEqual([]);
    expect(await store.contentFiles()).toEqual([]);
    expect(await store.readContent("9")).toBeNull();
    await store.deleteContent("9");
  });

  it("o que foi gravado volta numa nova instância", async () => {
    await store.load();
    await store.put(rec("8", "2026-10-21T10:00:00.000Z"));
    const other = new MailSendStore(dir, () => now);
    await other.load();
    expect(other.get("8")?.projectName).toBe("Loja");
  });

  it("conteúdo de outro id ou ilegível não é devolvido", async () => {
    await mkdir(store.contentDir, { recursive: true });
    await writeFile(path.join(store.contentDir, "3.json"), JSON.stringify({ id: "4" }));
    await writeFile(path.join(store.contentDir, "2.json"), "{nao-json");
    await writeFile(path.join(store.contentDir, "lixo.txt"), "x");
    expect(await store.readContent("3")).toBeNull();
    expect(await store.readContent("2")).toBeNull();
    expect((await store.contentFiles()).map((f) => f.id).sort()).toEqual(["2", "3"]);
  });
});

describe("retenção", () => {
  it("apaga os dias além do prazo e o conteúdo dessas mensagens", async () => {
    await store.load();
    await store.put(rec("1", "2026-06-01T10:00:00.000Z"));
    await store.put(rec("2", "2026-10-20T10:00:00.000Z"));
    await store.writeContent({ id: "1", subject: "s", body: "b", bodyTruncated: false, attachments: [], storedAt: "x" });
    const out = await store.prune(90);
    expect(out).toEqual({ removedDays: 1, removedRecords: 1 });
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")).toBeDefined();
    expect(await readdir(store.dir)).toEqual(["2026-10-20.jsonl"]);
    expect(await readdir(store.contentDir)).toEqual([]);
  });

  it("enxuga o dia quando há muito instantâneo repetido", async () => {
    await store.load();
    for (let i = 0; i < 30; i++) await store.put(rec("1", "2026-10-22T10:00:00.000Z", { size: i }));
    const file = path.join(store.dir, "2026-10-22.jsonl");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(30);
    await store.prune(90);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).size).toBe(29);
    expect(await mode(file)).toBe(0o600);
  });

  it("pasta ausente ou dia pequeno: não faz nada", async () => {
    expect(await store.prune(90)).toEqual({ removedDays: 0, removedRecords: 0 });
    await store.load();
    await store.put(rec("1", "2026-10-22T10:00:00.000Z"));
    await store.put(rec("1", "2026-10-22T10:00:00.000Z"));
    await store.prune(90);
    expect((await readFile(path.join(store.dir, "2026-10-22.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("lista o conteúdo com tamanho e data", async () => {
    await store.writeContent({ id: "1", subject: "s", body: "b", bodyTruncated: false, attachments: [], storedAt: "x" });
    await utimes(path.join(store.contentDir, "1.json"), new Date(1000), new Date(1000));
    const files = await store.contentFiles();
    expect(files[0]).toMatchObject({ id: "1", mtimeMs: 1000 });
    expect(files[0]!.size).toBeGreaterThan(5);
  });
});

describe("gravação que falha não faz o envio sumir depois", () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    store = new MailSendStore(dir, () => now, (m) => logged.push(m));
  });

  it("o instantâneo fica pendente, aparece na memória e é regravado na próxima gravação; a reinicialização o relê", async () => {
    await store.load();
    // "saidas" vira um arquivo: criar a pasta falha
    await mkdir(path.join(dir, "mail", "envios"), { recursive: true });
    await writeFile(path.join(dir, "mail", "envios", "saidas"), "bloqueado");
    await expect(store.put(rec("101", "2026-10-22T10:00:00.000Z"))).rejects.toBeDefined();
    expect(store.get("101")).toBeDefined();
    expect(store.pendingWrites).toBe(1);
    // o problema some
    await removeDir(path.join(dir, "mail", "envios", "saidas"));
    await store.put(rec("102", "2026-10-22T11:00:00.000Z"));
    expect(store.pendingWrites).toBe(0);
    const reborn = new MailSendStore(dir, () => now);
    await reborn.load();
    expect(reborn.all().map((r) => r.id).sort()).toEqual(["101", "102"]);
  });

  it("um arquivo de dia quebrado não trava os outros dias, e o dia saudável continua sendo enxugado", async () => {
    await store.load();
    const sendsDir = path.join(dir, "mail", "envios", "saidas");
    await mkdir(sendsDir, { recursive: true });
    // 21/10 vira diretório: gravar nele falha
    await mkdir(path.join(sendsDir, "2026-10-21.jsonl"));
    await expect(store.put(rec("1", "2026-10-21T09:00:00.000Z"))).rejects.toBeDefined();
    // o envio do dia saudável é salvo SEM erro, mesmo com o do dia quebrado ainda pendente (e o erro alheio vai para o log)
    await expect(store.put(rec("2", "2026-10-22T09:00:00.000Z"))).resolves.toBeUndefined();
    expect(logged.join(" ")).toMatch(/envio 1/);
    // só o quebrado segue pendente
    expect(store.pendingWrites).toBe(1);
    expect(await readFile(path.join(sendsDir, "2026-10-22.jsonl"), "utf8")).toContain('"id":"2"');
    // muito instantâneo repetido no dia saudável: a limpeza ainda o enxuga
    for (let i = 0; i < 30; i++) await store.put(rec("2", "2026-10-22T09:00:00.000Z")).catch(() => undefined);
    await store.prune(90);
    expect((await readFile(path.join(sendsDir, "2026-10-22.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
    expect(store.pendingWrites).toBe(1);
    expect(store.get("1")).toBeDefined();
  });

  it("lote com um dia quebrado: os outros envios do lote são salvos e atualizados, sem erro", async () => {
    await store.load();
    const sendsDir = path.join(dir, "mail", "envios", "saidas");
    await mkdir(sendsDir, { recursive: true });
    await mkdir(path.join(sendsDir, "2026-10-21.jsonl"));
    await expect(store.put(rec("1", "2026-10-21T09:00:00.000Z"))).rejects.toBeDefined();
    const results = await Promise.allSettled([
      store.put(rec("2", "2026-10-22T09:00:00.000Z", { size: 1 })),
      store.put(rec("3", "2026-10-22T10:00:00.000Z", { size: 2 })),
      store.put(rec("2", "2026-10-22T09:00:00.000Z", { size: 3 })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(store.pendingWrites).toBe(1);
    const reborn = new MailSendStore(dir, () => now);
    await reborn.load();
    expect(reborn.get("2")!.size).toBe(3);
    expect(reborn.get("3")!.size).toBe(2);
  });

  it("o pendente só sai da lista se a versão gravada ainda é a da memória", async () => {
    await store.load();
    const first = rec("5", "2026-10-22T09:00:00.000Z");
    const p1 = store.put(first);
    const p2 = store.put({ ...first, size: 99 });
    await Promise.all([p1, p2]);
    expect(store.pendingWrites).toBe(0);
    const reborn = new MailSendStore(dir, () => now);
    await reborn.load();
    expect(reborn.get("5")!.size).toBe(99);
  });
});

describe("configuração", () => {
  it("padrão sensato: 90 dias de metadados, 14 de corpo, conteúdo ligado", async () => {
    expect(await store.loadSettings()).toEqual({
      metadataDays: 90,
      bodyDays: 14,
      storeContent: true,
      maxBodyKiB: 64,
      maxTotalMiB: 100,
      projectsWithoutContent: [],
    });
  });

  it("normaliza: limites, corpo nunca mais velho que os metadados, projetos sem repetição", () => {
    expect(normalizeSettings(null)).toMatchObject({ metadataDays: 90 });
    expect(normalizeSettings({ metadataDays: 5, bodyDays: 500, maxBodyKiB: 0, maxTotalMiB: 99999, storeContent: "sim" })).toMatchObject({
      metadataDays: 7,
      bodyDays: 7,
      maxBodyKiB: 1,
      maxTotalMiB: 2048,
      storeContent: true,
    });
    expect(normalizeSettings({ projectsWithoutContent: ["b", "a", "a", 3, "", "x".repeat(65)] }).projectsWithoutContent).toEqual(["a", "b"]);
    expect(normalizeSettings({ metadataDays: "x" }).metadataDays).toBe(90);
  });

  it("grava com permissão 0600 e lê de volta", async () => {
    await store.saveSettings(normalizeSettings({ bodyDays: 3, storeContent: false }));
    expect(await mode(path.join(dir, "mail", "envios", "saidas-config.json"))).toBe(0o600);
    expect(await store.loadSettings()).toMatchObject({ bodyDays: 3, storeContent: false });
  });
});
