/**
 * Segredo e endereço do aviso de envio (MTA hook) no MailService: derivado da
 * senha de administração (nada novo para guardar), só com o painel em
 * container, comparação em tempo constante, e entra na configuração do
 * Stalwart (que muda a impressão digital, para o servidor reiniciar uma vez).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

const managers: Array<Record<string, unknown>> = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(opts: Record<string, unknown>) {
      managers.push(opts);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let config: ServerConfig;

async function seed(adminSecret: string | null) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(path.join(dir, "mail", "mail.json"), JSON.stringify({ adminSecret, domains: {}, mailboxes: {}, projects: {} }));
}

beforeEach(async () => {
  managers.length = 0;
  dir = await mkdtemp(path.join(tmpdir(), "paas-hook-secret-"));
  config = { dataDir: dir, mailPorts: { ...MAIL_DEFAULT_PORTS }, mailHostname: null, publicIp: "203.0.113.10", publicIpv6: null, panelDomain: null } as unknown as ServerConfig;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (inContainer: boolean) => new MailService(config, { inContainer, log: () => {} });

describe("aviso de envio — MailService", () => {
  it("fora de container, sem servidor criado ou com a porta 0: captura desligada", async () => {
    await seed("segredo-admin");
    expect(await make(false).sendHookConfigured()).toBe(false);
    expect(await make(false).verifySendHookSecret("x")).toBe(false);
    await seed(null);
    expect(await make(true).sendHookConfigured()).toBe(false);
    await seed("segredo-admin");
    config = { ...config, mailHookPort: 0 };
    expect(await make(true).sendHookConfigured()).toBe(false);
  });

  it("em container: configurada, e o segredo é verificado (só o certo passa)", async () => {
    await seed("segredo-admin");
    const s = make(true);
    expect(await s.sendHookConfigured()).toBe(true);
    // pega o segredo que vai para a configuração do Stalwart
    (s as unknown as { manager(): unknown }).manager();
    const hook = managers[0]!.sendHook as { url: string; secret: string };
    expect(hook.url).toBe("http://tws-panel:9100/mail-hook/send");
    expect(hook.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.verifySendHookSecret(hook.secret)).toBe(true);
    expect(await s.verifySendHookSecret(hook.secret + "0")).toBe(false);
    expect(await s.verifySendHookSecret("")).toBe(false);
    expect(await s.verifySendHookSecret("segredo-admin")).toBe(false);
  });

  it("outra senha de administração, outro segredo; porta configurável", async () => {
    config = { ...config, mailHookPort: 9555 };
    await seed("a");
    const one = make(true);
    await one.sendHookConfigured();
    (one as unknown as { manager(): unknown }).manager();
    await seed("b");
    const two = make(true);
    await two.sendHookConfigured();
    (two as unknown as { manager(): unknown }).manager();
    const [a, b] = managers.map((m) => m.sendHook as { url: string; secret: string });
    expect(a!.secret).not.toBe(b!.secret);
    expect(a!.url).toBe("http://tws-panel:9555/mail-hook/send");
  });

  it("o segredo não aparece no espelho local do config.toml fora do container (sem captura)", async () => {
    await seed("a");
    const s = make(false);
    await s.sendHookConfigured();
    (s as unknown as { manager(): unknown }).manager();
    expect(managers[0]!.sendHook).toBeNull();
  });
});
