/**
 * Domínios dinâmicos — as ligações que só existem em app.ts, com o app de verdade (buildApp):
 *  - o ouvido do `ask` só sobe no painel em container, servido pelo Caddy e com a porta ligada;
 *  - o que o Caddy pergunta é respondido pelo serviço (nome cadastrado = 200, o resto = 403);
 *  - o Caddyfile recebe a URL do ask e as rotas dos projetos;
 *  - sem container (dev, testes) nada sobe e a tela explica o motivo.
 * O Docker é simulado (`/.dockerenv` por variável) e o Caddy nunca roda (setup-no-docker).
 */
import { request } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaddyManager } from "@paas/deploy";

const fake = vi.hoisted(() => ({ inContainer: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]) => (p === "/.dockerenv" ? fake.inContainer : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

const saved: Record<string, string | undefined> = {};
let dir = "";
let askPort = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Segredo que o painel grava em data/ e põe na URL do ask (o Caddy o repassa). */
async function secret(): Promise<string> {
  return (await readFile(path.join(dir, "dynamic-ask.secret"), "utf8")).trim();
}

function ask(port: number, domain: string, key?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/caddy/ask?${key ? `k=${key}&` : ""}domain=${encodeURIComponent(domain)}`, method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function env(extra: Record<string, string>) {
  for (const [k, v] of Object.entries({
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
    ...extra,
  })) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-dyn-app-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste-dinamicos");
  askPort = await freePort();
  fake.inContainer = false;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
  await rm(dir, { recursive: true, force: true });
});

async function createProject(app: Awaited<ReturnType<typeof import("../src/app.js").buildApp>>) {
  const created = await app.deployService.createProject({
    name: "saas",
    ingestMode: "git",
    source: "https://github.com/k/x",
    branch: "main",
    domain: "saas.example.com",
  });
  return created.id;
}

describe("domínios dinâmicos no app", () => {
  it("em container e servido pelo Caddy: o ask sobe, autoriza o cadastrado e recusa o resto; o Caddyfile recebe a URL do ask", async () => {
    fake.inContainer = true;
    env({ PAAS_PANEL_DOMAIN: "painel.example.com", PAAS_ASK_PORT: String(askPort) });
    const apply = vi.mocked(CaddyManager.prototype.apply);
    const { buildApp } = await import("../src/app.js");
    // só app.escola.example aponta para a VPS (203.0.113.10); o resto não resolve ou resolve para outro IP
    const dnsResolver = {
      resolve4: async (host: string) => (host === "app.escola.example" ? ["203.0.113.10"] : host === "longe.escola.example" ? ["198.51.100.7"] : []),
      resolve6: async () => [],
    };
    const app = await buildApp({ dnsResolver });
    try {
      await app.ready();
      const projectId = await createProject(app);
      await app.dynamicDomains.add(projectId, "app.escola.example");
      await app.dynamicDomains.add(projectId, "longe.escola.example");
      await app.dynamicDomains.setSuffixes(projectId, [{ suffix: "clientes.example", openAll: false }]);
      const key = await secret();

      expect(await ask(askPort, "app.escola.example", key)).toBe(200);
      expect(await ask(askPort, "longe.escola.example", key)).toBe(403); // cadastrado, mas o DNS não aponta para esta VPS
      expect(await ask(askPort, "inventado.escola.example", key)).toBe(403);
      expect(await ask(askPort, "painel.example.com", key)).toBe(403); // site do próprio painel nunca
      expect(await ask(askPort, "saas.example.com", key)).toBe(403); // site fixo do projeto também não
      // sem o segredo (ou com outro) nada é respondido, nem para o nome cadastrado e apontado
      expect(await ask(askPort, "app.escola.example")).toBe(403);
      expect(await ask(askPort, "app.escola.example", "0".repeat(48))).toBe(403);
      // nada de segredo em texto no disco além do arquivo próprio (0600)
      expect(((await stat(path.join(dir, "dynamic-ask.secret"))).mode & 0o777).toString(8)).toBe("600");

      expect((await app.dynamicDomains.view(projectId)).routing).toEqual({ ready: true, reason: null });

      apply.mockClear();
      await app.deployService.refreshProxy();
      const options = apply.mock.calls.at(-1)?.[3] as { dynamic?: { askUrl: string; routes: Array<{ upstream: string; suffixes: string[]; hosts: string[] }> } } | undefined;
      expect(options?.dynamic?.askUrl).toBe(`http://tws-panel:${askPort}/caddy/ask?k=${key}`);
      expect(options?.dynamic?.routes).toEqual([expect.objectContaining({ upstream: "saas:80", suffixes: ["clientes.example"], hosts: ["app.escola.example", "longe.escola.example"] })]);
      // o mesmo segredo sobrevive a reabrir o painel (o Caddyfile já gravado continua valendo)
      const { loadAskSecret } = await import("../src/services/dynamic-ask-server.js");
      expect(await loadAskSecret(dir)).toBe(key);

      // o nome dinâmico trava o mesmo nome num site fixo
      await expect(app.deployService.addDomain(projectId, "app.escola.example")).rejects.toMatchObject({ code: "domain_in_use" });
    } finally {
      await app.close();
    }
    // fechou junto com o app
    await expect(ask(askPort, "app.escola.example")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("porta já ocupada: o painel sobe mesmo assim (sem o ask nenhum certificado novo sai)", async () => {
    fake.inContainer = true;
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(askPort, "0.0.0.0", resolve));
    env({ PAAS_PANEL_DOMAIN: "painel.example.com", PAAS_ASK_PORT: String(askPort) });
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await expect(app.ready()).resolves.toBeDefined();
    } finally {
      await app.close();
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  it("fora de container: nada sobe, o Caddyfile não ganha rota dinâmica e a tela explica", async () => {
    env({ PAAS_PANEL_DOMAIN: "painel.example.com", PAAS_ASK_PORT: String(askPort) });
    const apply = vi.mocked(CaddyManager.prototype.apply);
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const projectId = await createProject(app);
      await app.dynamicDomains.add(projectId, "app.escola.example");
      await expect(ask(askPort, "app.escola.example")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      const { routing } = await app.dynamicDomains.view(projectId);
      expect(routing.ready).toBe(false);
      expect(routing.reason).toMatch(/container/);
      apply.mockClear();
      await app.deployService.refreshProxy();
      const options = apply.mock.calls.at(-1)?.[3] as { dynamic?: unknown } | undefined;
      expect(options?.dynamic ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("em container, mas painel só por túnel (sem domínio): o proxy não alcança o painel", async () => {
    fake.inContainer = true;
    env({ PAAS_ASK_PORT: String(askPort), PAAS_PANEL_DOMAIN: "" });
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const projectId = await createProject(app);
      await expect(ask(askPort, "app.escola.example")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect((await app.dynamicDomains.view(projectId)).routing.reason).toMatch(/HTTPS/);
    } finally {
      await app.close();
    }
  });

  it("PAAS_ASK_PORT=0 desliga o ask e a tela diz isso", async () => {
    fake.inContainer = true;
    env({ PAAS_PANEL_DOMAIN: "painel.example.com", PAAS_ASK_PORT: "0" });
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
      const projectId = await createProject(app);
      expect((await app.dynamicDomains.view(projectId)).routing.reason).toMatch(/PAAS_ASK_PORT=0/);
    } finally {
      await app.close();
    }
  });
});
