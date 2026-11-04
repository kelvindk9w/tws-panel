/**
 * restore-reconciliation.test.ts — depois de restaurar um backup, o painel
 * compara o que o painel antigo tinha ATIVO com o que roda de fato nesta VPS
 * (consulta ao Docker, não à flag restaurada) e guarda as pendências até
 * serem resolvidas ou dispensadas. Nada é ativado sozinho.
 *
 * Arquivos de verdade numa pasta temporária; o Docker e o DNS são dublês
 * (a consulta com Docker real está em restore-reconciliation-docker.test.ts).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RestoreReconciliation, type ContainerProbe } from "../src/services/restore-reconciliation.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
let staged: string;
let now: number;
let containers: Record<string, ContainerProbe | "erro">;
let dnsPoints: boolean | "erro";
type MailAuth = "ok" | "mismatch" | "unreachable" | "not_running";
let mailAuth: MailAuth | "erro";
const repairs: string[] = [];
const probed: string[] = [];
const dnsAsked: string[] = [];

function make(opts: { dns?: boolean } = {}): RestoreReconciliation {
  return new RestoreReconciliation({
    dataDir: dir,
    containers: { stalwart: "paas-stalwart", webmail: "paas-webmail" },
    now: () => now,
    probes: {
      container: async (name) => {
        probed.push(name);
        const v = containers[name] ?? "missing";
        if (v === "erro") throw new Error("Cannot connect to the Docker daemon");
        return v;
      },
      mailAuth: async () => {
        if (mailAuth === "erro") throw new Error("falhou");
        return mailAuth;
      },
      repairMailAuth: async () => {
        repairs.push("repair");
        mailAuth = "ok";
        return "repaired" as const;
      },
      ...(opts.dns === false
        ? {}
        : {
            panelDomainPointsHere: async (domain: string) => {
              dnsAsked.push(domain);
              if (dnsPoints === "erro") throw new Error("DNS sem resposta");
              return dnsPoints;
            },
          }),
    },
  });
}

const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

async function putStaged(rel: string, data: unknown): Promise<void> {
  const file = path.join(staged, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === "string" ? data : json(data));
}
const readStaged = async (rel: string) => JSON.parse(await readFile(path.join(staged, rel), "utf8")) as Record<string, any>;
const webmailOn = { enabled: true, enabledAt: "2026-10-01T00:00:00Z", desKey: "k".repeat(24), exemptIp: "172.18.0.9" };
const mailInstalled = { adminSecret: "segredo", hostname: null, domains: {}, mailboxes: {}, projects: {} };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reconc-"));
  staged = path.join(dir, "backups", ".restaurar-painel");
  await mkdir(staged, { recursive: true });
  now = Date.parse("2026-10-20T12:00:00Z");
  containers = {};
  dnsPoints = false;
  mailAuth = "ok";
  repairs.length = 0;
  probed.length = 0;
  dnsAsked.length = 0;
});

afterEach(async () => {
  await removeDir(dir);
});

describe("restauração do painel: o backup tinha o webmail ativo", () => {
  it("VPS sem webmail rodando: cria a pendência, não ativa nada e tira a flag que não corresponde a container nenhum", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    const warnings = await make().planStaged(staged);

    expect(warnings.join(" ")).toMatch(/webmail ativo/);
    expect(warnings.join(" ")).toMatch(/Nada foi ativado/);
    // a flag restaurada dizia "ativo" sem container: o que vai entrar no lugar passa a dizer a verdade
    expect(await readStaged("mail/webmail.json")).toMatchObject({ enabled: false, desKey: webmailOn.desKey });
    // a pendência viaja junto com o estado restaurado
    const stored = await readStaged("restore-reconciliation.json");
    expect(stored.items).toMatchObject([{ id: "webmail", state: "open", source: "panel" }]);
    // só consulta, nunca liga: o dublê só tem a consulta
    expect(probed).toEqual(["paas-webmail"]);
  });

  it("webmail existe mas está parado: pendência, e a flag fica como estava (o container existe)", async () => {
    containers["paas-webmail"] = "stopped";
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    expect((await readStaged("mail/webmail.json")).enabled).toBe(true);
    expect((await readStaged("restore-reconciliation.json")).items).toHaveLength(1);
  });

  it("webmail já rodando aqui: nenhuma pendência e nenhuma pergunta", async () => {
    containers["paas-webmail"] = "running";
    await putStaged("mail/webmail.json", webmailOn);
    const warnings = await make().planStaged(staged);
    expect(warnings).toEqual([]);
    expect(existsSync(path.join(staged, "restore-reconciliation.json"))).toBe(false);
    expect((await readStaged("mail/webmail.json")).enabled).toBe(true);
  });

  it("backup sem webmail (desativado ou sem o arquivo): nada a conferir", async () => {
    await putStaged("mail/webmail.json", { ...webmailOn, enabled: false });
    expect(await make().planStaged(staged)).toEqual([]);
    await rm(path.join(staged, "mail"), { recursive: true });
    expect(await make().planStaged(staged)).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("backup antigo sem nenhum dos campos (arquivos vazios ou de formato estranho): não falha e não pergunta nada", async () => {
    await putStaged("mail/webmail.json", "[]");
    await putStaged("mail/mail.json", "isto não é json");
    await putStaged("panel-domain.json", { domain: 42 });
    expect(await make().planStaged(staged)).toEqual([]);
    expect(existsSync(path.join(staged, "restore-reconciliation.json"))).toBe(false);
  });

  it("falha ao consultar o Docker: não bloqueia, vira pendência 'não foi possível conferir' e a flag não é mexida", async () => {
    containers["paas-webmail"] = "erro";
    await putStaged("mail/webmail.json", webmailOn);
    const warnings = await make().planStaged(staged);
    expect(warnings.join(" ")).toMatch(/webmail.*não foi possível conferir/is);
    expect((await readStaged("mail/webmail.json")).enabled).toBe(true);
    expect((await readStaged("restore-reconciliation.json")).items).toHaveLength(1);
  });

  it("uma pendência antiga que veio no backup não vaza: o arquivo preparado é sempre o desta restauração", async () => {
    await putStaged("restore-reconciliation.json", { items: [{ id: "webmail", state: "open", source: "panel", since: "2020-01-01T00:00:00Z" }] });
    containers["paas-webmail"] = "running";
    await make().planStaged(staged);
    expect(existsSync(path.join(staged, "restore-reconciliation.json"))).toBe(false);
  });
});

describe("restauração do painel: servidor de e-mail e domínio do painel", () => {
  it("servidor de e-mail criado no painel antigo e ausente aqui: pendência", async () => {
    await putStaged("mail/mail.json", mailInstalled);
    const warnings = await make().planStaged(staged);
    expect(warnings.join(" ")).toMatch(/servidor de e-mail/);
    expect((await readStaged("restore-reconciliation.json")).items).toMatchObject([{ id: "mail-server" }]);
  });

  it("servidor de e-mail nunca iniciado no backup (sem segredo): nada a conferir", async () => {
    await putStaged("mail/mail.json", { ...mailInstalled, adminSecret: null });
    expect(await make().planStaged(staged)).toEqual([]);
  });

  it("domínio do painel ativo no backup e DNS ainda não apontando para esta VPS: pendência", async () => {
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: true, ipAccessDisabled: false });
    const warnings = await make().planStaged(staged);
    expect(warnings.join(" ")).toMatch(/domínio/);
    expect(dnsAsked).toEqual(["painel.exemplo.com"]);
    expect((await readStaged("restore-reconciliation.json")).items).toMatchObject([{ id: "panel-domain", domain: "painel.exemplo.com" }]);
  });

  it("DNS já aponta para cá: sem pendência; domínio inativo no backup: sem pendência", async () => {
    dnsPoints = true;
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: true });
    expect(await make().planStaged(staged)).toEqual([]);
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: false });
    expect(await make().planStaged(staged)).toEqual([]);
  });

  it("DNS sem resposta ou sem consulta disponível: fica pendente (não foi possível conferir)", async () => {
    dnsPoints = "erro";
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: true });
    await make().planStaged(staged);
    expect((await readStaged("restore-reconciliation.json")).items).toHaveLength(1);
    await rm(path.join(staged, "restore-reconciliation.json"));
    await make({ dns: false }).planStaged(staged);
    expect((await readStaged("restore-reconciliation.json")).items).toHaveLength(1);
  });
});

describe("a lista: persiste, resolve sozinha e pode ser dispensada", () => {
  /** Simula a troca da subida: o arquivo preparado passa a morar no diretório de dados. */
  async function swapIn(): Promise<void> {
    await writeFile(path.join(dir, "restore-reconciliation.json"), await readFile(path.join(staged, "restore-reconciliation.json")));
  }

  it("lista a pendência com o estado REAL do Docker, e sobrevive a um reinício (outra instância lê o mesmo arquivo)", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    await swapIn();

    const before = await make().list();
    expect(before.items).toMatchObject([{ id: "webmail", status: "pending", source: "panel", since: "2026-10-20T12:00:00.000Z" }]);
    const reinicio = await make().list();
    expect(reinicio).toEqual(before);
  });

  it("some sozinha quando o webmail passa a rodar, e não volta se parar depois", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    await swapIn();

    containers["paas-webmail"] = "running";
    expect((await make().list()).items).toEqual([]);
    containers["paas-webmail"] = "stopped";
    expect((await make().list()).items).toEqual([]);
    const stored = JSON.parse(await readFile(path.join(dir, "restore-reconciliation.json"), "utf8")) as { items: any[] };
    expect(stored.items[0]).toMatchObject({ id: "webmail", state: "resolved" });
    expect(stored.items[0].closedAt).toBe("2026-10-20T12:00:00.000Z");
  });

  it("falha ao consultar o Docker na lista: continua pendente com status 'unknown' (nunca resolve por engano)", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    await swapIn();
    containers["paas-webmail"] = "erro";
    expect((await make().list()).items).toMatchObject([{ id: "webmail", status: "unknown" }]);
  });

  it("dispensar tira o aviso e não pergunta de novo, mesmo com o webmail ainda parado", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    await swapIn();
    const svc = make();
    expect((await svc.dismiss("webmail")).items).toEqual([]);
    expect((await make().list()).items).toEqual([]);
    const stored = JSON.parse(await readFile(path.join(dir, "restore-reconciliation.json"), "utf8")) as { items: any[] };
    expect(stored.items[0]).toMatchObject({ state: "dismissed" });
  });

  it("dispensar o que não está pendente é erro claro (404)", async () => {
    await expect(make().dismiss("webmail")).rejects.toMatchObject({ statusCode: 404, code: "reconciliation_not_found" });
    await expect(make().dismiss("outra-coisa")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("sem arquivo nenhum: lista vazia; arquivo ilegível: lista vazia sem derrubar", async () => {
    expect((await make().list()).items).toEqual([]);
    await writeFile(path.join(dir, "restore-reconciliation.json"), "{{{");
    expect((await make().list()).items).toEqual([]);
    await writeFile(path.join(dir, "restore-reconciliation.json"), json({ items: [{ id: "inventado", state: "open" }, 7] }));
    expect((await make().list()).items).toEqual([]);
  });

  it("servidor de e-mail: resolve quando o Stalwart roda", async () => {
    await putStaged("mail/mail.json", mailInstalled);
    await make().planStaged(staged);
    await swapIn();
    expect((await make().list()).items).toMatchObject([{ id: "mail-server", status: "pending" }]);
    containers["paas-stalwart"] = "running";
    expect((await make().list()).items).toEqual([]);
  });

  it("domínio do painel: resolve quando o DNS aponta para cá, ou quando o domínio saiu do painel", async () => {
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: true });
    await make().planStaged(staged);
    await swapIn();
    // painel restaurado com o mesmo domínio
    await writeFile(path.join(dir, "panel-domain.json"), json({ domain: "painel.exemplo.com", active: true }));
    expect((await make().list()).items).toMatchObject([{ id: "panel-domain", status: "pending" }]);
    dnsPoints = true;
    expect((await make().list()).items).toEqual([]);

    await swapIn();
    dnsPoints = false;
    await writeFile(path.join(dir, "panel-domain.json"), json({ domain: null, active: false }));
    expect((await make().list()).items).toEqual([]);
  });

  it("domínio do painel: DNS sem resposta na lista vira 'unknown'; consultas de DNS não se repetem a cada pedido", async () => {
    await putStaged("panel-domain.json", { domain: "painel.exemplo.com", active: true });
    await make().planStaged(staged);
    await swapIn();
    await writeFile(path.join(dir, "panel-domain.json"), json({ domain: "painel.exemplo.com", active: true }));
    const svc = make();
    dnsPoints = "erro";
    expect((await svc.list()).items).toMatchObject([{ status: "unknown" }]);
    dnsAsked.length = 0;
    dnsPoints = false;
    await svc.list();
    await svc.list();
    expect(dnsAsked.length).toBeLessThanOrEqual(1);
    now += 10 * 60_000;
    await svc.list();
    expect(dnsAsked.length).toBeGreaterThanOrEqual(1);
  });
});

describe("restauração do e-mail", () => {
  it("o backup do e-mail trazia o webmail e ele não roda aqui: pendência de webmail (e de servidor, se ele não existe)", async () => {
    const svc = make();
    await svc.markPending(["webmail", "mail-server"], "email");
    expect((await svc.list()).items).toMatchObject([
      { id: "webmail", source: "email", status: "pending" },
      { id: "mail-server", source: "email", status: "pending" },
    ]);
  });

  it("marcar de novo uma pendência já aberta não duplica; uma dispensada ou resolvida reabre (é uma restauração nova)", async () => {
    const svc = make();
    await svc.markPending(["webmail"], "email");
    await svc.markPending(["webmail"], "email");
    expect((await svc.list()).items).toHaveLength(1);
    await svc.dismiss("webmail");
    await svc.markPending(["webmail"], "email");
    expect((await svc.list()).items).toHaveLength(1);
  });

  it("uma pendência do painel não é apagada por uma do e-mail (a primeira origem continua)", async () => {
    await putStaged("mail/webmail.json", webmailOn);
    await make().planStaged(staged);
    await writeFile(path.join(dir, "restore-reconciliation.json"), await readFile(path.join(staged, "restore-reconciliation.json")));
    const svc = make();
    await svc.markPending(["webmail", "mail-server"], "email");
    expect((await svc.list()).items.map((i) => `${i.id}:${i.source}`)).toEqual(["webmail:panel", "mail-server:email"]);
  });
});

describe("senha de administração do servidor de e-mail (mail.json x container)", () => {
  async function swapIn(): Promise<void> {
    await writeFile(path.join(dir, "restore-reconciliation.json"), await readFile(path.join(staged, "restore-reconciliation.json")));
  }

  it("painel restaurado com o servidor de e-mail JÁ rodando aqui: o mail.json do backup pode ter outra senha — entra na lista para conferir", async () => {
    containers["paas-stalwart"] = "running";
    await putStaged("mail/mail.json", mailInstalled);
    expect(await make().planStaged(staged)).toEqual([]);
    expect((await readStaged("restore-reconciliation.json")).items).toMatchObject([{ id: "mail-auth", state: "open" }]);
  });

  it("servidor parado ou ausente: o próximo Iniciar grava a senha certa, sem item de autenticação", async () => {
    containers["paas-stalwart"] = "stopped";
    await putStaged("mail/mail.json", mailInstalled);
    await make().planStaged(staged);
    expect((await readStaged("restore-reconciliation.json")).items.map((i: any) => i.id)).toEqual(["mail-server"]);
  });

  it("divergente: aparece como pendência; depois do reparo, some sozinha", async () => {
    containers["paas-stalwart"] = "running";
    await putStaged("mail/mail.json", mailInstalled);
    await make().planStaged(staged);
    await swapIn();
    mailAuth = "mismatch";
    expect((await make().list()).items).toMatchObject([{ id: "mail-auth", status: "pending" }]);
    mailAuth = "ok";
    expect((await make().list()).items).toEqual([]);
  });

  it("sem resposta ou consulta que falha: 'unknown', nunca resolve por engano", async () => {
    await make().markPending(["mail-auth"], "email");
    mailAuth = "unreachable";
    expect((await make().list()).items).toMatchObject([{ id: "mail-auth", status: "unknown" }]);
    mailAuth = "erro";
    expect((await make().list()).items).toMatchObject([{ status: "unknown" }]);
  });

  it("servidor parado depois: nada a conferir, resolve", async () => {
    await make().markPending(["mail-auth"], "email");
    mailAuth = "not_running";
    expect((await make().list()).items).toEqual([]);
  });

  it("repairOpen: no boot, repara só se houver pendência de autenticação aberta; falha não derruba", async () => {
    const svc = make();
    expect(await svc.repairOpen()).toBeNull();
    expect(repairs).toEqual([]);
    await svc.markPending(["mail-auth"], "panel");
    expect(await svc.repairOpen()).toBe("repaired");
    expect(repairs).toEqual(["repair"]);
    expect((await svc.list()).items).toEqual([]);
  });

  it("repairOpen sem a função de reparo, ou que lança: devolve null e a pendência continua", async () => {
    const semReparo = new RestoreReconciliation({ dataDir: dir, containers: { stalwart: "s", webmail: "w" }, probes: { container: async () => "running", mailAuth: async () => "mismatch" } });
    await semReparo.markPending(["mail-auth"], "panel");
    expect(await semReparo.repairOpen()).toBeNull();
    const quebra = new RestoreReconciliation({
      dataDir: dir,
      containers: { stalwart: "s", webmail: "w" },
      probes: { container: async () => "running", mailAuth: async () => "mismatch", repairMailAuth: async () => Promise.reject(new Error("docker fora")) },
    });
    expect(await quebra.repairOpen()).toBeNull();
    expect((await quebra.list()).items).toMatchObject([{ id: "mail-auth", status: "pending" }]);
  });

  it("sem a consulta de autenticação configurada: 'unknown'", async () => {
    const svc = new RestoreReconciliation({ dataDir: dir, containers: { stalwart: "s", webmail: "w" }, probes: { container: async () => "running" } });
    await svc.markPending(["mail-auth"], "email");
    expect((await svc.list()).items).toMatchObject([{ id: "mail-auth", status: "unknown" }]);
  });
});
