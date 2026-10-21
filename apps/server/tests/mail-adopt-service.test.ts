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

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
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

function box(name: string, emails: string[] = [name]) {
  return { id: 1, type: "individual", name, secrets: [HASH], emails, roles: ["user"], quota: 0 };
}

function fakeStalwart() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
      const auth = (init?.headers as Record<string, string>).authorization;
      if (rejectAuth || auth !== `Basic ${Buffer.from(`admin:${ADMIN}`).toString("base64")}`) {
        return new Response(`{"error":"other","details":"You have to authenticate first"}`, { status: 401 });
      }
      const u = new URL(url);
      if (u.pathname === "/api/principal") {
        const type = u.searchParams.get("type");
        const items = principals.filter((p) => p.type === type);
        return new Response(JSON.stringify({ data: { items, total: items.length } }), { status: 200 });
      }
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
  rejectAuth = false;
  fetchCalls = [];
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
    expect(await svc.adoptFromStalwart()).toEqual({ domains: [], mailboxes: [], skipped: [] });
    expect(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).toBe(before);
    // outra instância (painel reiniciado) também não duplica
    expect(await service().adoptFromStalwart()).toEqual({ domains: [], mailboxes: [], skipped: [] });
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
    const svc = service({ projects: async () => [{ id: "p1", slug: "loja", name: "Loja" } as unknown as Project] });
    await svc.adoptFromStalwart();
    const boxes = await svc.listMailboxes("cassp.example.com", { projectId: "p1" });
    expect(boxes.map((b) => [b.id, b.kind, b.projectId])).toEqual([["loja@cassp.example.com", "project", "p1"]]);
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

  it("401 do Stalwart: erro com o status 401 e o cadastro intacto", async () => {
    rejectAuth = true;
    const before = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    await expect(service().adoptFromStalwart()).rejects.toMatchObject({ status: 401 });
    expect(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).toBe(before);
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

  it("ativar o e-mail de um projeto numa caixa adotada pede a senha e a define", async () => {
    principals.push(box("loja@cassp.example.com"));
    const project = { id: "p1", slug: "loja", name: "Loja" } as unknown as Project;
    const svc = service({ projects: async () => [project] });
    await svc.adoptFromStalwart();
    await expect(svc.enableProjectEmail(project, "cassp.example.com")).rejects.toMatchObject({ code: "password_required" });
    const res = await svc.enableProjectEmail(project, "cassp.example.com", { generatePassword: true });
    const env = await svc.envForProject(project);
    expect(env.SMTP_PASS).toBe(res.generatedPassword);
    expect(env.SMTP_USER).toBe("loja@cassp.example.com");
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
