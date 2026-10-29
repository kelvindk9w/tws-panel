/**
 * Cadastrar um domínio reinicia o Stalwart uma vez para ele passar a assinar
 * com a chave DKIM nova. Motivo (conferido em Docker real, ver
 * packages/mailer/tests/stalwart-deliverability.integration.test.ts): o
 * Stalwart v0.11.8 não carrega a chave criada pela API nem com /api/reload; sem
 * o reinício, a mensagem sai sem DKIM-Signature. Manager e client são dublês.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { removeDir } from "./helpers/tmp.js";

const calls: string[] = [];
let restartFails = false;
/** Reinícios acontecendo agora / o máximo ao mesmo tempo / quanto cada um demora. */
let active = 0;
let maxActive = 0;
let restartDelayMs = 0;

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return { installed: true, running: true, ports: MAIL_DEFAULT_PORTS };
    }
    async applyTls(opts: { restart: boolean }) {
      calls.push(`applyTls restart=${opts.restart}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (restartDelayMs > 0) await new Promise((r) => setTimeout(r, restartDelayMs));
        if (restartFails) throw new Error("docker restart falhou");
      } finally {
        active -= 1;
      }
      return "restarted" as const;
    }
    async waitReady() {
      calls.push("waitReady");
    }
  }
  class FakeStalwartClient {
    async createDomain(d: string) {
      calls.push(`createDomain ${d}`);
    }
    async createDkimSignature(d: string) {
      calls.push(`createDkim ${d}`);
      return `rsa-${d}`;
    }
    async getDkimPublicKey() {
      return "K".repeat(120);
    }
    async createMailbox(email: string) {
      calls.push(`createMailbox ${email}`);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let config: ServerConfig;

beforeEach(async () => {
  calls.length = 0;
  restartFails = false;
  active = 0;
  maxActive = 0;
  restartDelayMs = 0;
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-dkim-"));
  config = { dataDir: dir, mailPorts: MAIL_DEFAULT_PORTS, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null, panelDomain: null } as unknown as ServerConfig;
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ adminSecret: "s", hostname: null, domains: {}, mailboxes: {}, projects: {} }));
});

afterEach(async () => {
  await removeDir(dir);
});

function service(log = vi.fn()) {
  return {
    log,
    service: new MailService(config, { inContainer: false, log, readCertificate: async () => null }),
  };
}

describe("addDomain e o reinício para ativar o DKIM", () => {
  it("cria o domínio, a chave e a caixa, e só então reinicia o servidor uma vez", async () => {
    const { service: s } = service();
    const summary = await s.addDomain("envio.exemplo.com.br", { confirmExistingMail: true });
    expect(summary.name).toBe("envio.exemplo.com.br");
    expect(calls).toEqual([
      "createDomain envio.exemplo.com.br",
      "createDkim envio.exemplo.com.br",
      "createMailbox postmaster@envio.exemplo.com.br",
      "applyTls restart=true",
      "waitReady",
    ]);
  });

  it("falha no reinício não desfaz o cadastro: vai para o log", async () => {
    restartFails = true;
    const { service: s, log } = service();
    await expect(s.addDomain("envio.exemplo.com.br", { confirmExistingMail: true })).resolves.toMatchObject({ name: "envio.exemplo.com.br" });
    expect((await s.listDomains()).map((d) => d.name)).toEqual(["envio.exemplo.com.br"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ativar o DKIM"), { error: "docker restart falhou" });
  });

  it("erro que não é Error também é registrado", async () => {
    restartFails = false;
    const { service: s, log } = service();
    vi.spyOn(s as unknown as { currentCertificates: () => Promise<never> }, "currentCertificates").mockRejectedValue("texto");
    await s.addDomain("envio.exemplo.com.br", { confirmExistingMail: true });
    expect(log).toHaveBeenCalledWith(expect.any(String), { error: "texto" });
  });

  it("reinício que falha deixa o domínio 'reinício pendente' na resposta, no disco e no plano de saúde", async () => {
    restartFails = true;
    const { service: s } = service();
    const summary = await s.addDomain("envio.exemplo.com.br", { confirmExistingMail: true });
    expect(summary.dkimRestartPending).toBe(true);
    expect((await s.listDomains())[0]?.dkimRestartPending).toBe(true);
    expect((await s.healthPlanInput("envio.exemplo.com.br")).dkimRestartPending).toBe(true);
    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")) as { domains: Record<string, { dkimRestartPending?: boolean }> };
    expect(stored.domains["envio.exemplo.com.br"]?.dkimRestartPending).toBe(true);
  });

  it("reinício que dá certo não deixa pendência, e a próxima sincronização refaz o que ficou pendente", async () => {
    restartFails = true;
    const { service: s } = service();
    await s.addDomain("envio.exemplo.com.br", { confirmExistingMail: true });
    restartFails = false;
    calls.length = 0;
    await expect(s.syncTls()).resolves.toBe("restarted");
    expect(calls.filter((c) => c === "applyTls restart=true")).toHaveLength(1);
    expect((await s.listDomains())[0]?.dkimRestartPending).toBeUndefined();
    calls.length = 0;
    await s.syncTls();
    expect(calls.filter((c) => c.startsWith("applyTls"))).toHaveLength(0);
  });

  it("cadastros simultâneos: nunca dois reinícios ao mesmo tempo, e os que esperam dividem o mesmo", async () => {
    restartDelayMs = 30;
    const { service: s } = service();
    const results = await Promise.all(
      ["a.exemplo.com.br", "b.exemplo.com.br", "c.exemplo.com.br", "d.exemplo.com.br"].map((d) =>
        s.addDomain(d, { confirmExistingMail: true }),
      ),
    );
    expect(maxActive).toBe(1);
    const restarts = calls.filter((c) => c === "applyTls restart=true").length;
    expect(restarts).toBeGreaterThanOrEqual(1);
    expect(restarts).toBeLessThan(4);
    // todos saem sem pendência: o último reinício cobriu quem cadastrou antes dele
    expect(results.every((r) => r.dkimRestartPending === undefined)).toBe(true);
    expect((await s.listDomains()).every((d) => d.dkimRestartPending === undefined)).toBe(true);
  });

  it("sincronização do TLS e cadastro não reiniciam em cima um do outro", async () => {
    restartDelayMs = 30;
    const { service: s } = service();
    const other = service().service;
    await s.addDomain("a.exemplo.com.br", { confirmExistingMail: true });
    maxActive = 0;
    await Promise.all([s.addDomain("b.exemplo.com.br", { confirmExistingMail: true }), other.repairAdminAuth().catch(() => undefined), s.syncTls().catch(() => undefined)]);
    expect(maxActive).toBeLessThanOrEqual(1);
  });
});
