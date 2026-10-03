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
    type Fn = (p: unknown) => Promise<Record<string, string>>;
    const ctx = (svc as unknown as { engineCtx: { envForProject: Fn; injectEnvForProject: Fn } }).engineCtx;
    // tudo vai para o .env do projeto (e para o -e do Dockerfile)…
    expect(await ctx.envForProject(p)).toEqual({ SMTP_HOST: "mail", SMTP_PORT: "2525", DATABASE_URL: "postgres://x" });
    // …mas só as do e-mail são injetadas em TODOS os serviços do compose
    expect(await ctx.injectEnvForProject(p)).toEqual({ SMTP_HOST: "mail", SMTP_PORT: "587" });
  });

  /**
   * Variáveis do app ligadas a valores do e-mail (02/10/2026): vão para o
   * .env como as do operador (o compose escolhe o destino), não para todos
   * os serviços; contam como fornecidas; a do operador continua vencendo.
   */
  it("ligadas ao e-mail: entram no .env, contam como fornecidas e não vão para todos os serviços", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => ({ SMTP_HOST: "mail", SMTP_PASS: "segredo" }));
    svc.setLinkedEnvProvider(async () => ({ SMTP_SENHA: "segredo", EMAIL_HOST: "mail" }));
    await svc.setEnv(p.id, [{ key: "EMAIL_HOST", value: "outro" }]);
    type Fn = (p: unknown) => Promise<Record<string, string>>;
    const ctx = (svc as unknown as { engineCtx: { envForProject: Fn; injectEnvForProject: Fn } }).engineCtx;
    expect(await ctx.envForProject(p)).toEqual({ SMTP_HOST: "mail", SMTP_PASS: "segredo", SMTP_SENHA: "segredo", EMAIL_HOST: "outro" });
    expect(await ctx.injectEnvForProject(p)).toEqual({ SMTP_HOST: "mail", SMTP_PASS: "segredo" });
    expect(await svc.providedEnvKeys(p.id)).toEqual(["EMAIL_HOST", "SMTP_HOST", "SMTP_PASS", "SMTP_SENHA"]);
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

describe("variáveis que o compose espera", () => {
  it("lê o compose do projeto e lista as variáveis (obrigatórias e com padrão)", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const p = await projeto();
    const src = path.join(dataDir, "projects", p.slug, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "compose.prod.yaml"), "services:\n  db:\n    environment:\n      A: ${POSTGRES_USER:?defina}\n      B: ${SMTP_HOST:-mailpit}\n");
    const proj = (await svc.getProject(p.id))!;
    proj.detection = { type: "compose", composeFile: "compose.prod.yaml" } as never;
    const r = await svc.composeVariablesFor(p.id);
    expect(r?.variables).toEqual([
      { name: "POSTGRES_USER", required: true, defaultValue: null },
      { name: "SMTP_HOST", required: false, defaultValue: "mailpit" },
    ]);
  });

  it("projeto que não é compose: null", async () => {
    const p = await projeto();
    expect(await svc.composeVariablesFor(p.id)).toBeNull();
  });
});

/**
 * Validação real (cassino, 01/10/2026): o deploy rodava com 8 obrigatórias
 * sem valor e morria no `docker compose up`. Agora nem começa: diz quais
 * faltam. O que o painel fornece (e-mail do projeto) conta como preenchido.
 */
describe("deploy barrado antes de começar quando falta variável obrigatória", () => {
  async function composeProject(compose: string) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const p = await projeto();
    const src = path.join(dataDir, "projects", p.slug, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "compose.paas.yaml"), compose);
    const proj = (await svc.getProject(p.id))!;
    proj.detection = { type: "compose", composeFile: "compose.paas.yaml", proxyService: "web", proxyPort: 80, warnings: [], details: [] } as never;
    return p;
  }
  const COMPOSE =
    "services:\n  web:\n    image: nginx:1.27\n    environment:\n      K: ${KYC_MODO:?defina}\n      E: ${EMAIL_DE:-${MAIL_FROM:?defina}}\n      S: ${SMTP_HOST:?ative o e-mail}\n";

  it("recusa com missing_env e a lista do que falta", async () => {
    const p = await composeProject(COMPOSE);
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "missing_env",
      missing: ["KYC_MODO", "MAIL_FROM", "SMTP_HOST"],
    });
  });

  it("e-mail do projeto ativo conta como preenchido; o resto vem das Variáveis", async () => {
    const p = await composeProject(COMPOSE);
    svc.setEnvProvider(async () => ({ SMTP_HOST: "mail", MAIL_FROM: "no-reply@x.com" }));
    await svc.setEnv(p.id, [{ key: "KYC_MODO", value: "demonstracao" }]);
    expect(await svc.providedEnvKeys(p.id)).toEqual(["MAIL_FROM", "SMTP_HOST"]);
    // (sem chamar startDeploy: ele dispararia o deploy de verdade em segundo plano)
    expect(await svc.missingEnvFor(p.id)).toEqual([]);
  });
});
