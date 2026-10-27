/**
 * Caixa de teste de e-mail no DeployService: com ela ligada, o SMTP do projeto (o do e-mail do
 * painel, o que a pessoa definiu nas Variáveis e o ligado ao e-mail) aponta para o Mailpit; o
 * e-mail real nunca chega ao app. Ao desligar, tudo volta ao normal. Remover o projeto remove a caixa.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService, type MailTestProvider } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-dmt-"));
  svc = new DeployService({ dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig, {});
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const projeto = (name = "api") => svc.createProject({ name, ingestMode: "git", source: `https://github.com/k/${name}`, branch: "main", domain: `${name}.localhost` });

type Fn = (p: unknown) => Promise<Record<string, string>>;
const ctx = () =>
  (svc as unknown as { engineCtx: { envForProject: Fn; injectEnvForProject: Fn; mailTestForProject: (p: unknown) => Promise<{ network: string } | null> } }).engineCtx;

function caixa(on: boolean): MailTestProvider & { prepared: number; removedSlugs: string[] } {
  const state = {
    prepared: 0,
    removedSlugs: [] as string[],
    active: async () => (on ? { host: "paas-mailtest-api", password: "senha-gerada" } : null),
    prepare: async () => {
      state.prepared++;
      return on ? { network: "paas-mailtest-api" } : null;
    },
    removed: async (p: { slug: string }) => void state.removedSlugs.push(p.slug),
  };
  return state;
}

const EMAIL_REAL = { SMTP_HOST: "mail.example.com", SMTP_PORT: "587", SMTP_USER: "api@example.com", SMTP_PASS: "senha-real", MAIL_FROM: "api@example.com", MAIL_FROM_NAME: "Api" };

describe("caixa de teste ligada", () => {
  it("o e-mail do painel deixa de chegar ao app: SMTP_* vão para o Mailpit, MAIL_FROM segue", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setMailTestProvider(caixa(true));
    const expected = { SMTP_HOST: "paas-mailtest-api", SMTP_PORT: "1025", SMTP_USER: "mailtest", SMTP_PASS: "senha-gerada", MAIL_FROM: "api@example.com", MAIL_FROM_NAME: "Api" };
    expect(await ctx().envForProject(p)).toEqual(expected);
    // e é o que vai para todos os serviços do compose
    expect(await ctx().injectEnvForProject(p)).toEqual(expected);
    expect(JSON.stringify(await ctx().envForProject(p))).not.toContain("senha-real");
    expect(JSON.stringify(await ctx().envForProject(p))).not.toContain("mail.example.com");
  });

  it("projeto SEM e-mail do painel também recebe as SMTP_* do Mailpit", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    expect(await ctx().envForProject(p)).toEqual({ SMTP_HOST: "paas-mailtest-api", SMTP_PORT: "1025", SMTP_USER: "mailtest", SMTP_PASS: "senha-gerada" });
    expect(await svc.providedEnvKeys(p.id)).toEqual(["SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_USER"]);
  });

  it("as SMTP_* e os nomes parecidos que a pessoa definiu nas Variáveis também são redirecionados", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    await svc.setEnv(p.id, [
      { key: "SMTP_HOST", value: "smtp.provedor.example.com" },
      { key: "MAIL_HOST", value: "smtp.provedor.example.com" },
      { key: "MAIL_PASSWORD", value: "senha-do-provedor" },
      { key: "MAIL_ENCRYPTION", value: "tls" },
      { key: "DATABASE_URL", value: "postgres://x" },
    ]);
    const env = await ctx().envForProject(p);
    expect(env).toMatchObject({
      SMTP_HOST: "paas-mailtest-api",
      MAIL_HOST: "paas-mailtest-api",
      MAIL_PASSWORD: "senha-gerada",
      MAIL_ENCRYPTION: "null",
      DATABASE_URL: "postgres://x",
    });
    expect(JSON.stringify(env)).not.toContain("provedor");
  });

  it("variável ligada ao e-mail (EMAIL_HOST ← SMTP_HOST) segue o Mailpit; MAIL_FROM segue o e-mail", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setLinkedEnvProvider(async () => ({ EMAIL_HOST: "mail.example.com", SENHA_SMTP: "senha-real", REMETENTE: "api@example.com" }));
    svc.setEnvLinkSourcesProvider(async () => ({ EMAIL_HOST: "SMTP_HOST", SENHA_SMTP: "SMTP_PASS", REMETENTE: "MAIL_FROM" }));
    svc.setMailTestProvider(caixa(true));
    const env = await ctx().envForProject(p);
    expect(env.EMAIL_HOST).toBe("paas-mailtest-api");
    expect(env.SENHA_SMTP).toBe("senha-gerada");
    expect(env.REMETENTE).toBe("api@example.com");
    expect(JSON.stringify(env)).not.toContain("senha-real");
  });

  it("a tela de Variáveis lista o que é redirecionado; a senha continua fora da listagem", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setLinkedEnvProvider(async () => ({ EMAIL_HOST: "mail.example.com" }));
    svc.setEnvLinkSourcesProvider(async () => ({ EMAIL_HOST: "SMTP_HOST", REMETENTE: "MAIL_FROM" }));
    svc.setMailTestProvider(caixa(true));
    await svc.setEnv(p.id, [{ key: "MAIL_PORT", value: "587" }, { key: "OUTRA", value: "x" }, { key: "VAZIA", value: "" }]);
    const info = await svc.mailTestInfo(p.id);
    expect(info).toEqual({ host: "paas-mailtest-api", variables: ["EMAIL_HOST", "MAIL_PORT", "SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_USER"] });
    const values = await svc.providedEnvValues(p.id);
    expect(values.SMTP_HOST).toBe("paas-mailtest-api");
    expect(values.SMTP_PASS).toBeUndefined();
    expect(await svc.revealProvidedEnv(p.id, "SMTP_PASS")).toBe("senha-gerada");
  });

  it("deploy e reinício sobem a caixa e usam a rede dela", async () => {
    const p = await projeto();
    const provider = caixa(true);
    svc.setMailTestProvider(provider);
    expect(await ctx().mailTestForProject(p)).toEqual({ network: "paas-mailtest-api" });
    expect(provider.prepared).toBe(1);
  });

  it("as senhas do Mailpit são mascaradas na aba Logs como qualquer segredo do projeto", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    expect(await svc.logSecretValues(p)).toContain("senha-gerada");
  });
});

describe("caixa desligada ou ausente", () => {
  it("nada muda: o e-mail do painel e as Variáveis seguem como sempre", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setLinkedEnvProvider(async () => ({ EMAIL_HOST: "mail.example.com" }));
    svc.setEnvLinkSourcesProvider(async () => ({ EMAIL_HOST: "SMTP_HOST" }));
    await svc.setEnv(p.id, [{ key: "MAIL_HOST", value: "smtp.provedor.example.com" }]);
    for (const provider of [caixa(false), null]) {
      if (provider) svc.setMailTestProvider(provider);
      expect(await ctx().envForProject(p)).toEqual({ ...EMAIL_REAL, MAIL_HOST: "smtp.provedor.example.com", EMAIL_HOST: "mail.example.com" });
      expect(await svc.mailTestInfo(p.id)).toBeNull();
      expect(await ctx().mailTestForProject(p)).toBeNull();
    }
  });
});

describe("remover o projeto", () => {
  it("remove a caixa de teste junto; falha vira aviso no log e não impede a remoção", async () => {
    const p = await projeto();
    const provider = caixa(true);
    svc.setMailTestProvider(provider);
    const log: string[] = [];
    vi.spyOn((svc as unknown as { engine: { remove: () => Promise<void> } }).engine, "remove").mockResolvedValue(undefined);
    await svc.deleteProject(p.id, false, (c) => log.push(c));
    expect(provider.removedSlugs).toEqual([p.slug]);

    const q = await projeto("loja");
    svc.setMailTestProvider({ ...provider, removed: async () => Promise.reject(new Error("daemon fora")) });
    const log2: string[] = [];
    await svc.deleteProject(q.id, false, (c) => log2.push(c));
    expect(log2.join("")).toMatch(/caixa de teste de e-mail.*daemon fora.*paas-mailtest-loja/s);
    expect(await svc.getProject(q.id)).toBeNull();
  });

  it("falha que não é Error também aparece", async () => {
    const q = await projeto("loja");
    svc.setMailTestProvider({ ...caixa(true), removed: async () => Promise.reject("texto") });
    vi.spyOn((svc as unknown as { engine: { remove: () => Promise<void> } }).engine, "remove").mockResolvedValue(undefined);
    const log: string[] = [];
    await svc.deleteProject(q.id, false, (c) => log.push(c));
    expect(log.join("")).toContain("texto");
  });
});
