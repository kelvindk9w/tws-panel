/**
 * Com o app de verdade (buildApp): a adoção que a restauração do e-mail
 * dispara tem de chegar ao MESMO serviço que a tela usa. O serviço de e-mail
 * mora dentro do plugin de rotas (o Fastify isola), e uma versão anterior
 * chamava `app.mailService` no escopo raiz, onde ele não existe: a adoção
 * nunca rodava em produção e os testes (adotador falso) não viam.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, SETUP_TOKEN_HEADER } from "@paas/core";
import { removeDir } from "./helpers/tmp.js";

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async joinMailNetworks() {}
    async leaveProjectNetwork() {}
    async connectContainer() {}
    async status() {
      return { installed: true, running: true, version: "0.11.8", image: "x", containerName: "paas-stalwart", hostname: "mail.test", ports: MAIL_DEFAULT_PORTS, message: null };
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const ADMIN = "admin-secret-de-teste";
const DKIM_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".padEnd(300, "A");
const TOKEN = "token-de-teste-wiring";
const saved: Record<string, string | undefined> = {};
let dir = "";

const principals = [
  { type: "domain", name: "brisa.example.com" },
  { type: "individual", name: "contato@brisa.example.com", emails: ["contato@brisa.example.com"], secrets: ["$6$HASH"] },
];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-wiring-"));
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({ adminSecret: ADMIN, hostname: null, domains: {}, mailboxes: {}, projects: {} }),
  );
  await writeFile(path.join(dir, "setup-token"), TOKEN);
  for (const [k, v] of Object.entries({
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
  })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/principal") {
        const items = principals.filter((p) => p.type === u.searchParams.get("type"));
        return new Response(JSON.stringify({ data: { items, total: items.length } }), { status: 200 });
      }
      if (u.pathname.startsWith("/api/dkim/")) return new Response(JSON.stringify({ data: DKIM_KEY }), { status: 200 });
      return new Response(`{"data":null}`, { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await removeDir(dir);
});

describe("restauração do e-mail → serviço da tela (app real)", () => {
  it("o adotador do backup cadastra no mesmo serviço que lista na tela", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const headers = { [SETUP_TOKEN_HEADER]: TOKEN };
      // a tela carrega o cadastro (vazio) antes da restauração
      const before = await app.inject({ method: "GET", url: "/api/mail/domains", headers });
      expect(before.statusCode).toBe(200);
      expect(before.json().domains).toEqual([]);

      const opts = app.backupService as unknown as { mailAdopt?: { adopt(): Promise<{ domains: string[]; mailboxes: string[] }> } };
      expect(opts.mailAdopt).toBeDefined();
      const result = await opts.mailAdopt!.adopt();
      expect(result.domains).toEqual(["brisa.example.com"]);
      expect(result.mailboxes).toEqual(["contato@brisa.example.com"]);

      const after = await app.inject({ method: "GET", url: "/api/mail/domains", headers });
      expect(after.json().domains.map((d: { name: string }) => d.name)).toEqual(["brisa.example.com"]);
      const boxes = await app.inject({ method: "GET", url: "/api/mail/domains/brisa.example.com/mailboxes", headers });
      expect(boxes.json().mailboxes.map((b: { id: string }) => b.id)).toEqual(["contato@brisa.example.com"]);
    } finally {
      await app.close();
    }
  });
});
