/**
 * WebmailService — pedido do dono do produto (04/10/2026): webmail para as
 * pessoas lerem, responderem e enviarem e-mail das caixas pelo navegador.
 *
 * O painel ativa/desativa o container do Roundcube, gera a configuração a
 * partir do servidor de e-mail (nome interno, certificado, nomes aceitos),
 * isenta o IP do webmail no bloqueio automático do Stalwart e bloqueia no
 * Caddy o IP de quem erra a senha demais. Sem Docker: dublês.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { WebmailService, type WebmailMailSource, type WebmailManagerLike } from "../src/services/webmail-service.js";

let dir: string;
let now: number;
let backend: Awaited<ReturnType<WebmailMailSource["webmailBackend"]>>;
const mailCalls: unknown[][] = [];
const managerCalls: unknown[][] = [];
const configs: string[] = [];
/** Última configuração entregue ao container (o estado usa um gerenciador sem config). */
const lastConfig = () => configs.filter(Boolean).at(-1);
let containerState: { installed: boolean; running: boolean };
let ip: string | null;
let logs: string;
const audits: { action: string; target?: string | null; detail: string }[] = [];

const mail: WebmailMailSource = {
  webmailBackend: async () => backend,
  exemptWebmailIp: async (newIp, previous) => {
    mailCalls.push(["exempt", newIp, previous]);
  },
  removeWebmailIpExemption: async (oldIp) => {
    mailCalls.push(["remove", oldIp]);
  },
};

function fakeManager(config: string): WebmailManagerLike {
  configs.push(config);
  return {
    image: "roundcube/roundcubemail:teste",
    containerName: "paas-webmail",
    status: async () => containerState,
    start: async () => {
      managerCalls.push(["start"]);
      containerState = { installed: true, running: true };
    },
    stop: async () => {
      managerCalls.push(["stop"]);
      containerState = { ...containerState, running: false };
    },
    remove: async () => {
      managerCalls.push(["remove"]);
      containerState = { installed: false, running: false };
    },
    internalIp: async () => ip,
    logsSince: async (since: number) => {
      managerCalls.push(["logs", since]);
      return logs;
    },
  };
}

function service(): WebmailService {
  return new WebmailService({ dataDir: dir } as ServerConfig, mail, {
    createManager: fakeManager,
    audit: { record: async (e) => void audits.push(e) },
    now: () => now,
  });
}

const failed = (ipAddr: string) =>
  `[x]: <a> Failed login for contato@exemplo.com from 172.18.0.5 (X-Forwarded-For: ${ipAddr}) in session abc (error: 0)`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-webmail-"));
  now = Date.UTC(2026, 9, 4, 12, 0, 0);
  backend = {
    serverRunning: true,
    imapHost: "mail.exemplo.com",
    verifyTls: true,
    hosts: ["mail.exemplo.com", "mail.outro.com"],
    domains: [
      { domain: "exemplo.com", host: "mail.exemplo.com" },
      { domain: "outro.com", host: "mail.outro.com" },
    ],
  };
  mailCalls.length = 0;
  managerCalls.length = 0;
  configs.length = 0;
  audits.length = 0;
  containerState = { installed: false, running: false };
  ip = "172.18.0.9";
  logs = "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("estado", () => {
  it("nunca ativado: desativado, com os endereços que terá", async () => {
    const status = await service().status();
    expect(status).toMatchObject({
      enabled: false,
      installed: false,
      running: false,
      mailServerRunning: true,
      tlsVerified: true,
      blockedIps: 0,
      links: [
        { domain: "exemplo.com", host: "mail.exemplo.com", url: "https://mail.exemplo.com/" },
        { domain: "outro.com", host: "mail.outro.com", url: "https://mail.outro.com/" },
      ],
    });
    expect(status.message).toMatch(/Ative/);
  });

  it("sem domínio cadastrado: avisa que precisa de um", async () => {
    backend = { ...backend, domains: [], hosts: [] };
    expect((await service().status()).message).toMatch(/domínio/);
  });

  it("servidor de e-mail parado: avisa", async () => {
    backend = { ...backend, serverRunning: false };
    expect((await service().status()).message).toMatch(/servidor de e-mail está parado/);
  });
});

describe("ativar", () => {
  it("sobe o container com a configuração do servidor, isenta o IP e guarda o estado (0600)", async () => {
    const s = service();
    const status = await s.enable();
    expect(managerCalls).toEqual([["start"]]);
    expect(lastConfig()).toContain("$config['imap_host'] = 'ssl://mail.exemplo.com:993';");
    expect(lastConfig()).toContain("'verify_peer' => true");
    expect(lastConfig()).toContain("$config['trusted_host_patterns'] = ['mail.exemplo.com', 'mail.outro.com'];");
    expect(mailCalls).toEqual([["exempt", "172.18.0.9", null]]);
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.message).toBeNull();

    const file = path.join(dir, "mail", "webmail.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.enabled).toBe(true);
    expect(saved.desKey).toHaveLength(32);
    expect(saved.exemptIp).toBe("172.18.0.9");
    // a chave da sessão continua a mesma numa nova ativação (sessões não caem à toa)
    await s.enable();
    expect(lastConfig()).toContain(saved.desKey);
  });

  it("servidor de e-mail parado: recusa com 409", async () => {
    backend = { ...backend, serverRunning: false };
    await expect(service().enable()).rejects.toMatchObject({ statusCode: 409, code: "mail_server_stopped" });
    expect(managerCalls).toEqual([]);
  });

  it("sem domínio: recusa com 409", async () => {
    backend = { ...backend, domains: [], hosts: [] };
    await expect(service().enable()).rejects.toMatchObject({ statusCode: 409, code: "webmail_no_domain" });
  });

  it("falha ao isentar o IP não impede o webmail de subir (fica no log)", async () => {
    const log = vi.fn();
    const s = new WebmailService({ dataDir: dir } as ServerConfig, {
      ...mail,
      exemptWebmailIp: async () => {
        throw new Error("api fora");
      },
    }, { createManager: fakeManager, now: () => now, log });
    const status = await s.enable();
    expect(status.running).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("api fora"));
  });

  it("sem IP na rede: não isenta", async () => {
    ip = null;
    await service().enable();
    expect(mailCalls).toEqual([]);
  });

  it("sem certificado instalado: cifra sem conferir o nome", async () => {
    backend = { ...backend, verifyTls: false };
    const status = await service().enable();
    expect(lastConfig()).toContain("'verify_peer' => false");
    expect(status.tlsVerified).toBe(false);
  });
});

describe("desativar", () => {
  it("remove o container (o volume fica), tira a isenção e guarda", async () => {
    const s = service();
    await s.enable();
    managerCalls.length = 0;
    mailCalls.length = 0;
    const status = await s.disable();
    expect(managerCalls).toEqual([["remove"]]);
    expect(mailCalls).toEqual([["remove", "172.18.0.9"]]);
    expect(status.enabled).toBe(false);
    expect(status.message).toMatch(/Ative/);
    const saved = JSON.parse(await readFile(path.join(dir, "mail", "webmail.json"), "utf8"));
    expect(saved.enabled).toBe(false);
    expect(saved.exemptIp).toBeNull();
    // estado salvo é lido por uma instância nova (reinício do painel)
    expect((await service().status()).enabled).toBe(false);
  });

  it("falha ao tirar a isenção não impede desativar", async () => {
    const log = vi.fn();
    const s = new WebmailService({ dataDir: dir } as ServerConfig, {
      ...mail,
      removeWebmailIpExemption: async () => {
        throw new Error("api fora");
      },
    }, { createManager: fakeManager, now: () => now, log });
    await s.enable();
    expect((await s.disable()).enabled).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});

describe("junto com o servidor de e-mail e sincronização", () => {
  it("servidor parou: para o webmail; voltou: sobe de novo", async () => {
    const s = service();
    await s.enable();
    managerCalls.length = 0;
    await s.followMailServer(false);
    expect(managerCalls).toEqual([["stop"]]);
    await s.followMailServer(true);
    expect(managerCalls).toEqual([["stop"], ["start"]]);
  });

  it("desativado: nada acontece", async () => {
    const s = service();
    await s.followMailServer(true);
    await s.followMailServer(false);
    await s.sync();
    expect(managerCalls).toEqual([]);
  });

  it("sync regrava a config (domínio novo, certificado instalado) e reisenta o IP se mudou", async () => {
    const s = service();
    await s.enable();
    managerCalls.length = 0;
    mailCalls.length = 0;
    backend = { ...backend, hosts: [...backend.hosts, "mail.novo.com"], verifyTls: true };
    ip = "172.18.0.12";
    await s.sync();
    expect(managerCalls).toEqual([["start"]]);
    expect(lastConfig()).toContain("'mail.novo.com'");
    expect(mailCalls).toEqual([["exempt", "172.18.0.12", "172.18.0.9"]]);
    // mesmo IP: não chama a API de novo
    mailCalls.length = 0;
    await s.sync();
    expect(mailCalls).toEqual([]);
  });

  it("sync com o servidor de e-mail parado: não sobe o webmail", async () => {
    const s = service();
    await s.enable();
    managerCalls.length = 0;
    backend = { ...backend, serverRunning: false };
    await s.sync();
    expect(managerCalls).toEqual([]);
  });
});

describe("proxy e bloqueio de quem erra a senha demais", () => {
  it("proxyState: null desativado; upstream e IPs bloqueados ativado", async () => {
    const s = service();
    await expect(s.proxyState()).resolves.toBeNull();
    await s.enable();
    await expect(s.proxyState()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: [] });
  });

  it("10 senhas erradas do mesmo IP em 10 min: bloqueia por 1 hora e registra na auditoria", async () => {
    const s = service();
    await s.enable();
    logs = Array.from({ length: 9 }, () => failed("203.0.113.7")).join("\n");
    await expect(s.pollFailedLogins()).resolves.toBe(false);
    expect(managerCalls.at(-1)).toEqual(["logs", Math.floor(now / 1000) - 120]);

    now += 60_000;
    logs = [failed("203.0.113.7"), failed("198.51.100.1")].join("\n");
    await expect(s.pollFailedLogins()).resolves.toBe(true);
    // a leitura seguinte começa onde a anterior parou (nada contado duas vezes)
    expect(managerCalls.at(-1)).toEqual(["logs", Math.floor((now - 60_000) / 1000)]);
    await expect(s.proxyState()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: ["203.0.113.7"] });
    expect((await s.status()).blockedIps).toBe(1);
    expect(audits.at(-1)).toMatchObject({ action: "mail.webmail.block", target: "203.0.113.7" });

    // nada novo: sem mudança
    now += 60_000;
    logs = "";
    await expect(s.pollFailedLogins()).resolves.toBe(false);

    // passada 1 hora: libera
    now += 60 * 60_000;
    await expect(s.pollFailedLogins()).resolves.toBe(true);
    await expect(s.proxyState()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: [] });
  });

  it("IP da rede interna nunca é bloqueado (seria o gateway do Docker: bloquearia todo mundo)", async () => {
    const s = service();
    await s.enable();
    logs = Array.from({ length: 12 }, () => failed("172.18.0.1")).join("\n");
    await expect(s.pollFailedLogins()).resolves.toBe(false);
    await expect(s.proxyState()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: [] });
  });

  it("tentativas espalhadas por mais de 10 min não bloqueiam", async () => {
    const s = service();
    await s.enable();
    for (let i = 0; i < 12; i++) {
      logs = failed("203.0.113.7");
      await s.pollFailedLogins();
      now += 2 * 60_000;
    }
    await expect(s.proxyState()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: [] });
  });

  it("desativado ou parado: não lê log", async () => {
    const s = service();
    await expect(s.pollFailedLogins()).resolves.toBe(false);
    await s.enable();
    containerState = { installed: true, running: false };
    managerCalls.length = 0;
    await expect(s.pollFailedLogins()).resolves.toBe(false);
    expect(managerCalls).toEqual([]);
  });
});
