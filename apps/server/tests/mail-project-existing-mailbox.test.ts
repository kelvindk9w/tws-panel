/**
 * Apagar o projeto solta o e-mail dele (a caixa e as mensagens ficam) e o
 * e-mail de um projeto pode ser ligado a uma caixa que já existe.
 *
 * StalwartClient/Manager FALSOS (sem rede nem Docker): o que se testa é a
 * orquestração do MailService.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, type Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

const calls: string[] = [];
const passwordCalls: { email: string; password: string }[] = [];
const createdCalls: string[] = [];
/** O que o Stalwart falso responde a "a senha confere?" (por caixa). */
let matchImpl: (email: string, password: string) => Promise<boolean | null> = async () => true;
let setPasswordImpl: (email: string, password: string) => Promise<void> = async () => undefined;
let aliasImpl: (email: string, alias: string) => Promise<void> = async () => undefined;
let running = true;
/** Campo de senhas de cada caixa no Stalwart falso: senha principal + senhas de app/2FA, como o real. */
const serverSecrets: Record<string, string[]> = {};
const EXTRAS = ["$app$leitor$hash", "otpauth://totp/x?secret=ABC"];

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
  class FakeStalwartClient {
    async deleteMailbox(email: string) {
      calls.push(`delete ${email}`);
    }
    /** Como o Stalwart real: PATCH set secrets=[senha] APAGA senhas de app e 2FA. */
    async setMailboxPassword(email: string, password: string) {
      await setPasswordImpl(email, password);
      passwordCalls.push({ email, password });
      serverSecrets[email] = [password];
    }
    /** Troca só o item principal e preserva as demais entradas. */
    async setMailboxMainPassword(email: string, password: string) {
      await setPasswordImpl(email, password);
      passwordCalls.push({ email, password });
      serverSecrets[email] = [password, ...(serverSecrets[email] ?? []).filter((x) => x.startsWith("$app$") || x.startsWith("otpauth://"))];
    }
    async createMailbox(email: string) {
      createdCalls.push(email);
    }
    async removeMailboxAlias(email: string, alias: string) {
      await aliasImpl(email, alias);
      calls.push(`- alias ${email} ${alias}`);
    }
    async mailboxPasswordMatches(email: string, password: string) {
      calls.push(`match ${email}`);
      return matchImpl(email, password);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");
const { StalwartApiError } = await import("@paas/mailer");

const NOW = "2026-10-01T00:00:00.000Z";
const SENHA = "senha-atual-da-caixa-1";
let dir = "";
let config: ServerConfig;
let existing: Array<{ id: string; slug: string; name: string }> = [];
const loja = { id: "p1", slug: "loja", name: "Loja Royal" } as unknown as Project;

function box(email: string, kind: "user" | "project" | "system", extra: Record<string, unknown> = {}) {
  const [localPart, domain] = email.split("@");
  return { id: email, localPart, domain, kind, createdAt: NOW, password: "senha-guardada-1", ...extra };
}

async function seed(mailboxes: Record<string, unknown>, projects: Record<string, unknown> = {}) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({
      adminSecret: "secret",
      hostname: "mail.test",
      domains: {
        "exemplo.com": { name: "exemplo.com", dkimSelector: "paas", dkimPublicKey: "x".repeat(120), dkimKeyBits: 2048, dmarcStage: "none", createdAt: NOW },
      },
      mailboxes,
      projects,
    }),
  );
}

async function stored() {
  return JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as {
    mailboxes: Record<string, Record<string, unknown>>;
    projects: Record<string, Record<string, unknown>>;
  };
}

function service(logs: string[] = []) {
  return new MailService(config, { log: (m, meta) => logs.push(m + JSON.stringify(meta ?? {})), projects: async () => existing });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-existing-"));
  calls.length = 0;
  passwordCalls.length = 0;
  createdCalls.length = 0;
  for (const k of Object.keys(serverSecrets)) delete serverSecrets[k];
  matchImpl = async () => true;
  setPasswordImpl = async () => undefined;
  aliasImpl = async () => undefined;
  running = true;
  existing = [{ id: "p1", slug: "loja", name: "Loja Royal" }];
  config = { dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null } as unknown as ServerConfig;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("apagar o projeto solta o e-mail dele", () => {
  it("releaseProjectEmail: tira o vínculo e as ligações, mantém a caixa (e a senha guardada) e não apaga nada", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, envLinks: { SMTP_SENHA: "SMTP_PASS" } } },
    );
    const svc = service();
    await svc.releaseProjectEmail("p1");
    const file = await stored();
    expect(file.projects).toEqual({});
    expect(file.mailboxes["loja@exemplo.com"]).toMatchObject({ kind: "project", password: "senha-guardada-1" });
    expect(file.mailboxes["loja@exemplo.com"]!.projectId).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect(await svc.emailProjectIds()).toEqual([]);
  });

  it("projeto sem e-mail: não faz nada", async () => {
    await seed({});
    await expect(service().releaseProjectEmail("pX")).resolves.toBeUndefined();
  });

  it("caixa de usuário que tinha virado a do projeto volta a ser de usuário (sem dono), com a senha guardada", async () => {
    await seed(
      { "contato@exemplo.com": box("contato@exemplo.com", "project", { projectId: "p1", external: true }) },
      { p1: { domain: "exemplo.com", mailbox: "contato@exemplo.com", enabledAt: NOW } },
    );
    await service().releaseProjectEmail("p1");
    const m = (await stored()).mailboxes["contato@exemplo.com"]!;
    expect(m).toMatchObject({ kind: "user", password: "senha-guardada-1" });
    expect(m.projectId).toBeUndefined();
    expect(m.external).toBeUndefined();
  });

  it("alias antigo (fromAddress) sai da caixa técnica; falha no servidor de e-mail é só log e o vínculo sai igual", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project") },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", fromAddress: "avisos@exemplo.com", enabledAt: NOW } },
    );
    aliasImpl = async () => {
      throw new Error("Stalwart fora");
    };
    const logs: string[] = [];
    const svc = service(logs);
    await expect(svc.releaseProjectEmail("p1")).resolves.toBeUndefined();
    expect((await stored()).projects).toEqual({});
    expect(logs.join(" ")).toContain("loja@exemplo.com");
  });

  it("recriar o projeto no mesmo endereço: a caixa solta é reaproveitada sem apagar nada (pede senha nova)", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW } },
    );
    const svc = service();
    await svc.releaseProjectEmail("p1");
    const novo = { id: "p9", slug: "loja", name: "Loja Nova" } as unknown as Project;
    existing = [{ id: "p9", slug: "loja", name: "Loja Nova" }];
    await expect(svc.enableProjectEmail(novo, "exemplo.com")).rejects.toMatchObject({ code: "password_required" });
    await svc.enableProjectEmail(novo, "exemplo.com", { password: "senha-nova-forte-1" });
    expect(createdCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect((await stored()).mailboxes["loja@exemplo.com"]).toMatchObject({ projectId: "p9", password: "senha-nova-forte-1" });
  });
});

describe("registro órfão de projeto apagado antes da correção", () => {
  const orphans = () =>
    seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "pMorto" }) },
      { pMorto: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, envLinks: { X: "SMTP_HOST" } } },
    );

  it("o endereço fica livre para o projeto novo e o órfão é limpo (a caixa fica)", async () => {
    await orphans();
    const svc = service();
    await svc.enableProjectEmail(loja, "exemplo.com", { password: "senha-nova-forte-1" });
    const file = await stored();
    expect(Object.keys(file.projects)).toEqual(["p1"]);
    expect(file.projects.p1).toMatchObject({ mailbox: "loja@exemplo.com" });
    expect(createdCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });

  it("a listagem solta o dono morto da caixa", async () => {
    await orphans();
    const list = await service().listMailboxes("exemplo.com");
    expect(list[0]!.projectId).toBeUndefined();
    expect((await stored()).projects).toEqual({});
  });

  it("projeto que EXISTE continua dono (não é órfão)", async () => {
    await seed({ "loja@exemplo.com": box("loja@exemplo.com", "project") }, { p2: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW } });
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "outra", name: "Outra" },
    ];
    await expect(service().enableProjectEmail(loja, "exemplo.com", { password: SENHA })).rejects.toMatchObject({ code: "address_in_use" });
  });

  it("sem a lista de projetos (ou ela falha): nada é considerado órfão", async () => {
    await orphans();
    const semLista = new MailService(config);
    await expect(semLista.enableProjectEmail(loja, "exemplo.com", { password: SENHA })).rejects.toMatchObject({ code: "address_in_use" });
    const falha = new MailService(config, {
      projects: async () => {
        throw new Error("x");
      },
    });
    await expect(falha.enableProjectEmail(loja, "exemplo.com", { password: SENHA })).rejects.toMatchObject({ code: "address_in_use" });
    expect(Object.keys((await stored()).projects)).toEqual(["pMorto"]);
  });
});

describe("conectar o e-mail do projeto a uma caixa que já existe", () => {
  const connect = (svc: InstanceType<typeof MailService>, local: string, opts: Record<string, unknown>) =>
    svc.connectExistingMailbox(loja, "exemplo.com", local, opts as never);

  it("lista as caixas usáveis: usuário e projeto sem uso; nunca sistema, postmaster/abuse/dmarc, de outro projeto nem a atual", async () => {
    await seed(
      {
        "contato@exemplo.com": box("contato@exemplo.com", "user"),
        "adotada@exemplo.com": box("adotada@exemplo.com", "user", { password: "" }),
        "solta@exemplo.com": box("solta@exemplo.com", "project"),
        "postmaster@exemplo.com": box("postmaster@exemplo.com", "system"),
        "abuse@exemplo.com": box("abuse@exemplo.com", "user"),
        "dmarc@exemplo.com": box("dmarc@exemplo.com", "user"),
        "dela@exemplo.com": box("dela@exemplo.com", "project"),
        "dono@exemplo.com": box("dono@exemplo.com", "user", { projectId: "p2" }),
        "morto@exemplo.com": box("morto@exemplo.com", "user", { projectId: "pMorto" }),
      },
      { p2: { domain: "exemplo.com", mailbox: "dela@exemplo.com", enabledAt: NOW } },
    );
    existing = [
      { id: "p1", slug: "loja", name: "Loja" },
      { id: "p2", slug: "outra", name: "Outra" },
    ];
    const list = await service().listUsableMailboxes(loja, "exemplo.com");
    // "dono@" foi criada na aba Caixas do p2 (que existe): é dele; "morto@" tinha dono que não existe mais
    expect(list.map((m) => m.address).sort()).toEqual(["adotada@exemplo.com", "contato@exemplo.com", "morto@exemplo.com", "solta@exemplo.com"]);
    expect(list.find((m) => m.address === "adotada@exemplo.com")).toMatchObject({ passwordKnown: false });
    expect(list.find((m) => m.address === "contato@exemplo.com")).toMatchObject({ passwordKnown: true, kind: "user" });
    expect(JSON.stringify(list)).not.toContain("senha-guardada-1");
  });

  it("domínio sem caixas: lista vazia; domínio desconhecido: 404", async () => {
    await seed({});
    expect(await service().listUsableMailboxes(loja, "exemplo.com")).toEqual([]);
    await expect(service().listUsableMailboxes(loja, "nao.com")).rejects.toMatchObject({ statusCode: 404, code: "domain_not_found" });
  });

  it("senha informada: confere sem tentar login, guarda, a caixa vira a do projeto e nada é criado nem apagado", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { password: "" }) });
    const svc = service();
    const res = await connect(svc, "contato", { mode: "current_password", password: SENHA, fromName: "Contato TWS" });
    expect(res.passwordVerified).toBe(true);
    expect(res.generatedPassword).toBeUndefined();
    expect(res.email).toMatchObject({ mailbox: "contato@exemplo.com", mailFrom: "contato@exemplo.com", fromName: "Contato TWS" });
    expect(createdCalls).toEqual([]);
    expect(passwordCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect((await stored()).mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "project", projectId: "p1", external: true, password: SENHA });
    expect((await svc.envForProject(loja)).SMTP_PASS).toBe(SENHA);
    expect(JSON.stringify(res)).not.toContain(SENHA);
  });

  it("senha informada errada: 400, nada muda", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    matchImpl = async () => false;
    await expect(connect(service(), "contato", { mode: "current_password", password: SENHA })).rejects.toMatchObject({
      statusCode: 400,
      code: "mailbox_password_mismatch",
    });
    const file = await stored();
    expect(file.projects).toEqual({});
    expect(file.mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "user", password: "senha-guardada-1" });
  });

  it("não dá para conferir e a caixa é de usuário: NÃO aceita (o Sincronizar gravaria a senha errada); nada muda", async () => {
    for (const impl of [
      async () => null,
      async () => {
        throw new StalwartApiError(500, "boom");
      },
    ]) {
      await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
      matchImpl = impl;
      for (const mode of ["current_password", "keep_password"]) {
        await expect(connect(service(), "contato", { mode, password: SENHA })).rejects.toMatchObject({ statusCode: 409, code: "password_unverifiable" });
      }
      const file = await stored();
      expect(file.projects).toEqual({});
      expect(file.mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "user", password: "senha-guardada-1" });
    }
  });

  it("não dá para conferir mas a caixa foi criada pelo painel (de projeto): aceita e diz que não foi verificada", async () => {
    await seed({ "solta@exemplo.com": box("solta@exemplo.com", "project") });
    matchImpl = async () => null;
    const res = await connect(service(), "solta", { mode: "keep_password" });
    expect(res.passwordVerified).toBe(false);
  });

  it("a conferência é UMA só (nunca em laço)", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    matchImpl = async () => false;
    await connect(service(), "contato", { mode: "current_password", password: SENHA }).catch(() => undefined);
    expect(calls.filter((c) => c.startsWith("match"))).toHaveLength(1);
  });

  it("trocar a senha: o painel gera, aplica no servidor, guarda e devolve uma vez", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { password: "" }) });
    const svc = service();
    const res = await connect(svc, "contato", { mode: "replace_password" });
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{23}$/);
    expect(passwordCalls).toEqual([{ email: "contato@exemplo.com", password: res.generatedPassword }]);
    expect((await svc.envForProject(loja)).SMTP_PASS).toBe(res.generatedPassword);
    expect(JSON.stringify(await svc.projectEmailConfig("p1"))).not.toContain(res.generatedPassword!);
  });

  it("manter a senha que o painel já guarda: confere e usa", async () => {
    await seed({ "solta@exemplo.com": box("solta@exemplo.com", "project") });
    const svc = service();
    const res = await connect(svc, "solta", { mode: "keep_password" });
    expect(res.passwordVerified).toBe(true);
    expect((await svc.envForProject(loja)).SMTP_PASS).toBe("senha-guardada-1");
    expect((await stored()).mailboxes["solta@exemplo.com"]).toMatchObject({ projectId: "p1" });
  });

  it("manter a senha: sem senha guardada 400; guardada desatualizada 409", async () => {
    await seed({
      "contato@exemplo.com": box("contato@exemplo.com", "user", { password: "" }),
      "velha@exemplo.com": box("velha@exemplo.com", "user"),
    });
    await expect(connect(service(), "contato", { mode: "keep_password" })).rejects.toMatchObject({ statusCode: 400, code: "password_required" });
    matchImpl = async () => false;
    await expect(connect(service(), "velha", { mode: "keep_password" })).rejects.toMatchObject({ statusCode: 409, code: "stored_password_stale" });
  });

  it("senha fraca/curta: weak_password antes de falar com o servidor", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    await expect(connect(service(), "contato", { mode: "current_password", password: "curta" })).rejects.toMatchObject({ code: "weak_password" });
    await expect(connect(service(), "contato", { mode: "current_password" })).rejects.toMatchObject({ code: "weak_password" });
    expect(calls).toEqual([]);
  });

  it("caixa de OUTRO projeto (registro de e-mail ou criada na aba Caixas dele): 409 dizendo qual; nunca com senha", async () => {
    await seed(
      { "dela@exemplo.com": box("dela@exemplo.com", "project"), "dono@exemplo.com": box("dono@exemplo.com", "user", { projectId: "p2" }) },
      { p2: { domain: "exemplo.com", mailbox: "dela@exemplo.com", enabledAt: NOW } },
    );
    existing = [
      { id: "p1", slug: "loja", name: "Loja" },
      { id: "p2", slug: "outra", name: "Projeto Outra" },
    ];
    for (const local of ["dela", "dono"]) {
      const err = await connect(service(), local, { mode: "current_password", password: SENHA }).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 409, code: "mailbox_taken_by_project" });
      expect((err as Error).message).toContain("Projeto Outra");
      expect((err as Error).message).not.toContain(SENHA);
    }
    expect(calls).toEqual([]);
  });

  it("postmaster/abuse/dmarc e caixa de sistema: recusados; caixa que não existe: 404", async () => {
    await seed({ "postmaster@exemplo.com": box("postmaster@exemplo.com", "system"), "abuse@exemplo.com": box("abuse@exemplo.com", "user") });
    for (const local of ["postmaster", "abuse", "dmarc"]) {
      await expect(connect(service(), local, { mode: "current_password", password: SENHA })).rejects.toMatchObject({ statusCode: 409, code: "address_in_use" });
    }
    await expect(connect(service(), "fantasma", { mode: "current_password", password: SENHA })).rejects.toMatchObject({ statusCode: 404, code: "mailbox_not_found" });
    expect(calls).toEqual([]);
  });

  it("servidor de e-mail parado: 409 mail_server_stopped e nada muda", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    running = false;
    await expect(connect(service(), "contato", { mode: "current_password", password: SENHA })).rejects.toMatchObject({ code: "mail_server_stopped" });
    expect((await stored()).projects).toEqual({});
  });

  it("a caixa sumiu do servidor durante a operação: 409 mailbox_gone e nada muda", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    matchImpl = async () => {
      throw new StalwartApiError(404, "sumiu");
    };
    await expect(connect(service(), "contato", { mode: "current_password", password: SENHA })).rejects.toMatchObject({ statusCode: 409, code: "mailbox_gone" });
    setPasswordImpl = async () => {
      throw new StalwartApiError(404, "sumiu");
    };
    await expect(connect(service(), "contato", { mode: "replace_password" })).rejects.toMatchObject({ code: "mailbox_gone" });
    const file = await stored();
    expect(file.projects).toEqual({});
    expect(file.mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "user", password: "senha-guardada-1" });
  });

  it("falha no meio (trocar a senha no servidor): reverte tudo, a caixa não fica meio assumida", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    setPasswordImpl = async () => {
      throw new Error("Stalwart 500");
    };
    const svc = service();
    await expect(connect(svc, "contato", { mode: "replace_password" })).rejects.toThrow("Stalwart 500");
    const file = await stored();
    expect(file.projects).toEqual({});
    expect(file.mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "user", password: "senha-guardada-1" });
    expect(file.mailboxes["contato@exemplo.com"]!.projectId).toBeUndefined();
    expect(file.mailboxes["contato@exemplo.com"]!.external).toBeUndefined();
    expect((await svc.projectEmailConfig("p1")).enabled).toBe(false);
  });

  it("duas pessoas na mesma caixa ao mesmo tempo: só um projeto fica com ela", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    existing = [
      { id: "p1", slug: "loja", name: "Loja" },
      { id: "p2", slug: "outra", name: "Outra" },
    ];
    const outra = { id: "p2", slug: "outra", name: "Outra" } as unknown as Project;
    const svc = service();
    const results = await Promise.allSettled([
      connect(svc, "contato", { mode: "current_password", password: SENHA }),
      svc.connectExistingMailbox(outra, "exemplo.com", "contato", { mode: "current_password", password: SENHA }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(Object.keys((await stored()).projects)).toHaveLength(1);
  });

  it("trocar para outra caixa: a que já existia antes NÃO é apagada; a criada pelo painel para o projeto continua sendo", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user"), "outra@exemplo.com": box("outra@exemplo.com", "user") });
    const svc = service();
    await connect(svc, "contato", { mode: "current_password", password: SENHA });
    await connect(svc, "outra", { mode: "current_password", password: SENHA });
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect((await stored()).mailboxes["contato@exemplo.com"]).toMatchObject({ kind: "user" });
    expect((await stored()).mailboxes["contato@exemplo.com"]!.projectId).toBeUndefined();

    await seed({ "livre@exemplo.com": box("livre@exemplo.com", "user") });
    const svc2 = service();
    await svc2.enableProjectEmail(loja, "exemplo.com", { fromLocalPart: "nova", password: "senha-nova-forte-1" });
    await svc2.connectExistingMailbox(loja, "exemplo.com", "livre", { mode: "current_password", password: SENHA });
    expect(calls).toContain("delete nova@exemplo.com");
  });

  it("nenhuma senha vai para o log, nem quando a conferência falha", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const logs: string[] = [];
    matchImpl = async () => {
      throw new Error(`falhou com ${SENHA}`);
    };
    await connect(service(logs), "contato", { mode: "current_password", password: SENHA }).catch(() => undefined);
    expect(logs.join(" ")).not.toContain(SENHA);
  });
});

describe("revisão: soltar a caixa, lista de projetos duvidosa e órfãos", () => {
  const connect = (svc: InstanceType<typeof MailService>, project: Project, opts: Record<string, unknown>) =>
    svc.connectExistingMailbox(project, "exemplo.com", "contato", opts as never);
  const blog = { id: "p2", slug: "blog", name: "Blog" } as unknown as Project;

  it("Desativar o e-mail do outro projeto libera a caixa de verdade (como a mensagem manda)", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const svc = service();
    await connect(svc, blog, { mode: "keep_password" });
    await expect(connect(svc, loja, { mode: "keep_password" })).rejects.toMatchObject({ code: "mailbox_taken_by_project" });
    await svc.disableProjectEmail("p2");
    expect((await svc.listUsableMailboxes(loja, "exemplo.com")).map((m) => m.address)).toContain("contato@exemplo.com");
    await expect(connect(svc, loja, { mode: "keep_password" })).resolves.toBeTruthy();
  });

  it("Desativar solta a caixa adotada: volta a ser de usuário, sem dono, e deixa de ser candidata ao realinhamento", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const svc = service();
    await connect(svc, loja, { mode: "keep_password" });
    await svc.disableProjectEmail("p1");
    const m = (await stored()).mailboxes["contato@exemplo.com"]!;
    expect({ kind: m.kind, projectId: m.projectId ?? null, external: m.external ?? null }).toEqual({ kind: "user", projectId: null, external: null });
  });

  it("Desativar a caixa que o painel criou para o projeto: não apaga e segue sendo dele (outro projeto não a leva)", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed({});
    const svc = service();
    await svc.enableProjectEmail(loja, "exemplo.com", { fromLocalPart: "contato", password: "senha-nova-forte-1" });
    await svc.disableProjectEmail("p1");
    expect(calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    await expect(connect(svc, blog, { mode: "keep_password" })).rejects.toMatchObject({ code: "mailbox_taken_by_project" });
    await expect(connect(svc, loja, { mode: "keep_password" })).resolves.toBeTruthy();
  });

  it("lista de projetos vazia com vínculos registrados vale como 'não sei': nada é solto", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, envLinks: { SMTP_SENHA: "SMTP_PASS" } } },
    );
    existing = [];
    const svc = service();
    await svc.listMailboxes("exemplo.com");
    await expect(svc.enableProjectEmail(loja, "exemplo.com", { password: SENHA })).resolves.toBeTruthy();
    const file = await stored();
    expect(file.projects.p1).toMatchObject({ envLinks: { SMTP_SENHA: "SMTP_PASS" } });
  });

  it("lista com projetos vivos: o filtro de órfãos solta só os mortos e preserva vínculo, envLinks e dono dos vivos", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed(
      {
        "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }),
        "blog@exemplo.com": box("blog@exemplo.com", "project", { projectId: "p2" }),
        "morto@exemplo.com": box("morto@exemplo.com", "project", { projectId: "pMorto" }),
      },
      {
        p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, envLinks: { A: "SMTP_HOST" } },
        pMorto: { domain: "exemplo.com", mailbox: "morto@exemplo.com", enabledAt: NOW },
      },
    );
    await service().listMailboxes("exemplo.com");
    const file = await stored();
    expect(Object.keys(file.projects)).toEqual(["p1"]);
    expect(file.projects.p1).toMatchObject({ envLinks: { A: "SMTP_HOST" } });
    expect(file.mailboxes["loja@exemplo.com"]!.projectId).toBe("p1");
    expect(file.mailboxes["blog@exemplo.com"]!.projectId).toBe("p2");
    expect(file.mailboxes["morto@exemplo.com"]!.projectId).toBeUndefined();
  });

  it("caixa de sistema com parte local comum também é recusada (409 address_in_use)", async () => {
    await seed({ "painel@exemplo.com": box("painel@exemplo.com", "system") });
    await expect(
      loja && service().connectExistingMailbox(loja, "exemplo.com", "painel", { mode: "keep_password" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "address_in_use" });
  });
});

describe("senhas de app e 2FA sobrevivem, e a caixa de outro projeto não é levada", () => {
  const connect = (svc: InstanceType<typeof MailService>, project: Project, local: string, opts: Record<string, unknown>) =>
    svc.connectExistingMailbox(project, "exemplo.com", local, opts as never);
  const blog = { id: "p2", slug: "blog", name: "Blog" } as unknown as Project;

  it("trocar por gerada preserva $app$ e otpauth", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    serverSecrets["contato@exemplo.com"] = ["velha", ...EXTRAS];
    const res = await connect(service(), loja, "contato", { mode: "replace_password" });
    expect(serverSecrets["contato@exemplo.com"]).toEqual([res.generatedPassword, ...EXTRAS]);
  });

  it("Trocar senha (changeMailboxPassword) preserva $app$ e otpauth", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    serverSecrets["contato@exemplo.com"] = ["velha", ...EXTRAS];
    await service().changeMailboxPassword("contato@exemplo.com", "senha-nova-forte-1");
    expect(serverSecrets["contato@exemplo.com"]).toEqual(["senha-nova-forte-1", ...EXTRAS]);
  });

  it("assumir a caixa adotada <slug>@ (ativar com senha) preserva $app$ e otpauth", async () => {
    await seed({ "loja@exemplo.com": box("loja@exemplo.com", "user", { password: "" }) });
    serverSecrets["loja@exemplo.com"] = ["velha", ...EXTRAS];
    await service().enableProjectEmail(loja, "exemplo.com", { password: "senha-nova-forte-1" });
    expect(serverSecrets["loja@exemplo.com"]).toEqual(["senha-nova-forte-1", ...EXTRAS]);
  });

  it("A cria uma caixa na aba Caixas: B não a vê nem a assume (409); A a assume e, ao desativar, ela volta a ser da aba Caixas de A", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed({});
    const svc = service();
    await svc.createMailbox("exemplo.com", "suporte", "senha-suporte-forte-1", { projectId: "p1" });
    expect((await svc.listUsableMailboxes(blog, "exemplo.com")).map((m) => m.address)).not.toContain("suporte@exemplo.com");
    const err = await connect(svc, blog, "suporte", { mode: "keep_password" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "mailbox_taken_by_project" });
    expect((err as Error).message).toContain("Loja Royal");
    // nada mudou para A
    expect((await stored()).mailboxes["suporte@exemplo.com"]).toMatchObject({ kind: "user", projectId: "p1", password: "senha-suporte-forte-1" });
    expect((await svc.listMailboxes("exemplo.com", { projectId: "p1" })).map((m) => m.id)).toEqual(["suporte@exemplo.com"]);
    // A usa a própria caixa e depois desativa: volta à aba Caixas de A, como usuário
    await connect(svc, loja, "suporte", { mode: "keep_password" });
    await svc.disableProjectEmail("p1");
    const m = (await stored()).mailboxes["suporte@exemplo.com"]!;
    expect({ kind: m.kind, projectId: m.projectId }).toEqual({ kind: "user", projectId: "p1" });
    expect(m.ownerBefore).toBeUndefined();
    expect((await svc.listMailboxes("exemplo.com", { projectId: "p1" })).map((x) => x.id)).toEqual(["suporte@exemplo.com"]);
    expect(JSON.stringify(await svc.listMailboxes("exemplo.com"))).not.toContain("ownerBefore");
  });

  it("caixa sem dono adotada por B e depois solta (Desativar): continua sem dono", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const svc = service();
    await connect(svc, blog, "contato", { mode: "keep_password" });
    await svc.disableProjectEmail("p2");
    expect((await stored()).mailboxes["contato@exemplo.com"]!.projectId).toBeUndefined();
    await expect(connect(svc, loja, "contato", { mode: "keep_password" })).resolves.toBeTruthy();
  });

  it("caixa com dono sem poder saber se ele existe (lista indisponível): recusa", async () => {
    await seed({ "suporte@exemplo.com": box("suporte@exemplo.com", "user", { projectId: "p2" }) });
    const semLista = new MailService(config);
    const err = await semLista.connectExistingMailbox(loja, "exemplo.com", "suporte", { mode: "keep_password" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "mailbox_taken_by_project" });
    // sem nome conhecido, nunca o id interno
    expect((err as Error).message).toContain("a outro projeto");
    expect((err as Error).message).not.toContain("p2");
  });

  it("lista de projetos vazia: caixas com dono (e sem registro de e-mail) também valem como 'não sei'", async () => {
    await seed({ "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) });
    existing = [];
    await service().listMailboxes("exemplo.com");
    expect((await stored()).mailboxes["loja@exemplo.com"]!.projectId).toBe("p1");
  });

  it("'Criar uma caixa nova' no endereço da caixa criada para A (e desativada) também é recusado, sem trocar a senha de A", async () => {
    existing = [
      { id: "p1", slug: "loja", name: "Loja Royal" },
      { id: "p2", slug: "blog", name: "Blog" },
    ];
    await seed({});
    const svc = service();
    await svc.enableProjectEmail(loja, "exemplo.com", { fromLocalPart: "loja-a", password: "senha-da-loja-forte-1" });
    await svc.disableProjectEmail("p1");
    passwordCalls.length = 0;
    const err = await svc.enableProjectEmail(blog, "exemplo.com", { fromLocalPart: "loja-a", password: "senha-do-blog-forte-1" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "mailbox_taken_by_project" });
    expect((err as Error).message).toContain("Loja Royal");
    expect((err as Error).message).toContain("foi criada para ele, no e-mail ou na aba Caixas dele");
    expect(passwordCalls).toEqual([]);
    expect((await stored()).mailboxes["loja-a@exemplo.com"]).toMatchObject({ projectId: "p1", password: "senha-da-loja-forte-1" });
    // o próprio A reativa normalmente
    await expect(svc.enableProjectEmail(loja, "exemplo.com", { fromLocalPart: "loja-a", password: "outra-senha-forte-1" })).resolves.toBeTruthy();
  });

  it("campos internos (external, ownerBefore, senha) não saem por nenhuma resposta do serviço", async () => {
    existing = [{ id: "p1", slug: "loja", name: "Loja Royal" }];
    await seed({ "suporte@exemplo.com": box("suporte@exemplo.com", "user", { projectId: "p1" }) });
    const svc = service();
    const res = await connect(svc, loja, "suporte", { mode: "keep_password" });
    expect((await stored()).mailboxes["suporte@exemplo.com"]).toMatchObject({ external: true, ownerBefore: "p1" });
    const out = JSON.stringify([res, await svc.listMailboxes("exemplo.com"), await svc.listUsableMailboxes(loja, "exemplo.com"), await svc.changeMailboxPassword("suporte@exemplo.com", "senha-nova-forte-1")]);
    for (const leak of ["external", "ownerBefore", "senha-guardada-1", "senha-nova-forte-1"]) expect(out).not.toContain(leak);
  });
});
