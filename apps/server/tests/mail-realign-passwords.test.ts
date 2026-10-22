/**
 * Depois de restaurar o backup do e-mail, a caixa volta no Stalwart com a
 * senha ANTIGA do backup e o painel segue usando a que ele guardou (caso do
 * dono: o teste de notificação falhava com 535 5.7.8). Sincronizar e a adoção
 * do fim da restauração reaplicam no Stalwart a senha que o painel guardou
 * para as caixas de sistema (postmaster@) e de projeto, e SÓ para elas.
 *
 * O StalwartClient é o de verdade, falando com um Stalwart FALSO por fetch.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async applyTls() {
      return "restarted";
    }
    async waitReady() {}
    async joinMailNetworks() {}
    async leaveProjectNetwork() {}
    async connectContainer() {}
    async status() {
      return { installed: true, running: true, version: "0.11.8", image: "x", containerName: "paas-stalwart", hostname: "mail.test", ports: MAIL_DEFAULT_PORTS, message: null };
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

const ADMIN = "admin-secret-de-teste";
const DOMAIN = "envio.example.com";
const DKIM_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".padEnd(300, "A");
const PM = `postmaster@${DOMAIN}`;
const LOJA = `loja@${DOMAIN}`;
const JOAO = `joao@${DOMAIN}`;
const SEM = `sem@${DOMAIN}`;
const FORA = `fora@${DOMAIN}`;

/** Senha que o Stalwart falso aceita para cada caixa (a do backup restaurado). */
let serverPassword: Record<string, string> = {};
let patchLog: Array<{ email: string; value: string }> = [];
let failPatchFor = new Set<string>();
let firstPatchDelayMs = 0;
let principals: Array<Record<string, unknown>> = [];
const logs: string[] = [];

function box(name: string) {
  return { id: 1, type: "individual", name, secrets: ["$6$HASH-NAO-PODE-VAZAR"], emails: [name], roles: ["user"], quota: 0 };
}

function fakeStalwart() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/principal" && (init?.method ?? "GET") === "GET") {
        const type = u.searchParams.get("type");
        const items = principals.filter((p) => p.type === type);
        return new Response(JSON.stringify({ data: { items, total: items.length } }), { status: 200 });
      }
      if (u.pathname.startsWith("/api/principal/") && init?.method === "PATCH") {
        const email = decodeURIComponent(u.pathname.slice("/api/principal/".length));
        const ops = JSON.parse(String(init.body)) as Array<{ field: string; value: string[] }>;
        const value = ops[0]!.value[0]!;
        const first = email === PM && !patchLog.some((x) => x.email === PM);
        patchLog.push({ email, value });
        if (first && firstPatchDelayMs > 0) await new Promise((r) => setTimeout(r, firstPatchDelayMs));
        if (failPatchFor.has(email)) return new Response(`{"detail":"boom"}`, { status: 500 });
        serverPassword[email] = value;
        return new Response(`{"data":null}`, { status: 200 });
      }
      if (u.pathname.startsWith("/api/dkim/")) return new Response(JSON.stringify({ data: DKIM_KEY }), { status: 200 });
      return new Response(`{"data":null}`, { status: 200 });
    }),
  );
}

let dir = "";
let config: ServerConfig;

function mailbox(id: string, kind: "system" | "project" | "user", password: string, extra: Record<string, unknown> = {}) {
  const [localPart] = id.split("@");
  return { id, localPart, domain: DOMAIN, kind, createdAt: "2026-10-20T00:00:00.000Z", password, ...extra };
}

async function readStored() {
  return JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as { mailboxes: Record<string, { password: string }> };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-realign-"));
  logs.length = 0;
  patchLog = [];
  failPatchFor = new Set();
  firstPatchDelayMs = 0;
  config = { dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null } as unknown as ServerConfig;
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({
      adminSecret: ADMIN,
      hostname: null,
      domains: {
        [DOMAIN]: { name: DOMAIN, dkimSelector: "paas", dkimPublicKey: "k".repeat(150), dkimKeyBits: 2048, dmarcStage: "none", createdAt: "2026-10-20T00:00:00.000Z", lastVerify: null, dmarcAlias: true },
      },
      mailboxes: {
        [PM]: mailbox(PM, "system", "senha-nova-do-painel-pm"),
        [LOJA]: mailbox(LOJA, "project", "senha-nova-do-painel-loja", { projectId: "p1" }),
        [JOAO]: mailbox(JOAO, "user", "senha-que-o-joao-pode-ter-trocado"),
        [SEM]: mailbox(SEM, "system", ""),
        [FORA]: mailbox(FORA, "project", "senha-de-caixa-que-o-servidor-nao-tem", { projectId: "p2" }),
      },
      projects: {},
    }),
  );
  // o backup restaurado: todas as caixas voltaram com a senha antiga
  serverPassword = { [PM]: "senha-antiga-do-backup", [LOJA]: "senha-antiga-do-backup", [JOAO]: "senha-do-joao-no-backup", [SEM]: "qualquer" };
  principals = [{ id: 11, type: "domain", name: DOMAIN }, box(PM), box(LOJA), box(JOAO), box(SEM)];
  fakeStalwart();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const service = () => new MailService(config, { log: (m: string) => logs.push(m), inContainer: false });

describe("Sincronizar realinha a senha das caixas do painel", () => {
  it("postmaster@ com senha divergente e caixa de projeto passam a ter a senha que o painel guardou", async () => {
    const result = await service().adoptFromStalwart();
    expect(serverPassword[PM]).toBe("senha-nova-do-painel-pm");
    expect(serverPassword[LOJA]).toBe("senha-nova-do-painel-loja");
    expect(result.passwordsRealigned).toBe(2);
    expect(result.passwordsFailed).toBeUndefined();
  });

  it("não toca em caixa de usuário, em caixa sem senha conhecida nem em caixa que o servidor não tem", async () => {
    await service().adoptFromStalwart();
    expect(serverPassword[JOAO]).toBe("senha-do-joao-no-backup");
    expect(serverPassword[SEM]).toBe("qualquer");
    expect(patchLog.map((p) => p.email).sort()).toEqual([LOJA, PM].sort());
  });

  it("caixa recém-adotada (sem senha conhecida) não é tocada", async () => {
    principals.push(box(`nova@${DOMAIN}`));
    serverPassword[`nova@${DOMAIN}`] = "da-pessoa";
    const result = await service().adoptFromStalwart();
    expect(result.mailboxes).toEqual([`nova@${DOMAIN}`]);
    expect(serverPassword[`nova@${DOMAIN}`]).toBe("da-pessoa");
  });

  it("falha parcial: as outras caixas são realinhadas, a falha é listada e a sincronização não cai", async () => {
    failPatchFor.add(PM);
    const result = await service().adoptFromStalwart();
    expect(serverPassword[LOJA]).toBe("senha-nova-do-painel-loja");
    expect(serverPassword[PM]).toBe("senha-antiga-do-backup");
    expect(result.passwordsRealigned).toBe(1);
    expect(result.passwordsFailed).toEqual([PM]);
  });

  it("nenhuma senha vai a resposta, ao log nem ao mail.json além do que já estava", async () => {
    failPatchFor.add(PM);
    const svc = service();
    const result = await svc.adoptFromStalwart();
    const text = JSON.stringify(result) + logs.join("\n");
    for (const secret of ["senha-nova-do-painel", "senha-antiga", "HASH-NAO-PODE-VAZAR", ADMIN]) expect(text).not.toContain(secret);
    expect((await readStored()).mailboxes[PM]!.password).toBe("senha-nova-do-painel-pm");
  });

  it("é idempotente: repetir reaplica o mesmo valor, sem mudar o cadastro", async () => {
    const svc = service();
    await svc.adoptFromStalwart();
    const before = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    const again = await svc.adoptFromStalwart();
    expect(again.passwordsRealigned).toBe(2);
    expect(serverPassword[PM]).toBe("senha-nova-do-painel-pm");
    expect(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).toBe(before);
  });

  it("chamadas simultâneas viram uma só: cada caixa é regravada uma vez", async () => {
    const svc = service();
    const [a, b] = await Promise.all([svc.adoptFromStalwart(), svc.adoptFromStalwart()]);
    expect(a).toBe(b);
    expect(patchLog).toHaveLength(2);
  });

  it("trocar a senha da caixa durante o realinhamento não deixa o servidor com a senha velha", async () => {
    firstPatchDelayMs = 60;
    const svc = service();
    const sync = svc.adoptFromStalwart();
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === PM)).toBe(true));
    await svc.changeMailboxPassword(PM, "outra-senha-longa-escolhida-agora");
    await sync;
    expect(serverPassword[PM]).toBe("outra-senha-longa-escolhida-agora");
    expect((await readStored()).mailboxes[PM]!.password).toBe("outra-senha-longa-escolhida-agora");
  });

  it("sem nada para realinhar o resultado não traz os campos", async () => {
    await writeFile(
      path.join(dir, "mail", "mail.json"),
      JSON.stringify({ adminSecret: ADMIN, hostname: null, domains: {}, mailboxes: {}, projects: {} }),
    );
    principals = [];
    const result = await service().adoptFromStalwart();
    expect(result).not.toHaveProperty("passwordsRealigned");
    expect(result).not.toHaveProperty("passwordsFailed");
  });
});
