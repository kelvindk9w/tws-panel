/**
 * Administração do Stalwart só para a rede do painel — lado do MailService.
 *
 * Os projetos (redes paas-mail-<slug>) e o webmail (paas-mailweb) alcançam o Stalwart em todas as portas, inclusive a
 * da administração (8080). A cada sincronização o painel lê no Docker a sub-rede da paas-mail-admin e grava; quando
 * muda, a configuração muda e o Stalwart reinicia UMA vez (instalação existente: na primeira sincronização depois da
 * atualização). Leitura que falha não desliga a restrição nem reinicia; dúvida que trancaria o painel deixa aberto.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { removeDir } from "./helpers/tmp.js";

type Decision = { access: { cidrs: string[]; ips: string[] } } | { unsafe: string } | { transient: string };
let decision: Decision | Error = { transient: "x" };
const restarts: Array<Record<string, unknown>> = [];
const resolves: string[] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(private readonly opts: Record<string, unknown>) {}
    async status() {
      return { installed: true, running: true, version: "0.11.8", image: "x", containerName: "paas-stalwart", hostname: "h", ports: MAIL_DEFAULT_PORTS, message: null };
    }
    async connectContainer() {}
    async waitReady() {}
    async resolveAdminAccess(panel: string) {
      resolves.push(panel);
      if (decision instanceof Error) throw decision;
      return decision;
    }
    async applyTls(arg: { restart: boolean }) {
      if (arg.restart) restarts.push(this.opts);
      return arg.restart ? "restarted" : "reloaded";
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let config: ServerConfig;
let logs: string[] = [];

async function seed(extra: Record<string, unknown> = {}) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ adminSecret: "s", hostname: null, domains: {}, mailboxes: {}, projects: {}, ...extra }));
}
const stored = async () => JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as Record<string, unknown>;
const make = (inContainer = true) => new MailService(config, { inContainer, log: (m) => logs.push(m), readCertificate: async () => null });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-admin-access-"));
  config = { dataDir: dir, mailPorts: { ...MAIL_DEFAULT_PORTS }, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null, panelDomain: null } as unknown as ServerConfig;
  restarts.length = 0;
  resolves.length = 0;
  logs = [];
});
afterEach(async () => {
  await removeDir(dir);
});

const access = { cidrs: ["10.99.0.0/16"], ips: ["10.99.0.1"] };

describe("MailService — administração do Stalwart só para a rede do painel", () => {
  it("instalação existente: grava a restrição, avisa no log e reinicia o Stalwart uma vez com ela; depois, nada", async () => {
    await seed();
    // versão anterior do painel: servidor já sincronizado, sem restrição
    decision = { transient: "x" };
    await make().syncTls();
    restarts.length = 0;
    resolves.length = 0;
    expect(await make().syncTls()).toBe("none");
    expect(restarts).toHaveLength(0);

    decision = { access };
    resolves.length = 0;
    expect(await make().syncTls()).toBe("restarted");
    expect(resolves).toEqual(["tws-panel"]);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.adminAccess).toEqual(access);
    expect((await stored()).adminAccess).toEqual(access);
    expect(logs.join("\n")).toMatch(/passa a aceitar só a rede do painel \(10\.99\.0\.0\/16, 10\.99\.0\.1\).*403/);

    logs = [];
    expect(await make().syncTls()).toBe("none");
    expect(restarts).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("leitura que falha (ou erro) mantém a restrição gravada e não reinicia", async () => {
    await seed();
    decision = { access };
    await make().syncTls();
    for (const d of [{ transient: "sem resposta" }, new Error("docker fora")] as Decision[]) {
      decision = d;
      logs = [];
      expect(await make().syncTls()).toBe("none");
      expect(restarts).toHaveLength(1);
      expect((await stored()).adminAccess).toEqual(access);
      expect(logs.join("\n")).toMatch(/fica como estava/);
    }
  });

  it("dúvida que trancaria o painel: tira a restrição (com o motivo no log) e reinicia sem ela", async () => {
    await seed({ adminAccess: access });
    decision = { access };
    await make().syncTls();
    restarts.length = 0;
    decision = { unsafe: "o painel e o servidor de e-mail ainda dividem a rede paas-net" };
    expect(await make().syncTls()).toBe("restarted");
    expect(restarts[0]!.adminAccess).toBeNull();
    expect((await stored()).adminAccess).toBeNull();
    expect(logs.join("\n")).toMatch(/fica aberta.*dividem a rede paas-net/);
  });

  it("painel fora de container (dev): não restringe nem consulta o Docker (ele chega pela porta do host)", async () => {
    await seed({ adminAccess: access });
    decision = { access };
    await make(false).syncTls();
    expect(resolves).toEqual([]);
    expect(restarts.every((r) => r.adminAccess === null)).toBe(true);
  });
});
