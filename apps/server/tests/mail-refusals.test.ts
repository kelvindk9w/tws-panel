/**
 * Recusas antes da fila: o armazenamento limitado (tetos por dia, deduplicação, retenção) e a coleta pelo
 * MailEnviosService (linhas do registro do Stalwart → recusas atribuídas ao projeto pelo login da caixa).
 */
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailRefusal } from "@paas/core";
import { MailRefusalStore } from "../src/services/mail-refusal-store.js";
import { MailEnviosService, type MailEnviosDeps } from "../src/services/mail-envios-service.js";
import { removeDir } from "./helpers/tmp.js";

const NOW = Date.parse("2026-10-30T15:00:00Z");
let dir = "";
let clock = NOW;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-refusals-"));
  clock = NOW;
});
afterEach(async () => {
  await removeDir(dir);
});

const refusal = (over: Partial<MailRefusal> = {}): MailRefusal => ({
  at: "2026-10-30T14:00:00.000Z",
  kind: "auth_failed",
  origin: "internal",
  login: "loja@example.com",
  projectId: "p1",
  ...over,
});

describe("MailRefusalStore", () => {
  const make = (extra: Partial<ConstructorParameters<typeof MailRefusalStore>[0]> = {}) => new MailRefusalStore({ dir: path.join(dir, "r"), now: () => clock, ...extra });

  it("grava, lista (mais recentes primeiro) e filtra por projeto", async () => {
    const store = make();
    await store.append([
      refusal({ at: "2026-10-30T10:00:00.000Z" }),
      refusal({ at: "2026-10-30T12:00:00.000Z", kind: "tls_error", origin: "external", login: null, projectId: null }),
      refusal({ at: "2026-10-29T12:00:00.000Z", projectId: "p2", login: "blog@example.com" }),
    ]);
    const all = await store.list();
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.at)).toEqual(["2026-10-30T12:00:00.000Z", "2026-10-30T10:00:00.000Z", "2026-10-29T12:00:00.000Z"]);
    const p1 = await store.list({ projectId: "p1" });
    expect(p1.items.map((i) => i.kind)).toEqual(["auth_failed"]);
    expect((await store.list({ projectId: "nenhum" })).total).toBe(0);
  });

  it("escopo: app = vindas da rede interna; external = da internet ou sem endereço", async () => {
    const store = make();
    await store.append([
      refusal({ at: "2026-10-30T10:00:00.000Z" }),
      refusal({ at: "2026-10-30T11:00:00.000Z", projectId: null, login: "x@example.com" }),
      refusal({ at: "2026-10-30T12:00:00.000Z", origin: "external", projectId: null, login: "bot@x.com" }),
      refusal({ at: "2026-10-30T13:00:00.000Z", origin: "unknown", projectId: null, login: "u@x.com" }),
    ]);
    expect((await store.list({ scope: "app" })).items.map((i) => i.login)).toEqual(["x@example.com", "loja@example.com"]);
    expect((await store.list({ scope: "external" })).items.map((i) => i.login)).toEqual(["u@x.com", "bot@x.com"]);
    expect((await store.list()).total).toBe(4);
  });

  it("projeto com id estranho: nome de arquivo seguro e filtro certo", async () => {
    const store = make();
    await store.append([refusal({ projectId: "../../etc/x" })]);
    const files = await readdir(path.join(dir, "r"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^p-2026-10-30-[A-Za-z0-9_-]+\.jsonl$/);
    expect((await store.list({ projectId: "../../etc/x" })).total).toBe(1);
  });

  it("registro antigo sem origem volta como unknown", async () => {
    const store = make();
    await mkdir(path.join(dir, "r"), { recursive: true });
    await writeFile(path.join(dir, "r", "x-2026-10-30.jsonl"), JSON.stringify({ at: "2026-10-30T10:00:00.000Z", kind: "auth_failed", login: null, projectId: null }) + "\n");
    expect((await store.list({ scope: "external" })).items[0]).toMatchObject({ origin: "unknown" });
  });

  it("o arquivo guarda só tipo, hora, login e projeto (nada de IP nem senha)", async () => {
    const store = make();
    await store.append([refusal()]);
    const files = await readdir(path.join(dir, "r"));
    expect(files).toEqual(["p-2026-10-30-p1.jsonl"]);
    const text = await readFile(path.join(dir, "r", files[0]!), "utf8");
    expect(Object.keys(JSON.parse(text.trim())).sort()).toEqual(["at", "kind", "login", "origin", "projectId"]);
    expect(((await stat(path.join(dir, "r", files[0]!))).mode & 0o777).toString(8)).toBe("600");
  });

  it("mesmo tipo e login no mesmo minuto vale uma linha só (inclusive entre gravações)", async () => {
    const store = make();
    await store.append([refusal({ at: "2026-10-30T14:00:01.000Z" }), refusal({ at: "2026-10-30T14:00:30.000Z" })]);
    await store.append([refusal({ at: "2026-10-30T14:00:50.000Z" }), refusal({ at: "2026-10-30T14:01:00.000Z" })]);
    expect((await store.list()).total).toBe(2);
  });

  it("teto por dia é POR PROJETO e separado das de fora (força bruta não apaga o aviso de nenhum projeto)", async () => {
    const store = make({ maxProjectPerDay: 3, maxOtherPerDay: 2 });
    const bots = Array.from({ length: 10 }, (_, i) =>
      refusal({ at: `2026-10-30T13:${String(i).padStart(2, "0")}:00.000Z`, origin: "external", login: `bot${i}@x.com`, projectId: null }),
    );
    await store.append(bots);
    await store.append([refusal({ at: "2026-10-30T14:30:00.000Z" })]);
    const all = await store.list({ limit: 200 });
    expect(all.items.filter((i) => i.projectId === null)).toHaveLength(2);
    expect(all.items.filter((i) => i.projectId === "p1")).toHaveLength(1);
    // o teto de um projeto não consome o do outro
    await store.append(Array.from({ length: 6 }, (_, i) => refusal({ at: `2026-10-30T11:0${i}:00.000Z`, login: `l${i}@example.com` })));
    await store.append(Array.from({ length: 6 }, (_, i) => refusal({ at: `2026-10-30T11:1${i}:00.000Z`, login: `m${i}@example.com`, projectId: "p2" })));
    expect((await store.list({ projectId: "p1" })).total).toBe(3);
    expect((await store.list({ projectId: "p2" })).total).toBe(3);
  });

  it("limite da lista: padrão 50, no máximo 200, mínimo 1", async () => {
    const store = make();
    await store.append(Array.from({ length: 80 }, (_, i) => refusal({ at: `2026-10-30T${String(Math.floor(i / 60) + 8).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`, login: `l${i}@example.com` })));
    expect((await store.list()).items).toHaveLength(50);
    expect((await store.list({ limit: 500 })).items).toHaveLength(80);
    expect((await store.list({ limit: 0 })).items).toHaveLength(1);
    expect((await store.list()).total).toBe(80);
  });

  it("retenção: não grava o que já passou do prazo e apaga dias velhos", async () => {
    const store = make({ retentionDays: 2 });
    await mkdir(path.join(dir, "r"), { recursive: true });
    await writeFile(path.join(dir, "r", "p-2026-10-01.jsonl"), JSON.stringify(refusal({ at: "2026-10-01T10:00:00.000Z" })) + "\n");
    await writeFile(path.join(dir, "r", "lixo.txt"), "x");
    await store.append([refusal({ at: "2026-10-01T11:00:00.000Z" }), refusal({ at: "2026-10-30T11:00:00.000Z" })]);
    expect((await readdir(path.join(dir, "r"))).sort()).toEqual(["lixo.txt", "p-2026-10-30-p1.jsonl"]);
    expect((await store.list()).total).toBe(1);
    expect(store.retention).toBe(2);
  });

  it("pasta ausente e linhas corrompidas: lista vazia / ignora", async () => {
    const store = make();
    expect(await store.list()).toEqual({ items: [], total: 0 });
    await store.prune();
    await store.append([]);
    await mkdir(path.join(dir, "r"), { recursive: true });
    await writeFile(path.join(dir, "r", "p-2026-10-30-p1.jsonl"), `{quebrado\n${JSON.stringify({ x: 1 })}\n${JSON.stringify(refusal())}\n${JSON.stringify(refusal())}\n`);
    expect((await store.list()).total).toBe(1);
  });
});

describe("MailEnviosService: coleta das recusas", () => {
  let lines: string[] = [];
  let sendersFail = false;
  const line = (event: string, fields: string, at = "2026-10-30T14:00:00Z") => `${at} INFO Evento (${event}) ${fields}`;

  const deps = (over: Partial<MailEnviosDeps> = {}): MailEnviosDeps => ({
    dataDir: dir,
    serverCreated: async () => true,
    listQueue: async () => ({ items: [], total: 0 }),
    retry: async () => true,
    cancel: async () => true,
    senders: async () => {
      if (sendersFail) throw new Error("sem caixas");
      return [
        { address: "loja@example.com", mailbox: "loja@example.com", projectId: "p1", system: false },
        { address: "vendas@example.com", mailbox: "loja@example.com", projectId: "p1", system: false },
        { address: "postmaster@example.com", mailbox: "postmaster@example.com", projectId: null, system: true },
      ];
    },
    projectNames: async () => new Map([["p1", "Loja"]]),
    readLogs: async (_since, onLine) => {
      for (const l of lines) onLine(l);
    },
    now: () => clock,
    ...over,
  });

  beforeEach(() => {
    lines = [];
    sendersFail = false;
  });

  const APP = 'listenerId = "submission", remoteIp = 172.18.0.9';
  const WEB = 'listenerId = "submission", remoteIp = 203.0.113.7';

  it("atribui ao projeto só o que veio da rede interna, pelo login da caixa (ou de um endereço de envio dela)", async () => {
    lines = [
      line("auth.failed", `${APP}, id = "loja@example.com"`, "2026-10-30T14:00:00Z"),
      line("auth.failed", `${APP}, id = "vendas@example.com"`, "2026-10-30T14:05:00Z"),
      line("auth.failed", `${APP}, id = "root@example.com"`, "2026-10-30T14:06:00Z"),
      line("tls.handshake-error", `${APP}`, "2026-10-30T14:07:00Z"),
      line("smtp.mail-from-unauthorized", `${APP}, id = "postmaster@example.com"`, "2026-10-30T14:08:00Z"),
    ];
    const svc = new MailEnviosService(deps());
    await svc.collect();
    const r = await svc.refusals({ projectId: "p1" });
    expect(r.items.map((i) => [i.kind, i.login, i.projectName, i.origin])).toEqual([
      ["auth_failed", "vendas@example.com", "Loja", "internal"],
      ["auth_failed", "loja@example.com", "Loja", "internal"],
    ]);
    const all = await svc.refusals();
    expect(all.total).toBe(5);
    expect(all.items.find((i) => i.kind === "tls_error")).toMatchObject({ login: null, projectId: null, projectName: null });
    expect(all).toMatchObject({ retentionDays: 30, serverCreated: true });
    expect(all.collectedAt).not.toBeNull();
    // IP nunca é guardado
    expect(JSON.stringify(all)).not.toContain("172.18.0.9");
  });

  it("senha errada vinda da internet com o login da caixa de um projeto NÃO é tentativa do app", async () => {
    lines = [line("auth.failed", `${WEB}, id = "loja@example.com"`), line("auth.failed", 'id = "loja@example.com"', "2026-10-30T14:01:00Z")];
    const svc = new MailEnviosService(deps());
    await svc.collect();
    expect((await svc.refusals({ projectId: "p1" })).total).toBe(0);
    expect((await svc.refusals({ scope: "app" })).total).toBe(0);
    const outside = await svc.refusals({ scope: "external" });
    expect(outside.items.map((i) => [i.origin, i.projectId])).toEqual([
      ["unknown", null],
      ["external", null],
    ]);
    expect(JSON.stringify(outside)).not.toContain("203.0.113.7");
  });

  it("recusas de IMAP, webmail e administração não entram", async () => {
    lines = [
      line("auth.failed", 'listenerId = "imap", remoteIp = 172.18.0.9, id = "loja@example.com"'),
      line("auth.failed", 'listenerId = "https", remoteIp = 203.0.113.7, id = "root@example.com"', "2026-10-30T14:01:00Z"),
    ];
    const svc = new MailEnviosService(deps());
    await svc.collect();
    expect((await svc.refusals({ scope: "external" })).total).toBe(0);
    expect((await svc.refusals()).total).toBe(0);
  });

  it("a recusa causada pelo próprio teste de conexão do painel não conta como tentativa do app", async () => {
    lines = [
      line("auth.failed", `${APP}, id = "loja@example.com"`, "2026-10-30T14:00:05Z"),
      line("auth.failed", `${APP}, id = "loja@example.com"`, "2026-10-30T14:30:00Z"),
    ];
    const probeAt = Date.parse("2026-10-30T14:00:00Z");
    const svc = new MailEnviosService(deps({ isProbe: (projectId, atMs) => projectId === "p1" && atMs >= probeAt - 1000 && atMs <= probeAt + 8000 }));
    await svc.collect();
    expect((await svc.refusals({ projectId: "p1" })).items.map((i) => i.at)).toEqual(["2026-10-30T14:30:00.000Z"]);
  });

  it("não mistura com o histórico de entregas e não repete na coleta seguinte", async () => {
    lines = [line("auth.failed", `${APP}, id = "loja@example.com"`)];
    const svc = new MailEnviosService(deps());
    await svc.collect();
    await svc.collect();
    expect((await svc.refusals()).total).toBe(1);
    expect((await svc.history({ days: 7 })).total).toBe(0);
  });

  it("sem a lista de caixas, a recusa é guardada sem projeto (a coleta não falha)", async () => {
    sendersFail = true;
    lines = [line("auth.failed", `${APP}, id = "loja@example.com"`)];
    const svc = new MailEnviosService(deps());
    await svc.collect();
    expect((await svc.refusals()).items[0]).toMatchObject({ login: "loja@example.com", projectId: null });
  });

  it("falha ao gravar as recusas não derruba a coleta de entregas", async () => {
    lines = [line("auth.failed", 'id = "loja@example.com"')];
    // "recusas" vira um arquivo: criar a pasta falha
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "mail", "envios"), { recursive: true });
    await writeFile(path.join(dir, "mail", "envios", "recusas"), "bloqueado");
    const svc = new MailEnviosService(deps({ dataDir: dir }));
    await expect(svc.collect()).resolves.toBeDefined();
    expect((await svc.refusals()).total).toBe(0);
  });

  it("servidor não criado e projetos indisponíveis", async () => {
    const svc = new MailEnviosService(deps({ serverCreated: async () => false, projectNames: async () => Promise.reject(new Error("x")) }));
    expect(await svc.refusals()).toMatchObject({ items: [], total: 0, serverCreated: false });
  });
});
