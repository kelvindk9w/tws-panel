/**
 * Depois de restaurar o backup do e-mail, a caixa volta no Stalwart com a
 * senha ANTIGA do backup e o painel segue usando a que ele guardou (caso do
 * dono: o teste de notificação falhava com 535 5.7.8). Sincronizar e a adoção
 * do fim da restauração reaplicam no Stalwart a senha que o painel guardou
 * para as caixas de sistema (postmaster@) e de projeto, e SÓ para elas.
 *
 * O StalwartClient é o de verdade, falando com um Stalwart FALSO por fetch.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { removeDir } from "./helpers/tmp.js";

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
let patchLog: Array<{ email: string; value: string; all: string[] }> = [];
/** Senhas de app e 2FA que o Stalwart falso guarda no mesmo campo, por caixa (um PATCH set secrets as apaga, como o real). */
let extraSecrets: Record<string, string[]> = {};
let failPatchFor = new Set<string>();
/** Atraso do PRIMEIRO PATCH de cada caixa (ms). */
let patchDelay: Record<string, number> = {};
/** Como o Stalwart falso responde a GET /principal/<caixa>: a senha em texto, um hash, sem senha, 500, caixa inexistente (como o v0.11.8 real: HTTP 200 com {"error":"notFound"}) ou 404 HTTP. */
let getMode: "plain" | "hash" | "none" | "error" | "missing" | "missing404" = "plain";
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
      if (u.pathname.startsWith("/api/principal/") && (init?.method ?? "GET") === "GET") {
        const email = decodeURIComponent(u.pathname.slice("/api/principal/".length));
        if (getMode === "error") return new Response(`{"detail":"boom"}`, { status: 500 });
        if (getMode === "missing") return new Response(JSON.stringify({ error: "notFound", item: email }), { status: 200 });
        if (getMode === "missing404") return new Response(`{"detail":"not found"}`, { status: 404 });
        const secrets = getMode === "plain" ? [serverPassword[email], ...(extraSecrets[email] ?? [])] : getMode === "hash" ? ["$6$salt$HASH-NAO-PODE-VAZAR"] : undefined;
        return new Response(JSON.stringify({ data: { type: "individual", name: email, ...(secrets ? { secrets } : {}) } }), { status: 200 });
      }
      if (u.pathname.startsWith("/api/principal/") && init?.method === "PATCH") {
        const email = decodeURIComponent(u.pathname.slice("/api/principal/".length));
        const ops = JSON.parse(String(init.body)) as Array<{ field: string; value: string[] }>;
        // nome de exibição (description): outro campo, não mexe na senha
        if (ops[0]!.field === "description") return new Response(`{"data":null}`, { status: 200 });
        const value = ops[0]!.value[0]!;
        const first = !patchLog.some((x) => x.email === email);
        patchLog.push({ email, value, all: ops[0]!.value });
        if (first && (patchDelay[email] ?? 0) > 0) await new Promise((r) => setTimeout(r, patchDelay[email]));
        if (failPatchFor.has(email)) return new Response(`{"detail":"boom"}`, { status: 500 });
        serverPassword[email] = value;
        extraSecrets[email] = ops[0]!.value.slice(1);
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
  extraSecrets = {};
  failPatchFor = new Set();
  patchDelay = {};
  getMode = "plain";
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
  await removeDir(dir);
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

  it("é idempotente: a segunda vez as senhas já conferem, nada é regravado e o resultado não traz os campos", async () => {
    const svc = service();
    await svc.adoptFromStalwart();
    const before = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    patchLog = [];
    const again = await svc.adoptFromStalwart();
    expect(patchLog).toEqual([]);
    expect(again).toEqual({ domains: [], mailboxes: [], skipped: [] });
    expect(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).toBe(before);
  });

  it("senha que já confere: não regrava, não conta e não aparece no resultado (só a divergente é realinhada)", async () => {
    serverPassword[PM] = "senha-nova-do-painel-pm";
    const result = await service().adoptFromStalwart();
    expect(patchLog.map((p) => p.email)).toEqual([LOJA]);
    expect(result.passwordsRealigned).toBe(1);
    expect(result.passwordsReapplied).toBeUndefined();
  });

  it("todas conferem: resultado limpo, sem nenhum PATCH", async () => {
    serverPassword[PM] = "senha-nova-do-painel-pm";
    serverPassword[LOJA] = "senha-nova-do-painel-loja";
    const result = await service().adoptFromStalwart();
    expect(patchLog).toEqual([]);
    expect(result).toEqual({ domains: [], mailboxes: [], skipped: [] });
  });

  it("realinhar preserva senhas de app e 2FA que a caixa tem (só a principal é trocada)", async () => {
    extraSecrets[PM] = ["$app$leitor$hash", "otpauth://totp/x?secret=ABC"];
    extraSecrets[LOJA] = ["$app$outro$hash"];
    await service().adoptFromStalwart();
    expect(patchLog.find((p) => p.email === PM)!.all).toEqual(["senha-nova-do-painel-pm", "$app$leitor$hash", "otpauth://totp/x?secret=ABC"]);
    expect(patchLog.find((p) => p.email === LOJA)!.all).toEqual(["senha-nova-do-painel-loja", "$app$outro$hash"]);
    expect(extraSecrets[PM]).toEqual(["$app$leitor$hash", "otpauth://totp/x?secret=ABC"]);
  });

  it("leitura com erro: não dá para preservar o que a caixa tem, então NÃO troca no escuro; a falha é listada", async () => {
    getMode = "error";
    const result = await service().adoptFromStalwart();
    expect(patchLog).toEqual([]);
    expect(result.passwordsFailed?.sort()).toEqual([LOJA, PM].sort());
    expect(result.passwordsReapplied).toBeUndefined();
  });

  it.each(["hash", "none"] as const)("não deu para conferir (%s): reaplica e conta como reaplicada, nunca como realinhada", async (mode) => {
    getMode = mode;
    const result = await service().adoptFromStalwart();
    expect(patchLog.map((p) => p.email).sort()).toEqual([LOJA, PM].sort());
    expect(serverPassword[PM]).toBe("senha-nova-do-painel-pm");
    expect(result.passwordsReapplied).toBe(2);
    expect(result.passwordsRealigned).toBeUndefined();
    expect(result.passwordsFailed).toBeUndefined();
  });

  it.each(["missing", "missing404"] as const)("caixa apagada no servidor durante a sincronização (%s): fica de fora, sem contar nem aparecer como falha", async (mode) => {
    getMode = mode;
    const result = await service().adoptFromStalwart();
    expect(patchLog).toEqual([]);
    expect(result.passwordsFailed).toBeUndefined();
    expect(result.passwordsRealigned).toBeUndefined();
    expect(result.passwordsReapplied).toBeUndefined();
  });

  it("caixa removida do cadastro enquanto esperava na fila: fica de fora", async () => {
    patchDelay[PM] = 60;
    const svc = service();
    const sync = svc.adoptFromStalwart();
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === PM)).toBe(true));
    await svc.deleteMailbox(DOMAIN, LOJA);
    const result = await sync;
    expect(result.passwordsFailed).toBeUndefined();
    expect(patchLog.some((p) => p.email === LOJA)).toBe(false);
  });

  it("caixa removida do cadastro depois de entrar na fila (esperando uma troca em andamento): nada é regravado", async () => {
    patchDelay[LOJA] = 300;
    // só hash: sem a checagem de remoção, o realinhamento reaplicaria a senha da caixa apagada
    getMode = "hash";
    const svc = service();
    const change = svc.changeMailboxPassword(LOJA, "senha-trocada-antes-de-apagar");
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === LOJA)).toBe(true));
    const sync = svc.adoptFromStalwart();
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === PM)).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    await svc.deleteMailbox(DOMAIN, LOJA);
    const [, result] = await Promise.all([change, sync]);
    expect(result.passwordsFailed).toBeUndefined();
    expect(patchLog.filter((p) => p.email === LOJA)).toHaveLength(1);
    expect(result.passwordsReapplied).toBe(1); // só a postmaster@
  });

  it("caixa de sistema cujo domínio não está cadastrado no painel não é tocada", async () => {
    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as Record<string, any>;
    stored.mailboxes["postmaster@outro.example.com"] = { ...mailbox("postmaster@outro.example.com", "system", "senha-do-outro-dominio"), domain: "outro.example.com" };
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify(stored));
    principals.push(box("postmaster@outro.example.com"));
    serverPassword["postmaster@outro.example.com"] = "senha-antiga";
    await service().adoptFromStalwart();
    expect(patchLog.some((p) => p.email === "postmaster@outro.example.com")).toBe(false);
  });

  it("chamadas simultâneas viram uma só: cada caixa é regravada uma vez", async () => {
    const svc = service();
    const [a, b] = await Promise.all([svc.adoptFromStalwart(), svc.adoptFromStalwart()]);
    expect(a).toBe(b);
    expect(patchLog).toHaveLength(2);
  });

  it("trocar a senha da caixa durante o realinhamento não deixa o servidor com a senha velha", async () => {
    patchDelay[PM] = 60;
    const svc = service();
    const sync = svc.adoptFromStalwart();
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === PM)).toBe(true));
    await svc.changeMailboxPassword(PM, "outra-senha-longa-escolhida-agora");
    await sync;
    expect(serverPassword[PM]).toBe("outra-senha-longa-escolhida-agora");
    expect((await readStored()).mailboxes[PM]!.password).toBe("outra-senha-longa-escolhida-agora");
  });

  it("troca de senha JÁ em andamento quando o realinhamento chega à caixa: a senha é lida na vez dela e a troca não é desfeita", async () => {
    patchDelay[LOJA] = 80;
    const svc = service();
    const change = svc.changeMailboxPassword(LOJA, "senha-trocada-pela-pessoa-agora");
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === LOJA)).toBe(true));
    const [, result] = await Promise.all([change, svc.adoptFromStalwart()]);
    expect(serverPassword[LOJA]).toBe("senha-trocada-pela-pessoa-agora");
    expect((await readStored()).mailboxes[LOJA]!.password).toBe("senha-trocada-pela-pessoa-agora");
    expect(patchLog.filter((p) => p.email === LOJA).map((p) => p.value)).toEqual(["senha-trocada-pela-pessoa-agora"]);
    expect(result.passwordsFailed).toBeUndefined();
  });

  it("ativar o e-mail do projeto (nova senha) durante o realinhamento não é desfeito", async () => {
    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as Record<string, any>;
    stored.projects["p1"] = { domain: DOMAIN, mailbox: LOJA, enabledAt: "2026-10-20T00:00:00.000Z", fromName: "Loja" };
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify(stored));
    patchDelay[LOJA] = 80;
    const svc = service();
    const sync = svc.adoptFromStalwart();
    await vi.waitFor(() => expect(patchLog.some((p) => p.email === LOJA)).toBe(true));
    await svc.enableProjectEmail({ id: "p1", slug: "loja", name: "Loja" } as never, DOMAIN, { password: "senha-nova-ao-ativar-o-email" });
    await sync;
    expect(serverPassword[LOJA]).toBe("senha-nova-ao-ativar-o-email");
    expect((await readStored()).mailboxes[LOJA]!.password).toBe("senha-nova-ao-ativar-o-email");
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
    expect(result).not.toHaveProperty("passwordsReapplied");
  });
});
