/**
 * Nome de exibição das caixas: criar com/sem nome, alterar, validar (CRLF, controle, UTF-8, limite), caixa de
 * outro projeto, caixa de envio do projeto (MAIL_FROM_NAME), auditoria, webmail e adoção.
 *
 * StalwartClient/Manager FALSOS (sem rede nem Docker): o que se testa é a orquestração do MailService.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, MAILBOX_DISPLAY_NAME_MAX, type Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { removeDir } from "./helpers/tmp.js";

const created: { email: string; extra: string[] | undefined; name: string | undefined }[] = [];
const nameCalls: { email: string; name: string }[] = [];
const passwordCalls: string[] = [];
let setNameImpl: (email: string, name: string) => Promise<void> = async () => undefined;
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
  class FakeStalwartClient {
    async createMailbox(email: string, _password: string, extra?: string[], name?: string) {
      created.push({ email, extra, name });
    }
    async setMailboxDisplayName(email: string, name: string) {
      await setNameImpl(email, name);
      nameCalls.push({ email, name });
    }
    async setMailboxPassword(email: string) {
      passwordCalls.push(email);
    }
    async setMailboxMainPassword(email: string) {
      passwordCalls.push(email);
    }
    async removeMailboxAlias() {}
    async mailboxPasswordMatches() {
      return true;
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

const NOW = "2026-10-01T00:00:00.000Z";
const SENHA = "senha-forte-da-pessoa-1";
let dir = "";
let config: ServerConfig;
let audits: { action: string; target?: string | null; detail: string }[] = [];
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

function service() {
  return new MailService(config, {
    audit: { record: async (a) => void audits.push(a) },
    projects: async () => [{ id: "p1", slug: "loja", name: "Loja Royal" }],
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-dname-"));
  created.length = 0;
  nameCalls.length = 0;
  passwordCalls.length = 0;
  audits = [];
  setNameImpl = async () => undefined;
  running = true;
  config = { dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null } as unknown as ServerConfig;
});
afterEach(async () => {
  await removeDir(dir);
});

describe("criar caixa", () => {
  it("com nome: vai ao Stalwart (description), é guardado e aparece na lista; espaços sobrando são limpos", async () => {
    await seed({});
    const svc = service();
    const { mailbox } = await svc.createMailbox("exemplo.com", "contato", SENHA, { displayName: "  Loja   Exemplo - Atendimento " });
    expect(created).toEqual([{ email: "contato@exemplo.com", extra: [], name: "Loja Exemplo - Atendimento" }]);
    expect(mailbox.displayName).toBe("Loja Exemplo - Atendimento");
    expect((await svc.listMailboxes("exemplo.com"))[0]!.displayName).toBe("Loja Exemplo - Atendimento");
    expect((await stored()).mailboxes["contato@exemplo.com"]!.displayName).toBe("Loja Exemplo - Atendimento");
  });

  it("sem nome (ou só espaços): o Stalwart não recebe description e nada é guardado", async () => {
    await seed({});
    const svc = service();
    await svc.createMailbox("exemplo.com", "a", SENHA);
    await svc.createMailbox("exemplo.com", "b", SENHA, { displayName: "   " });
    expect(created.map((c) => c.name)).toEqual([undefined, undefined]);
    expect((await stored()).mailboxes["b@exemplo.com"]!.displayName).toBeUndefined();
  });

  it("aceita UTF-8 (acento, CJK, emoji) e o limite exato de 80 caracteres", async () => {
    await seed({});
    const svc = service();
    await svc.createMailbox("exemplo.com", "a", SENHA, { displayName: "Atendimento Ação 日本 😀" });
    await svc.createMailbox("exemplo.com", "b", SENHA, { displayName: "é".repeat(MAILBOX_DISPLAY_NAME_MAX) });
    expect(created[0]!.name).toBe("Atendimento Ação 日本 😀");
    expect(created[1]!.name).toHaveLength(MAILBOX_DISPLAY_NAME_MAX);
  });

  it.each([
    ["CRLF", "Loja\r\nBcc: x@evil.test"],
    ["quebra de linha", "Loja\nBcc: x@evil.test"],
    ["TAB", "Loja\tExemplo"],
    ["NUL", "Loja\u0000"],
    ["CR no começo (o trim levaria embora)", "\rLoja"],
    ["separador de linha Unicode", "Loja Exemplo"],
    ["marca de direção", "Loja‮Exemplo"],
    ["< >", "Loja <x@evil.test>"],
    ["aspas", 'Loja "Exemplo"'],
    ["barra invertida", "Loja\\Exemplo"],
    ["acima do limite", "x".repeat(MAILBOX_DISPLAY_NAME_MAX + 1)],
  ])("recusa nome com %s (400) sem criar nada", async (_why, name) => {
    await seed({});
    await expect(service().createMailbox("exemplo.com", "contato", SENHA, { displayName: name })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_display_name",
    });
    expect(created).toEqual([]);
    expect(Object.keys((await stored()).mailboxes)).toEqual([]);
  });
});

describe("alterar o nome de exibição", () => {
  it("caixa comum: grava no Stalwart e no cadastro, audita sem o valor e não mexe em senha nem em outros dados", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { displayName: "Antigo" }) });
    const res = await service().setMailboxDisplayName("contato@exemplo.com", "Novo Nome");
    expect(nameCalls).toEqual([{ email: "contato@exemplo.com", name: "Novo Nome" }]);
    expect(passwordCalls).toEqual([]);
    expect(res.mailbox).toMatchObject({ id: "contato@exemplo.com", displayName: "Novo Nome" });
    expect(res.mailbox).not.toHaveProperty("password");
    expect(res.projectEmail).toBeUndefined();
    const file = await stored();
    expect(file.mailboxes["contato@exemplo.com"]).toMatchObject({ displayName: "Novo Nome", password: "senha-guardada-1", kind: "user", createdAt: NOW });
    expect(audits).toEqual([
      { action: "mail.mailbox.display-name", target: "contato@exemplo.com", detail: "Nome de exibição da caixa de e-mail contato@exemplo.com alterado." },
    ]);
    expect(JSON.stringify(audits)).not.toContain("Novo Nome");
  });

  it("vazio remove o nome (Stalwart recebe texto vazio) e audita a remoção", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { displayName: "Antigo" }) });
    const res = await service().setMailboxDisplayName("contato@exemplo.com", "  ");
    expect(nameCalls).toEqual([{ email: "contato@exemplo.com", name: "" }]);
    expect(res.mailbox.displayName).toBeUndefined();
    expect((await stored()).mailboxes["contato@exemplo.com"]!.displayName).toBeUndefined();
    expect(audits[0]!.detail).toContain("removido");
  });

  it("id em maiúsculas e URL-encoded acha a caixa", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const res = await service().setMailboxDisplayName("Contato%40Exemplo.com", "Contato");
    expect(res.mailbox.id).toBe("contato@exemplo.com");
  });

  it("caixa inexistente: 404; nome inválido: 400 antes de qualquer coisa", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    const svc = service();
    await expect(svc.setMailboxDisplayName("nada@exemplo.com", "X")).rejects.toMatchObject({ statusCode: 404, code: "mailbox_not_found" });
    await expect(svc.setMailboxDisplayName("contato@exemplo.com", "Oi\r\nBcc: a@b.c")).rejects.toMatchObject({ statusCode: 400, code: "invalid_display_name" });
    expect(nameCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("servidor de e-mail parado: recusa e não grava", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user") });
    running = false;
    await expect(service().setMailboxDisplayName("contato@exemplo.com", "X")).rejects.toBeTruthy();
    expect((await stored()).mailboxes["contato@exemplo.com"]!.displayName).toBeUndefined();
  });

  it("falha do Stalwart: o cadastro não muda e nada é auditado", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { displayName: "Antigo" }) });
    setNameImpl = async () => {
      throw new Error("Stalwart fora");
    };
    await expect(service().setMailboxDisplayName("contato@exemplo.com", "Novo")).rejects.toThrow("Stalwart fora");
    expect((await stored()).mailboxes["contato@exemplo.com"]!.displayName).toBe("Antigo");
    expect(audits).toEqual([]);
  });

  it("caixa de sistema (postmaster@) também pode ter nome", async () => {
    await seed({ "postmaster@exemplo.com": box("postmaster@exemplo.com", "system") });
    const res = await service().setMailboxDisplayName("postmaster@exemplo.com", "Postmaster");
    expect(res.mailbox.displayName).toBe("Postmaster");
  });

  it("caixa sem senha conhecida continua marcada como tal na resposta", async () => {
    await seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", { password: "" }) });
    const res = await service().setMailboxDisplayName("contato@exemplo.com", "Contato");
    expect(res.mailbox.passwordUnknown).toBe(true);
  });
});

describe("escopo do projeto", () => {
  it("a aba do projeto edita a caixa extra dele", async () => {
    await seed({ "suporte@exemplo.com": box("suporte@exemplo.com", "user", { projectId: "p1" }) });
    const res = await service().setMailboxDisplayName("suporte@exemplo.com", "Suporte", { projectId: "p1" });
    expect(res.mailbox).toMatchObject({ displayName: "Suporte", projectId: "p1" });
    expect(res.projectEmail).toBeUndefined();
  });

  it("caixa de OUTRO projeto, sem dono ou fora do projeto: 403 e nada muda", async () => {
    await seed({
      "outra@exemplo.com": box("outra@exemplo.com", "user", { projectId: "p2" }),
      "solta@exemplo.com": box("solta@exemplo.com", "user"),
    });
    const svc = service();
    for (const id of ["outra@exemplo.com", "solta@exemplo.com"]) {
      await expect(svc.setMailboxDisplayName(id, "X", { projectId: "p1" })).rejects.toMatchObject({ statusCode: 403, code: "mailbox_not_in_project" });
    }
    expect(nameCalls).toEqual([]);
  });

  it("caixa de envio antiga sem dono gravado conta como do projeto", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project") },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja" } },
    );
    const res = await service().setMailboxDisplayName("loja@exemplo.com", "Loja Nova", { projectId: "p1" });
    expect(res.mailbox.projectId).toBe("p1");
  });

  it("caixa de envio: vira o MAIL_FROM_NAME (próximo deploy), avisa e atualiza o webmail", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Loja Royal" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja Royal" } },
    );
    const svc = service();
    const res = await svc.setMailboxDisplayName("loja@exemplo.com", "Loja Royal - Vendas");
    expect(res.projectEmail).toEqual({ projectId: "p1", appliesOnNextDeploy: true });
    expect((await stored()).projects["p1"]!.fromName).toBe("Loja Royal - Vendas");
    expect((await svc.projectEmailConfig("p1")).fromName).toBe("Loja Royal - Vendas");
    expect(await svc.envForProject(loja)).toMatchObject({ MAIL_FROM_NAME: "Loja Royal - Vendas", MAIL_FROM: "loja@exemplo.com" });
    expect((await svc.webmailBackend()).identities).toEqual({ "loja@exemplo.com": "Loja Royal - Vendas" });
  });

  it("caixa de envio: vazio volta ao nome do projeto (no Stalwart também)", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Outro" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Outro" } },
    );
    const svc = service();
    const res = await svc.setMailboxDisplayName("loja@exemplo.com", "", { projectName: async (id) => (id === "p1" ? 'Loja <Royal> "X"' : undefined) });
    expect(nameCalls).toEqual([{ email: "loja@exemplo.com", name: "Loja Royal X" }]);
    expect(res.mailbox.displayName).toBe("Loja Royal X");
    expect((await stored()).projects["p1"]!.fromName).toBe("Loja Royal X");
  });

  it("caixa de envio sem nome do projeto à mão: fica sem nome e o deploy usa o do projeto", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Outro" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Outro" } },
    );
    const svc = service();
    await svc.setMailboxDisplayName("loja@exemplo.com", "");
    expect((await stored()).projects["p1"]!.fromName).toBeUndefined();
    expect(await svc.envForProject(loja)).toMatchObject({ MAIL_FROM_NAME: "Loja Royal" });
  });
});

describe("ativar o e-mail do projeto", () => {
  it("caixa nova: o nome digitado vai ao Stalwart e ao cadastro; sem nome, o do projeto", async () => {
    await seed({});
    const svc = service();
    await svc.enableProjectEmail(loja, "exemplo.com", { password: SENHA, fromName: " Loja  Royal - Vendas " });
    expect(created[0]).toMatchObject({ email: "loja@exemplo.com", name: "Loja Royal - Vendas" });
    const file = await stored();
    expect(file.mailboxes["loja@exemplo.com"]!.displayName).toBe("Loja Royal - Vendas");
    expect(file.projects["p1"]!.fromName).toBe("Loja Royal - Vendas");

    await seed({});
    await svc.enableProjectEmail({ ...loja, id: "p9", slug: "outra", name: "Outra Loja" } as Project, "exemplo.com", { password: SENHA });
    expect(created[1]).toMatchObject({ email: "outra@exemplo.com", name: "Outra Loja" });
  });

  it("nome do projeto com caracteres que o nome de exibição não aceita é limpo, nunca recusado", async () => {
    await seed({});
    await service().enableProjectEmail({ ...loja, name: 'Loja <b>"Royal"</b>\\' } as Project, "exemplo.com", { password: SENHA });
    expect(created[0]!.name).toBe("Loja b Royal /b");
  });

  it("nome inválido na ativação: 400 sem criar caixa", async () => {
    await seed({});
    await expect(service().enableProjectEmail(loja, "exemplo.com", { password: SENHA, fromName: "A\r\nBcc: x@y.z" })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_display_name",
    });
    expect(created).toEqual([]);
  });

  it("salvar de novo com outro nome (mesma caixa): só o nome muda no Stalwart, sem tocar na senha", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Loja Royal" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja Royal" } },
    );
    await service().enableProjectEmail(loja, "exemplo.com", { fromName: "Royal Vendas" });
    expect(nameCalls).toEqual([{ email: "loja@exemplo.com", name: "Royal Vendas" }]);
    expect(passwordCalls).toEqual([]);
  });

  it("salvar de novo com o mesmo nome não chama o Stalwart à toa", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Loja Royal" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja Royal" } },
    );
    await service().enableProjectEmail(loja, "exemplo.com", {});
    expect(nameCalls).toEqual([]);
  });
});

describe("usar uma caixa que já existe", () => {
  const seedExisting = (extra: Record<string, unknown> = {}) => seed({ "contato@exemplo.com": box("contato@exemplo.com", "user", extra) });
  const connect = (fromName?: string) =>
    new (MailService as unknown as new (c: ServerConfig, o: unknown) => InstanceType<typeof MailService>)(config, {
      audit: { record: async () => undefined },
      projects: async () => [{ id: "p1", slug: "loja", name: "Loja Royal" }],
      // a senha confere
    }).connectExistingMailbox(loja, "exemplo.com", "contato", { mode: "keep_password", ...(fromName ? { fromName } : {}) });

  it("sem nome digitado e sem nome na caixa: usa o do projeto e grava no Stalwart", async () => {
    await seedExisting();
    await connect();
    expect(nameCalls).toEqual([{ email: "contato@exemplo.com", name: "Loja Royal" }]);
    expect((await stored()).projects["p1"]!.fromName).toBe("Loja Royal");
  });

  it("a caixa já tem nome: ele é mantido (nada é gravado no Stalwart); nome digitado vence", async () => {
    await seedExisting({ displayName: "Contato da Loja" });
    await connect();
    expect(nameCalls).toEqual([]);
    expect((await stored()).projects["p1"]!.fromName).toBe("Contato da Loja");
    await connect("Outro Nome");
    expect(nameCalls).toEqual([{ email: "contato@exemplo.com", name: "Outro Nome" }]);
  });

  it("nome inválido: 400 antes de mexer na caixa", async () => {
    await seedExisting();
    await expect(connect("Oi\r\nX")).rejects.toMatchObject({ code: "invalid_display_name" });
    expect(nameCalls).toEqual([]);
  });
});

describe("webmail", () => {
  it("o webmail recebe o nome de TODAS as caixas com nome (a de envio vale o MAIL_FROM_NAME)", async () => {
    await seed(
      {
        "a@exemplo.com": box("a@exemplo.com", "user", { displayName: "Caixa A" }),
        "b@exemplo.com": box("b@exemplo.com", "user"),
        "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "velho" }),
      },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja Royal" } },
    );
    expect((await service().webmailBackend()).identities).toEqual({ "a@exemplo.com": "Caixa A", "loja@exemplo.com": "Loja Royal" });
  });
});

describe("nome do projeto cru nunca chega ao deploy, ao webmail nem ao e-mail de teste", () => {
  it("registro antigo SEM fromName e projeto com CRLF no nome: MAIL_FROM_NAME sai limpo (sem quebra de linha)", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW } },
    );
    const env = await service().envForProject({ ...loja, name: "Loja\r\nBcc: vitima@example.com" } as Project);
    expect(env.MAIL_FROM_NAME).toBe("Loja Bcc: vitima@example.com");
    expect(env.MAIL_FROM_NAME).not.toMatch(/[\r\n]/);
  });

  it("registro antigo COM fromName 'Loja <b>' ou U+2028: deploy, webmail e e-mail de teste saem limpos", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1", displayName: "Loja <b> X\u2028Y" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja <b> X\u2028Y" } },
    );
    const svc = service();
    expect((await svc.envForProject(loja)).MAIL_FROM_NAME).toBe("Loja b X Y");
    expect((await svc.webmailBackend()).identities).toEqual({ "loja@exemplo.com": "Loja b X Y" });
    expect((await svc.projectEmailConfig("p1")).fromName).toBe("Loja b X Y");
  });

  it("projeto chamado '<<>>': a limpeza dá vazio, não há nome e o deploy NÃO manda o texto cru (From só com o endereço)", async () => {
    await seed({});
    const svc = service();
    const p = { ...loja, name: "<<>>" } as Project;
    await svc.enableProjectEmail(p, "exemplo.com", { password: SENHA });
    expect((await stored()).projects["p1"]!.fromName).toBeUndefined();
    expect(created[0]!.name).toBeUndefined();
    const env = await svc.envForProject(p);
    expect(env).not.toHaveProperty("MAIL_FROM_NAME");
    expect(env.MAIL_FROM).toBe("loja@exemplo.com");
  });

  it("zero-width, LRM/RLM, ALM e surrogate solto no nome do projeto são tirados", async () => {
    await seed(
      { "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }) },
      { p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW } },
    );
    const env = await service().envForProject({ ...loja, name: "Lo\u200bja\u200e\u061c\ufeff\ud800 X" } as Project);
    expect(env.MAIL_FROM_NAME).toBe("Lo ja X");
  });
});

describe("projeto ativado ANTES do nome por caixa", () => {
  it("a lista e o modal mostram o nome efetivo da caixa de envio (copiado do projeto), sem sobrescrever nome existente", async () => {
    await seed(
      {
        "loja@exemplo.com": box("loja@exemplo.com", "project", { projectId: "p1" }),
        "outra@exemplo.com": box("outra@exemplo.com", "project", { projectId: "p2", displayName: "Já tinha" }),
      },
      {
        p1: { domain: "exemplo.com", mailbox: "loja@exemplo.com", enabledAt: NOW, fromName: "Loja Royal" },
        p2: { domain: "exemplo.com", mailbox: "outra@exemplo.com", enabledAt: NOW, fromName: "Outro nome" },
      },
    );
    const svc = service();
    const listed = await svc.listMailboxes("exemplo.com");
    expect(listed.find((m) => m.id === "loja@exemplo.com")!.displayName).toBe("Loja Royal");
    expect(listed.find((m) => m.id === "outra@exemplo.com")!.displayName).toBe("Já tinha");
    expect((await svc.envForProject(loja)).MAIL_FROM_NAME).toBe("Loja Royal");
  });
});

describe("concorrência na mesma caixa", () => {
  it("alterar o nome e trocar a senha ao mesmo tempo: o Stalwart nunca recebe as duas chamadas juntas", async () => {
    await seed({ "c@exemplo.com": box("c@exemplo.com", "user") });
    const svc = service();
    let active = 0;
    let overlap = 0;
    const busy = async () => {
      active += 1;
      if (active > 1) overlap += 1;
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    setNameImpl = busy;
    const anySvc = svc as unknown as { client(): { setMailboxMainPassword: (e: string, p: string) => Promise<void> } };
    const orig = anySvc.client.bind(svc);
    anySvc.client = () => {
      const c = orig();
      c.setMailboxMainPassword = busy;
      return c;
    };
    await Promise.all([
      svc.setMailboxDisplayName("c@exemplo.com", "A"),
      svc.changeMailboxPassword("c@exemplo.com", "outra-senha-forte-123"),
      svc.setMailboxDisplayName("c@exemplo.com", "B"),
      svc.changeMailboxPassword("c@exemplo.com", "outra-senha-forte-456"),
    ]);
    expect(overlap).toBe(0);
    const s = (await stored()).mailboxes["c@exemplo.com"]!;
    expect(s.displayName).toBe("B");
    expect(s.password).toBe("outra-senha-forte-456");
  });
});
