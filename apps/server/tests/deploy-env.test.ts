/**
 * deploy-env.test.ts — as variáveis do projeto chegam ao deploy junto com as
 * do e-mail (SMTP); com o mesmo nome, a definida pelo operador vence. Salvar
 * fica na auditoria só com os NOMES. Remover o projeto apaga as variáveis.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;
const record = vi.fn(async () => ({}));

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-denv-"));
  record.mockClear();
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record } as never },
  );
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function projeto() {
  return svc.createProject({ name: "api", ingestMode: "git", source: "https://github.com/k/api", branch: "main", domain: "api.localhost" });
}

describe("variáveis do projeto no deploy", () => {
  it("junta com as do e-mail; a do operador vence", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => ({ SMTP_HOST: "mail", SMTP_PORT: "587" }));
    await svc.setEnv(p.id, [
      { key: "SMTP_PORT", value: "2525" },
      { key: "DATABASE_URL", value: "postgres://x" },
    ]);
    const ctx = (svc as unknown as { engineCtx: { envForProject: (p: unknown) => Promise<Record<string, string>> } }).engineCtx;
    expect(await ctx.envForProject(p)).toEqual({ SMTP_HOST: "mail", SMTP_PORT: "2525", DATABASE_URL: "postgres://x" });
  });

  it("auditoria só com os nomes, nunca os valores", async () => {
    const p = await projeto();
    await svc.setEnv(p.id, [{ key: "API_KEY", value: "valor-super-secreto" }]);
    const entradas = JSON.stringify(record.mock.calls);
    expect(entradas).toContain("API_KEY");
    expect(entradas).not.toContain("valor-super-secreto");
  });

  it("remover o projeto apaga as variáveis", async () => {
    const p = await projeto();
    await svc.setEnv(p.id, [{ key: "A", value: "1" }]);
    (svc as unknown as { engine: { remove: () => Promise<void>; syncCaddy: () => Promise<void> } }).engine.remove = async () => undefined;
    (svc as unknown as { engine: { syncCaddy: () => Promise<void> } }).engine.syncCaddy = async () => undefined;
    await svc.deleteProject(p.id, false, () => undefined);
    const store = (svc as unknown as { env: { get: (id: string) => Promise<unknown[]> } }).env;
    expect(await store.get(p.id)).toEqual([]);
  });
});
