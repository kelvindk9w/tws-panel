/**
 * Depois de restaurar o e-mail numa VPS nova, o Stalwart volta com os
 * domínios e caixas de antes e o painel (que lista do seu cadastro,
 * data/mail/mail.json) só conhecia o que foi criado nela. Aqui o
 * StalwartClient é o de verdade, falando com um Stalwart FALSO por fetch
 * (mesmas formas de resposta da API v0.11, inclusive o campo `secrets`);
 * só o manager do Docker é dublê.
 *
 * Cenário do dono do produto: o backup tinha 2 domínios (cassp, envio) e 4
 * caixas; o painel novo só conhecia envio e postmaster@envio.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, type Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

let running = true;
/** Senha que o config.toml DENTRO do container aceita (o reparo a troca pela do painel). */
let liveSecret = "";
let applyTlsCalls = 0;
/** false: o reinício não consegue aplicar a senha do painel (reparo que falha). */
let repairWorks = true;
/** Docker falso que ecoa a senha de administração no stderr ao reiniciar. */
let dockerEchoesSecret = false;

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(private readonly opts: Record<string, unknown> = {}) {}
    async applyTls() {
      applyTlsCalls += 1;
      if (dockerEchoesSecret) throw new Error(`falha ao reiniciar paas-stalwart: secret = "${this.opts.adminSecret as string}" ${"x".repeat(300)}`);
      await new Promise((r) => setTimeout(r, 20));
      if (repairWorks) liveSecret = this.opts.adminSecret as string;
      return "restarted";
    }
    async waitReady() {}
    async joinMailNetworks() {}
    async leaveProjectNetwork() {}
    async connectContainer() {}
    async status() {
      return { installed: true, running, version: "0.11.8", image: "x", containerName: "paas-stalwart", hostname: "mail.test", ports: MAIL_DEFAULT_PORTS, message: null };
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

const ADMIN = "admin-secret-de-teste";
const HASH = "$6$saltsalt$HASH-DA-SENHA-NAO-PODE-VAZAR";
const DKIM_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".padEnd(300, "A");

/** O que o Stalwart tem (o backup restaurado). */
let principals: Array<Record<string, unknown>> = [];
let dkimOk = true;
let rejectAuth = false;
let fetchCalls: string[] = [];
/** Corpo de cada chamada (mesma ordem de fetchCalls). */
let fetchBodies: string[] = [];
/** "missing": a assinatura DKIM não existe até o POST; "error": a leitura falha com 500. */
let dkimMode: "ok" | "missing" | "error" = "ok";
let dkimPosts = 0;
/** true: o Stalwart falso pagina de verdade (limit/page). */
let pageLimitFake = false;

function box(name: string, emails: string[] = [name]) {
  return { id: 1, type: "individual", name, secrets: [HASH], emails, roles: ["user"], quota: 0 };
}

function fakeStalwart() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
      fetchBodies.push(String(init?.body ?? ""));
      const auth = (init?.headers as Record<string, string>).authorization;
      if (rejectAuth || auth !== `Basic ${Buffer.from(`admin:${liveSecret}`).toString("base64")}`) {
        return new Response(`{"error":"other","details":"You have to authenticate first"}`, { status: 401 });
      }
      const u = new URL(url);
      if (u.pathname === "/api/principal") {
        const type = u.searchParams.get("type");
        let items = principals.filter((p) => p.type === type);
        if (pageLimitFake) {
          const limit = Number(u.searchParams.get("limit") ?? "500");
          const page = Number(u.searchParams.get("page") ?? "1");
          items = items.slice((page - 1) * limit, page * limit);
        }
        return new Response(JSON.stringify({ data: { items, total: items.length } }), { status: 200 });
      }
      if (u.pathname.startsWith("/api/dkim/") && dkimMode === "error") return new Response(`{"detail":"boom"}`, { status: 500 });
      if (u.pathname.startsWith("/api/dkim/") && dkimMode === "missing" && dkimPosts === 0) return new Response(`{"detail":"not found"}`, { status: 404 });
      if (u.pathname === "/api/dkim" && init?.method === "POST") dkimPosts += 1;
      if (u.pathname.startsWith("/api/dkim/")) {
        if (!dkimOk) return new Response(`{"detail":"not found"}`, { status: 404 });
        return new Response(JSON.stringify({ data: DKIM_KEY }), { status: 200 });
      }
      if (u.pathname === "/api/dkim") return new Response(`{"data":null}`, { status: dkimOk ? 400 : 200 });
      return new Response(`{"data":null}`, { status: 200 });
    }),
  );
}

let dir = "";
let config: ServerConfig;

const registeredDomain = {
  name: "envio.example.com",
  dkimSelector: "paas",
  dkimPublicKey: "k".repeat(150),
  dkimKeyBits: 2048,
  dmarcStage: "quarantine",
  createdAt: "2026-10-20T00:00:00.000Z",
  lastVerify: { at: "2026-10-20T01:00:00.000Z", ok: 6, total: 6, recordsOk: true },
  dmarcAlias: true,
};

async function readStored() {
  return JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as {
    domains: Record<string, Record<string, unknown>>;
    mailboxes: Record<string, Record<string, unknown>>;
    projects: Record<string, unknown>;
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-adopt-"));
  running = true;
  dkimOk = true;
  dkimMode = "ok";
  dkimPosts = 0;
  pageLimitFake = false;
  rejectAuth = false;
  liveSecret = ADMIN;
  applyTlsCalls = 0;
  repairWorks = true;
  dockerEchoesSecret = false;
  fetchCalls = [];
  fetchBodies = [];
  config = { dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null } as unknown as ServerConfig;
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({
      adminSecret: ADMIN,
      hostname: null,
      domains: { "envio.example.com": registeredDomain },
      mailboxes: {
        "postmaster@envio.example.com": {
          id: "postmaster@envio.example.com",
          localPart: "postmaster",
          domain: "envio.example.com",
          kind: "system",
          createdAt: "2026-10-20T00:00:00.000Z",
          password: "senha-conhecida-do-painel",
        },
      },
      projects: {},
    }),
  );
  principals = [
    { id: 10, type: "domain", name: "cassp.example.com", description: "", secrets: [] },
    { id: 11, type: "domain", name: "envio.example.com" },
    box("contato@envio.example.com"),
    box("contato@cassp.example.com"),
    box("postmaster@envio.example.com", ["postmaster@envio.example.com", "abuse@envio.example.com", "dmarc@envio.example.com"]),
    box("postmaster@cassp.example.com", ["postmaster@cassp.example.com", "abuse@cassp.example.com", "dmarc@cassp.example.com"]),
  ];
  fakeStalwart();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const service = (extra: Record<string, unknown> = {}) => new MailService(config, { log: () => undefined, inContainer: false, ...extra });

describe("MailService.adoptFromStalwart", () => {
  it("cadastra o que faltava (1 domínio, 3 caixas) e o painel passa a mostrar tudo", async () => {
    const svc = service();
    const result = await svc.adoptFromStalwart();
    expect(result).toEqual({
      domains: ["cassp.example.com"],
      mailboxes: ["contato@envio.example.com", "contato@cassp.example.com", "postmaster@cassp.example.com"],
      skipped: [],
      // a postmaster@ já cadastrada tem senha conhecida e este Stalwart falso não devolve a senha: reaplicada sem conferir (ver mail-realign-passwords.test.ts)
      passwordsReapplied: 1,
    });
    const domains = await svc.listDomains();
    expect(domains.map((d) => [d.name, d.mailboxCount])).toEqual([
      ["envio.example.com", 2],
      ["cassp.example.com", 2],
    ]);
    const cassp = domains.find((d) => d.name === "cassp.example.com")!;
    expect(cassp.lastVerify).toBeNull();
    expect(cassp.dkimPublicKey).toBe(DKIM_KEY);
    const boxes = await svc.listMailboxes("cassp.example.com");
    expect(boxes.map((b) => [b.id, b.kind, b.passwordUnknown])).toEqual([
      ["contato@cassp.example.com", "user", true],
      ["postmaster@cassp.example.com", "system", true],
    ]);
    // nenhuma das 4 caixas aparece duplicada nem como abuse@/dmarc@
    expect(Object.keys((await readStored()).mailboxes).sort()).toEqual([
      "contato@cassp.example.com",
      "contato@envio.example.com",
      "postmaster@cassp.example.com",
      "postmaster@envio.example.com",
    ]);
  });

  it("não muda o que já estava cadastrado (senha, DNS verificado, estágio do DMARC)", async () => {
    await service().adoptFromStalwart();
    const stored = await readStored();
    expect(stored.mailboxes["postmaster@envio.example.com"]!.password).toBe("senha-conhecida-do-painel");
    expect(stored.domains["envio.example.com"]).toEqual(registeredDomain);
  });

  it("nunca grava, devolve nem mostra a senha do Stalwart", async () => {
    const svc = service();
    const result = await svc.adoptFromStalwart();
    const raw = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    expect(raw).not.toContain("HASH-DA-SENHA");
    expect(JSON.stringify(result)).not.toContain("HASH-DA-SENHA");
    expect(JSON.stringify(await svc.listMailboxes("cassp.example.com"))).not.toContain("HASH-DA-SENHA");
    const stored = await readStored();
    expect(stored.mailboxes["contato@cassp.example.com"]!.password).toBe("");
  });

  it("é idempotente: a segunda vez não cadastra nada e não muda o arquivo", async () => {
    const svc = service();
    await svc.adoptFromStalwart();
    const before = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    expect(await svc.adoptFromStalwart()).toEqual({ domains: [], mailboxes: [], skipped: [], passwordsReapplied: 1 });
    expect(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).toBe(before);
    // outra instância (painel reiniciado) também não duplica
    expect(await service().adoptFromStalwart()).toEqual({ domains: [], mailboxes: [], skipped: [], passwordsReapplied: 1 });
  });

  it("chamadas simultâneas viram uma só consulta ao Stalwart", async () => {
    const svc = service();
    const [a, b] = await Promise.all([svc.adoptFromStalwart(), svc.adoptFromStalwart()]);
    expect(a).toBe(b);
    expect(fetchCalls.filter((c) => c.includes("type=domain"))).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.includes("type=individual"))).toHaveLength(1);
    // e depois de terminar, uma nova chamada consulta de novo
    await svc.adoptFromStalwart();
    expect(fetchCalls.filter((c) => c.includes("type=domain"))).toHaveLength(2);
  });

  it("associa o projeto dono quando o endereço é o do projeto", async () => {
    principals.push(box("loja@cassp.example.com"));
    const stored = await readStored();
    stored.projects["p1"] = { domain: "cassp.example.com", mailbox: "loja@cassp.example.com", enabledAt: "2026-10-20T00:00:00.000Z" };
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ ...stored, adminSecret: ADMIN }));
    const svc = service({ projects: async () => [{ id: "p1", slug: "loja", name: "Loja" } as unknown as Project] });
    await svc.adoptFromStalwart();
    const boxes = await svc.listMailboxes("cassp.example.com", { projectId: "p1" });
    expect(boxes.map((b) => [b.id, b.kind, b.projectId])).toEqual([["loja@cassp.example.com", "project", "p1"]]);
  });

  it("caixa <slug>@ de um domínio que não é o do e-mail do projeto fica como caixa comum", async () => {
    principals.push(box("loja@cassp.example.com"));
    const svc = service({ projects: async () => [{ id: "p1", slug: "loja", name: "Loja" } as unknown as Project] });
    await svc.adoptFromStalwart();
    const boxes = await svc.listMailboxes("cassp.example.com");
    expect(boxes.find((b) => b.id === "loja@cassp.example.com")).toMatchObject({ kind: "user" });
  });

  it("lista de projetos que falha não impede o cadastro", async () => {
    const svc = service({
      projects: async () => {
        throw new Error("sem projetos");
      },
    });
    const result = await svc.adoptFromStalwart();
    expect(result.mailboxes).toHaveLength(3);
  });

  it("domínio sem chave DKIM legível não entra (nem as caixas dele) e fica na lista de ignorados", async () => {
    dkimOk = false;
    const result = await service().adoptFromStalwart();
    expect(result.domains).toEqual([]);
    expect(result.mailboxes).toEqual(["contato@envio.example.com"]);
    expect(result.skipped).toEqual(["cassp.example.com", "contato@cassp.example.com", "postmaster@cassp.example.com"]);
    expect(Object.keys((await readStored()).domains)).toEqual(["envio.example.com"]);
  });

  it("cria a assinatura DKIM só quando o Stalwart diz que ela não existe", async () => {
    dkimMode = "missing";
    const result = await service().adoptFromStalwart();
    expect(result.domains).toEqual(["cassp.example.com"]);
    expect(dkimPosts).toBe(1);
    // a chave criada agora só vale depois de reiniciar o Stalwart: um reinício, e nada pendente
    expect(applyTlsCalls).toBe(1);
    expect(result.dkimRestartPending).toBeUndefined();
    expect((await readStored()).domains["cassp.example.com"]!.dkimRestartPending).toBeUndefined();
  });

  it("chave DKIM criada e reinício que falha: o domínio fica 'reinício pendente' (não 'ok') e a resposta avisa", async () => {
    dkimMode = "missing";
    dockerEchoesSecret = true;
    const logs: string[] = [];
    const svc = service({ log: (m: string) => logs.push(m), readCertificate: async () => null });
    const result = await svc.adoptFromStalwart();
    expect(result.domains).toEqual(["cassp.example.com"]);
    expect(result.dkimRestartPending).toEqual(["cassp.example.com"]);
    expect((await readStored()).domains["cassp.example.com"]!.dkimRestartPending).toBe(true);
    expect((await svc.listDomains()).find((d) => d.name === "cassp.example.com")?.dkimRestartPending).toBe(true);
    expect((await svc.healthPlanInput("cassp.example.com")).dkimRestartPending).toBe(true);
    expect(logs.join("\n")).toContain("ativar o DKIM");
    expect(logs.join("\n")).not.toContain(ADMIN);
  });

  it("chave DKIM que já existia não reinicia o servidor", async () => {
    await service({ readCertificate: async () => null }).adoptFromStalwart();
    expect(dkimPosts).toBe(0);
    expect(applyTlsCalls).toBe(0);
  });

  it("falha ao ler a chave DKIM (500) não cria assinatura: o domínio fica de fora", async () => {
    dkimMode = "error";
    const result = await service().adoptFromStalwart();
    expect(result.domains).toEqual([]);
    expect(dkimPosts).toBe(0);
    expect(result.skipped).toContain("cassp.example.com");
  });

  it("domínio adotado: dmarcAlias coerente com a postmaster@ do Stalwart", async () => {
    principals.push({ id: 20, type: "domain", name: "semcaixa.example.com" });
    principals.push({ id: 21, type: "domain", name: "semalias.example.com" });
    principals.push(box("postmaster@semalias.example.com", ["postmaster@semalias.example.com"]));
    await service().adoptFromStalwart();
    const { domains } = await readStored();
    // dmarc@ já recebe (alias da postmaster@): marcado
    expect(domains["cassp.example.com"]!.dmarcAlias).toBe(true);
    // sem postmaster@ no Stalwart não há onde pôr o alias: marcado, para a rotina horária não falhar no log
    expect(domains["semcaixa.example.com"]!.dmarcAlias).toBe(true);
    // tem postmaster@ sem dmarc@: a rotina acrescenta o alias
    expect(domains["semalias.example.com"]!.dmarcAlias).toBeUndefined();
  });

  it("corta a lista de ignorados em 200 nomes e conta o total", async () => {
    for (let i = 0; i < 250; i += 1) principals.push(box(`Nome Ruim ${i}@envio.example.com`));
    const result = await service().adoptFromStalwart();
    expect(result.skipped).toHaveLength(200);
    expect(result.skippedTotal).toBe(250);
  });

  it("exatamente 20 000 caixas lidas e a página seguinte vazia: não avisa corte que não houve", async () => {
    pageLimitFake = true;
    const have = principals.filter((p) => p.type === "individual").length;
    for (let i = 0; i < 20_000 - have; i += 1) principals.push(box(`u${i}@envio.example.com`));
    expect(principals.filter((p) => p.type === "individual")).toHaveLength(20_000);
    const result = await service().adoptFromStalwart();
    expect(result.truncated).toBeUndefined();
  });

  it("avisa quando o Stalwart tem mais de 20 000 caixas (a lista vem cortada)", async () => {
    pageLimitFake = true;
    for (let i = 0; i < 20_001; i += 1) principals.push(box(`u${i}@envio.example.com`));
    const result = await service().adoptFromStalwart();
    expect(result.truncated).toBe(true);
  });

  it("senha certa: não reinicia o Stalwart nem repara nada", async () => {
    await service().adoptFromStalwart();
    expect(applyTlsCalls).toBe(0);
  });

  it("401 (senha do painel diferente da do servidor): repara UMA vez, repete a leitura e cadastra", async () => {
    liveSecret = "senha-antiga-do-servidor";
    const logs: string[] = [];
    const result = await service({ log: (m: string) => logs.push(m) }).adoptFromStalwart();
    expect(result.domains).toEqual(["cassp.example.com"]);
    expect(applyTlsCalls).toBe(1);
    const raw = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    expect(JSON.parse(raw).adminSecret).toBe(ADMIN);
    expect(JSON.stringify(logs)).not.toContain(ADMIN);
    expect(JSON.stringify(logs)).not.toContain("senha-antiga");
  });

  it("reparo coalescido: duas sincronizações de instâncias diferentes reiniciam o Stalwart uma só vez", async () => {
    liveSecret = "senha-antiga-do-servidor";
    const [a, b] = await Promise.all([service().adoptFromStalwart(), service().adoptFromStalwart()]);
    expect(a.domains.length + b.domains.length).toBeGreaterThan(0);
    expect(applyTlsCalls).toBe(1);
  });

  it("o reparo também falha: erro claro (o que tentou e o próximo passo), sem laço, sem segredo e sem tocar no cadastro", async () => {
    liveSecret = "senha-antiga-do-servidor";
    repairWorks = false;
    const before = await readStored();
    const err = (await service().adoptFromStalwart().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ statusCode: 409, code: "mail_auth_repair_failed" });
    expect(err.message).toMatch(/tentou regravar a configuração e reiniciar/);
    expect(err.message).not.toContain(ADMIN);
    expect(err.message).not.toContain("senha-antiga");
    expect(applyTlsCalls).toBe(1);
    const after = await readStored();
    expect(after.domains).toEqual(before.domains);
    expect(after.mailboxes).toEqual(before.mailboxes);
    const principalCalls = fetchCalls.filter((c) => c.includes("/api/principal")).length;
    expect(principalCalls).toBeLessThanOrEqual(3);
  });

  it("o reparo erra antes de terminar (ex.: falha ao reiniciar): mensagem diz que não terminou, com motivo sem segredo", async () => {
    liveSecret = "senha-antiga-do-servidor";
    vi.spyOn(MailService.prototype, "repairAdminAuth").mockRejectedValue(new Error(`falha ao reiniciar paas-stalwart: docker recusou ${ADMIN} agora`));
    const err = (await service().adoptFromStalwart().catch((e: unknown) => e)) as Error & { code: string; statusCode: number };
    expect(err).toMatchObject({ statusCode: 409, code: "mail_auth_repair_incomplete" });
    expect(err.message).toMatch(/não terminou/);
    expect(err.message).toMatch(/falha ao reiniciar paas-stalwart/);
    expect(err.message).toMatch(/Próximo passo/);
    expect(err.message).not.toContain(ADMIN);
    expect(err.message).not.toMatch(/continua recusando/);
  });

  describe("docker que ecoa a senha no stderr: erro limpo, sem segredo na resposta nem no log (os três caminhos)", () => {
    const expectClean = (err: Error & { code?: string; statusCode?: number }, logs: string[]) => {
      expect(err).toMatchObject({ statusCode: 409, code: "mail_auth_repair_incomplete" });
      expect(err.message).toMatch(/não terminou/);
      expect(err.message).not.toContain(ADMIN);
      expect(err.message.length).toBeLessThan(700);
      expect(JSON.stringify(logs)).not.toContain(ADMIN);
    };

    it("Sincronizar", async () => {
      liveSecret = "senha-antiga-do-servidor";
      dockerEchoesSecret = true;
      const logs: string[] = [];
      const err = (await service({ log: (m: string) => logs.push(m) }).adoptFromStalwart().catch((e: unknown) => e)) as Error;
      expectClean(err, logs);
    });

    it("botão Reparar agora (repairAdminAuth direto)", async () => {
      liveSecret = "senha-antiga-do-servidor";
      dockerEchoesSecret = true;
      const logs: string[] = [];
      const err = (await service({ log: (m: string) => logs.push(m) }).repairAdminAuth().catch((e: unknown) => e)) as Error;
      expectClean(err, logs);
    });

    it("subida do painel (repairOpen): o log de aviso não traz a senha", async () => {
      liveSecret = "senha-antiga-do-servidor";
      dockerEchoesSecret = true;
      const logs: string[] = [];
      const { RestoreReconciliation } = await import("../src/services/restore-reconciliation.js");
      const rec = new RestoreReconciliation({
        dataDir: dir,
        containers: { stalwart: "paas-stalwart", webmail: "paas-webmail" },
        probes: { container: async () => "running", mailAuth: async () => "mismatch", repairMailAuth: () => service({ log: (m: string) => logs.push(m) }).repairAdminAuth() },
        log: (m: string) => logs.push(m),
      });
      await rec.markPending(["mail-auth"], "panel");
      expect(await rec.repairOpen()).toBeNull();
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(logs)).not.toContain(ADMIN);
      expect(JSON.stringify(logs)).toMatch(/não terminou/);
    });
  });

  it("servidor sem resposta durante o reparo: erro de servidor inacessível, não de senha", async () => {
    liveSecret = "senha-antiga-do-servidor";
    vi.spyOn(MailService.prototype, "repairAdminAuth").mockResolvedValue("unreachable");
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ statusCode: 502, code: "mail_unreachable" });
  });

  it("reparo diz que a senha confere, mas a leitura continua recusada: erro próprio, sem reiniciar de novo", async () => {
    rejectAuth = true;
    vi.spyOn(MailService.prototype, "repairAdminAuth").mockResolvedValue("ok");
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ statusCode: 409, code: "mail_auth_still_refused" });
  });

  it("servidor parado no meio do reparo: 409 mail_server_stopped", async () => {
    rejectAuth = true;
    vi.spyOn(MailService.prototype, "repairAdminAuth").mockResolvedValue("not_running");
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ statusCode: 409, code: "mail_server_stopped" });
  });

  it("servidor parado ou nunca iniciado: 409, sem consultar nada", async () => {
    running = false;
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ statusCode: 409, code: "mail_server_stopped" });
    expect(fetchCalls).toEqual([]);
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ adminSecret: null, domains: {}, mailboxes: {}, projects: {} }));
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ code: "mail_not_initialized" });
  });
});

describe("caixa adotada, sem senha conhecida", () => {
  it("o e-mail de teste explica que falta a senha em vez de tentar entrar com senha vazia", async () => {
    const send = vi.fn();
    const svc = service({ sendMail: send });
    await svc.adoptFromStalwart();
    await expect(svc.sendTestEmail("cassp.example.com", "alguem@example.org")).rejects.toMatchObject({
      statusCode: 409,
      code: "mailbox_no_password",
    });
    await expect(svc.sendTestEmail("cassp.example.com", "alguem@example.org", "contato@cassp.example.com")).rejects.toMatchObject({
      code: "mailbox_no_password",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("os avisos do painel não saem por uma postmaster sem senha", async () => {
    const svc = service();
    await svc.adoptFromStalwart();
    // só cassp (adotado) com DNS verificado: não há senha para enviar
    const stored = await readStored();
    stored.domains["cassp.example.com"]!.lastVerify = { at: "2026-10-21T00:00:00.000Z", ok: 6, total: 6, recordsOk: true };
    delete (stored.domains as Record<string, unknown>)["envio.example.com"];
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ ...stored, adminSecret: ADMIN }));
    const readiness = await service().systemMailReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain("Trocar senha");
  });

  it("Trocar senha funciona e a caixa passa a ter senha conhecida", async () => {
    const svc = service();
    await svc.adoptFromStalwart();
    const res = await svc.changeMailboxPassword("contato@cassp.example.com", undefined, { generate: true });
    expect(res.generatedPassword).toBeTruthy();
    expect(res.mailbox.passwordUnknown).toBeUndefined();
    expect((await readStored()).mailboxes["contato@cassp.example.com"]!.password).toBe(res.generatedPassword);
  });

  it("restaurou só o e-mail: ativar o e-mail do projeto na caixa <slug>@ adotada pede a senha e a define, sem apagar nada", async () => {
    principals.push(box("loja@cassp.example.com"));
    const project = { id: "p1", slug: "loja", name: "Loja" } as unknown as Project;
    const svc = service({ projects: async () => [project] });
    await svc.adoptFromStalwart();
    // o painel novo não tem e-mail de projeto nenhum: a caixa entrou como comum
    expect((await svc.listMailboxes("cassp.example.com")).find((b) => b.id === "loja@cassp.example.com")).toMatchObject({ kind: "user" });
    fetchCalls = [];
    await expect(svc.enableProjectEmail(project, "cassp.example.com")).rejects.toMatchObject({ code: "password_required" });
    const res = await svc.enableProjectEmail(project, "cassp.example.com", { generatePassword: true });
    expect(res.generatedPassword).toBeTruthy();
    const env = await svc.envForProject(project);
    expect(env.SMTP_PASS).toBe(res.generatedPassword);
    expect(env.SMTP_USER).toBe("loja@cassp.example.com");
    const box1 = (await svc.listMailboxes("cassp.example.com")).find((b) => b.id === "loja@cassp.example.com");
    expect(box1).toMatchObject({ kind: "project", projectId: "p1" });
    expect(box1!.passwordUnknown).toBeUndefined();
    // a senha foi definida no Stalwart (PATCH), a caixa não foi criada de novo nem apagada
    expect(fetchCalls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(fetchCalls.some((c) => c.startsWith("POST") && c.endsWith("/api/principal"))).toBe(false);
    expect(fetchCalls.some((c) => c.startsWith("PATCH") && c.includes("loja%40cassp.example.com"))).toBe(true);
  });

  it("caixa adotada de outro endereço, com senha conhecida ou de outro projeto continua recusando (409)", async () => {
    principals.push(box("loja@cassp.example.com"), box("outra@cassp.example.com"));
    const project = { id: "p1", slug: "loja", name: "Loja" } as unknown as Project;
    const svc = service({ projects: async () => [project] });
    await svc.adoptFromStalwart();
    // endereço que não é o do projeto
    await expect(svc.enableProjectEmail(project, "cassp.example.com", { fromLocalPart: "outra", generatePassword: true })).rejects.toMatchObject({ code: "address_in_use" });
    // caixa com senha conhecida (postmaster@envio é do sistema; contato@ do painel antigo com senha)
    await svc.changeMailboxPassword("loja@cassp.example.com", undefined, { generate: true });
    await expect(svc.enableProjectEmail(project, "cassp.example.com", { generatePassword: true })).rejects.toMatchObject({ code: "address_in_use" });
    // outro projeto já usa a caixa
    const other = { id: "p2", slug: "loja2", name: "Loja 2" } as unknown as Project;
    await expect(svc.enableProjectEmail(other, "envio.example.com", { fromLocalPart: "postmaster", generatePassword: true })).rejects.toMatchObject({ code: "address_in_use" });
  });

  it("projeto ligado a uma caixa sem senha conhecida não recebe SMTP_PASS vazio", async () => {
    const project = { id: "p9", slug: "x", name: "X" } as unknown as Project;
    const stored = await readStored();
    stored.mailboxes["x@envio.example.com"] = { id: "x@envio.example.com", localPart: "x", domain: "envio.example.com", kind: "project", createdAt: "2026-10-20T00:00:00.000Z", password: "" };
    stored.projects["p9"] = { domain: "envio.example.com", mailbox: "x@envio.example.com", enabledAt: "2026-10-20T00:00:00.000Z" };
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ ...stored, adminSecret: ADMIN }));
    expect(await service().envForProject(project)).toEqual({});
  });
});

describe("MailService.adoptFromStalwart — nome de exibição", () => {
  it("o description válido do Stalwart vira o nome da caixa adotada; o inválido ou ausente é ignorado", async () => {
    principals = principals.map((p) => {
      if (p.name === "contato@envio.example.com") return { ...p, description: "  Contato   da Loja " };
      if (p.name === "contato@cassp.example.com") return { ...p, description: "Oi <x@example.com>" };
      return p;
    });
    await service().adoptFromStalwart();
    const stored = await readStored();
    expect(stored.mailboxes["contato@envio.example.com"]!.displayName).toBe("Contato da Loja");
    expect(stored.mailboxes["contato@cassp.example.com"]!.displayName).toBeUndefined();
    expect(stored.mailboxes["postmaster@cassp.example.com"]!.displayName).toBeUndefined();
  });
});

describe("MailService.adoptFromStalwart — nome dos projetos antigos e nomes já conhecidos", () => {
  const seedProject = async (extra: Record<string, unknown> = {}, description?: string) => {
    const file = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
    file.mailboxes["contato@envio.example.com"] = {
      id: "contato@envio.example.com", localPart: "contato", domain: "envio.example.com", kind: "project", projectId: "p1",
      createdAt: "2026-10-20T00:00:00.000Z", password: "senha-conhecida", ...extra,
    };
    file.projects = { p1: { domain: "envio.example.com", mailbox: "contato@envio.example.com", enabledAt: "2026-10-20T00:00:00.000Z", fromName: "Loja Antiga" } };
    await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify(file));
    principals = principals.map((p) => (p.name === "contato@envio.example.com" ? { ...p, ...(description !== undefined ? { description } : {}) } : p));
  };
  const patched = () => fetchBodies.filter((b) => b.includes('"field":"description"'));

  it("o Stalwart sem nome na caixa de envio do projeto antigo recebe o nome do projeto (uma vez)", async () => {
    await seedProject();
    await service().adoptFromStalwart();
    expect(patched().length).toBeGreaterThanOrEqual(1);
    expect((await readStored()).mailboxes["contato@envio.example.com"]!.displayName).toBe("Loja Antiga");
  });

  it("o Stalwart já com nome: não é sobrescrito, e o nome já conhecido do painel também não", async () => {
    await seedProject({ displayName: "Escolhido no painel" }, "Nome do backup");
    await service().adoptFromStalwart();
    expect(patched()).toEqual([]);
    expect((await readStored()).mailboxes["contato@envio.example.com"]!.displayName).toBe("Escolhido no painel");
  });
});
