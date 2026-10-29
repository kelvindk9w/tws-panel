/**
 * mail-admin-auth.test.ts — "Stalwart: You have to authenticate first." depois
 * de restaurar o painel ou o e-mail.
 *
 * Causa (confirmada no código): a senha de administração do Stalwart mora em
 * DOIS lugares — data/mail/mail.json (`adminSecret`, o que o painel usa nas
 * chamadas) e o config.toml DENTRO do container (`fallback-admin`, o que o
 * Stalwart aceita). Restaurar o e-mail devolve a pasta etc/ do container com a
 * senha do servidor ANTIGO; restaurar o painel devolve o mail.json do painel
 * antigo para um container que já subiu com outra senha. Nos dois casos os dois
 * lados divergem e toda chamada do painel ao Stalwart dá 401.
 *
 * Sem Docker: StalwartManager/StalwartClient são dublês que guardam a senha
 * "que o container tem" e recusam (401) quem chega com outra.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

/** Senha que o config.toml DENTRO do container tem. */
let containerSecret = "";
let running = true;
let reachable = true;
/** O restart não consegue aplicar a senha (simula falha persistente). */
let restartIgnoresSecret = false;
const calls: string[] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(private readonly opts: Record<string, unknown>) {}
    async status() {
      return { installed: true, running, version: "0.11.8", image: "x", containerName: "paas-stalwart", hostname: "mail.exemplo.com", ports: MAIL_DEFAULT_PORTS, message: null };
    }
    async applyTls(arg: { restart: boolean }) {
      calls.push(`applyTls restart=${arg.restart}`);
      if (arg.restart && !restartIgnoresSecret) containerSecret = this.opts.adminSecret as string;
      return arg.restart ? "restarted" : "reloaded";
    }
    async waitReady() {
      calls.push("waitReady");
    }
    apiBaseUrl() {
      return "http://127.0.0.1:8080";
    }
  }
  class FakeStalwartClient {
    constructor(
      readonly baseUrl: string,
      readonly user: string,
      readonly secret: string,
    ) {}
    async listQueue() {
      calls.push("listQueue");
      if (!reachable) throw new actual.StalwartApiError(0, "Sem conexão com o Stalwart (ECONNREFUSED).");
      if (this.secret !== containerSecret) throw new actual.StalwartApiError(401, "Stalwart: You have to authenticate first.");
      return { items: [], total: 0 };
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let logs: string[] = [];
const config = () => ({ dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null, panelDomain: null }) as unknown as ServerConfig;
const service = () => new MailService(config(), { inContainer: false, log: (m) => void logs.push(m) });

async function seed(adminSecret: string | null) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ adminSecret, hostname: null, domains: {}, mailboxes: {}, projects: {} }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-auth-"));
  containerSecret = "segredo-do-container";
  running = true;
  reachable = true;
  restartIgnoresSecret = false;
  calls.length = 0;
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("checkAdminAuth", () => {
  it("a mesma senha nos dois lados: ok, sem mexer em nada", async () => {
    await seed("segredo-do-container");
    expect(await service().checkAdminAuth()).toBe("ok");
    expect(calls).toEqual(["listQueue"]);
  });

  it("mail.json restaurado de outro servidor (senha diferente da do container): mismatch", async () => {
    await seed("segredo-do-painel-antigo");
    expect(await service().checkAdminAuth()).toBe("mismatch");
  });

  it("servidor parado, nunca iniciado ou API sem resposta: não conclui nada (não é divergência)", async () => {
    await seed("segredo-do-painel-antigo");
    running = false;
    expect(await service().checkAdminAuth()).toBe("not_running");
    running = true;
    reachable = false;
    expect(await service().checkAdminAuth()).toBe("unreachable");
    await seed(null);
    expect(await service().checkAdminAuth()).toBe("not_running");
  });
});

describe("repairAdminAuth", () => {
  it("divergente: reescreve a configuração com a senha do painel e reinicia (sem apagar dados), e a chamada autenticada passa", async () => {
    await seed("segredo-do-painel-antigo");
    const s = service();
    expect(await s.repairAdminAuth()).toBe("repaired");
    expect(calls).toContain("applyTls restart=true");
    expect(containerSecret).toBe("segredo-do-painel-antigo");
    // depois do reparo, uma chamada autenticada do painel passa
    expect(await service().checkAdminAuth()).toBe("ok");
    // a senha nunca vai para o log nem é trocada no mail.json
    expect(logs.join("\n")).not.toMatch(/segredo/);
    expect(JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).adminSecret).toBe("segredo-do-painel-antigo");
  });

  it("já consistente: não reinicia o servidor à toa", async () => {
    await seed("segredo-do-container");
    expect(await service().repairAdminAuth()).toBe("ok");
    expect(calls.some((c) => c.startsWith("applyTls"))).toBe(false);
  });

  it("servidor parado ou sem resposta: não reinicia (o próximo start já grava a senha certa)", async () => {
    await seed("segredo-do-painel-antigo");
    running = false;
    expect(await service().repairAdminAuth()).toBe("not_running");
    running = true;
    reachable = false;
    expect(await service().repairAdminAuth()).toBe("unreachable");
    expect(calls.some((c) => c.startsWith("applyTls"))).toBe(false);
  });

  it("reinício que não resolve: 'failed' (a tela mostra o aviso com a ação)", async () => {
    await seed("segredo-do-painel-antigo");
    restartIgnoresSecret = true;
    expect(await service().repairAdminAuth()).toBe("failed");
  });

  it("reparos simultâneos (subida do painel x botão x fim da restauração) viram um só: o Stalwart reinicia uma vez", async () => {
    await seed("segredo-do-painel-antigo");
    const s = service();
    // instâncias diferentes, como no app (subida, botão, fim da restauração)
    const results = await Promise.all([s.repairAdminAuth(), service().repairAdminAuth(), service().repairAdminAuth()]);
    expect(results).toEqual(["repaired", "repaired", "repaired"]);
    expect(calls.filter((c) => c === "applyTls restart=true")).toHaveLength(1);
    // depois que terminou, um novo pedido confere de novo (e não reinicia, já está certo)
    expect(await s.repairAdminAuth()).toBe("ok");
    expect(calls.filter((c) => c === "applyTls restart=true")).toHaveLength(1);
  });

  it("falha de um reparo não trava os seguintes", async () => {
    await seed("segredo-do-painel-antigo");
    restartIgnoresSecret = true;
    const s = service();
    expect(await s.repairAdminAuth()).toBe("failed");
    restartIgnoresSecret = false;
    expect(await s.repairAdminAuth()).toBe("repaired");
  });
});
