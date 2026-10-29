/**
 * Caixa de teste de e-mail no DeployService: com ela ligada, TODO o conjunto de variáveis de SMTP que o painel
 * conhece (host, porta, usuário, senha, URL única, transporte) aponta para o Mailpit, em todos os serviços, acima
 * do que o projeto salvou; o e-mail real nunca chega ao app. Ao desligar, tudo volta ao normal. O "aplicado" só
 * vale depois de um deploy/reinício bem-sucedido, com a MESMA fotografia do começo. Remover o projeto remove a caixa.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService, type MailTestProvider, type MailTestSnapshot } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let svc: DeployService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-dmt-"));
  svc = new DeployService({ dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig, {});
});
afterEach(async () => {
  // os jobs de reinício gravam o estado depois de marcar o fim: deixa terminar antes de apagar a pasta
  await svc.idle();
  await removeDir(dataDir);
});

const projeto = (name = "api") => svc.createProject({ name, ingestMode: "git", source: `https://github.com/k/${name}`, branch: "main", domain: `${name}.localhost` });

type Fn = (p: unknown) => Promise<Record<string, string>>;
const ctx = () =>
  (svc as unknown as { engineCtx: { envForProject: Fn; injectEnvForProject: Fn; mailTestForProject: (p: unknown) => Promise<{ network: string } | null> } }).engineCtx;

const BOX = { host: "paas-mailtest-api", password: "senha-gerada" };

function caixa(on: boolean): MailTestProvider & { prepared: Array<MailTestSnapshot | null>; removedSlugs: string[]; appliedVersions: string[] } {
  const box = on ? BOX : null;
  const state = {
    prepared: [] as Array<MailTestSnapshot | null>,
    removedSlugs: [] as string[],
    appliedVersions: [] as string[],
    active: async () => box,
    snapshot: async () => ({ version: on ? "v-on" : "off", box }),
    prepare: async (_p: unknown, snap: MailTestSnapshot | null) => {
      state.prepared.push(snap);
      return (snap ? snap.box !== null : on) ? { network: "paas-mailtest-api" } : null;
    },
    pending: async () => null as "on" | "off" | null,
    applied: async (_p: unknown, version: string) => void state.appliedVersions.push(version),
    removed: async (p: { slug: string }) => void state.removedSlugs.push(p.slug),
  };
  return state;
}

const EMAIL_REAL = { SMTP_HOST: "mail.example.com", SMTP_PORT: "587", SMTP_USER: "api@example.com", SMTP_PASS: "senha-real", MAIL_FROM: "api@example.com", MAIL_FROM_NAME: "Api" };
const URL_MAILPIT = "smtp://mailtest:senha-gerada@paas-mailtest-api:1025";

describe("caixa de teste ligada", () => {
  it("o e-mail do painel deixa de chegar ao app: SMTP_* vão para o Mailpit, MAIL_FROM segue", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setMailTestProvider(caixa(true));
    const expected = { SMTP_HOST: "paas-mailtest-api", SMTP_PORT: "1025", SMTP_USER: "mailtest", SMTP_PASS: "senha-gerada", MAIL_FROM: "api@example.com", MAIL_FROM_NAME: "Api" };
    expect(await ctx().envForProject(p)).toMatchObject(expected);
    // e é o que vai para todos os serviços do compose
    expect(await ctx().injectEnvForProject(p)).toMatchObject(expected);
    expect(JSON.stringify(await ctx().envForProject(p))).not.toContain("senha-real");
    expect(JSON.stringify(await ctx().envForProject(p))).not.toContain("mail.example.com");
  });

  it("REVISÃO B1: projeto que não definiu nada recebe TODOS os nomes (Laravel, Rails, Symfony, Spring, URL única...)", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    for (const fn of [ctx().envForProject, ctx().injectEnvForProject]) {
      expect(await fn(p)).toMatchObject({
        MAIL_HOST: "paas-mailtest-api",
        MAIL_MAILER: "smtp",
        MAIL_SCHEME: "smtp",
        MAIL_ENCRYPTION: "null",
        SMTP_ADDRESS: "paas-mailtest-api",
        SPRING_MAIL_HOST: "paas-mailtest-api",
        GOTRUE_SMTP_HOST: "paas-mailtest-api",
        SMTP_URL: URL_MAILPIT,
        MAIL_URL: URL_MAILPIT,
        MAILER_DSN: URL_MAILPIT,
        EMAIL_URL: URL_MAILPIT,
        EMAIL_SERVER: URL_MAILPIT,
      });
    }
  });

  it("REVISÃO B1: o que a pessoa salvou nas Variáveis (host real, URL real) nunca vence o Mailpit", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    await svc.setEnv(p.id, [
      { key: "SMTP_URL", value: "smtps://usuario:real@smtp.provedor.example.com:465" },
      { key: "MAIL_MAILER", value: "mailgun" },
      { key: "SMTP_ADDRESS", value: "smtp.provedor.example.com" },
    ]);
    const env = await ctx().envForProject(p);
    expect(env.SMTP_URL).toBe(URL_MAILPIT);
    expect(env.MAIL_MAILER).toBe("smtp");
    expect(env.SMTP_ADDRESS).toBe("paas-mailtest-api");
    expect(JSON.stringify(env)).not.toContain("provedor");
  });

  it("projeto SEM e-mail do painel também recebe o conjunto; a tela lista tudo o que é fornecido", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    expect(await ctx().envForProject(p)).toMatchObject({ SMTP_HOST: "paas-mailtest-api", SMTP_PORT: "1025", SMTP_USER: "mailtest", SMTP_PASS: "senha-gerada" });
    expect(await svc.providedEnvKeys(p.id)).toEqual(expect.arrayContaining(["SMTP_HOST", "SMTP_PASS", "SMTP_URL", "MAIL_MAILER", "SPRING_MAIL_HOST"]));
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

  it("variável ligada ao e-mail (EMAIL_HOST <- SMTP_HOST) segue o Mailpit; MAIL_FROM segue o e-mail", async () => {
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

  it("a tela de Variáveis lista o que é redirecionado; a senha (e a URL que a carrega) ficam fora da listagem", async () => {
    const p = await projeto();
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setLinkedEnvProvider(async () => ({ EMAIL_HOST: "mail.example.com" }));
    svc.setEnvLinkSourcesProvider(async () => ({ EMAIL_HOST: "SMTP_HOST", REMETENTE: "MAIL_FROM" }));
    svc.setMailTestProvider(caixa(true));
    await svc.setEnv(p.id, [{ key: "MAIL_PORT", value: "587" }, { key: "OUTRA", value: "x" }, { key: "VAZIA", value: "" }]);
    const info = await svc.mailTestInfo(p.id);
    expect(info?.host).toBe("paas-mailtest-api");
    expect(info?.variables).toEqual(expect.arrayContaining(["EMAIL_HOST", "MAIL_PORT", "SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_USER", "SMTP_URL", "MAIL_MAILER"]));
    const values = await svc.providedEnvValues(p.id);
    expect(values.SMTP_HOST).toBe("paas-mailtest-api");
    expect(values.SMTP_PASS).toBeUndefined();
    expect(values.SMTP_URL).toBeUndefined();
    expect(JSON.stringify(values)).not.toContain("senha-gerada");
    expect(await svc.revealProvidedEnv(p.id, "SMTP_PASS")).toBe("senha-gerada");
  });

  it("fora de um job só LÊ o estado de agora: nunca grava fotografia (religar containers no boot recebe null)", async () => {
    const p = await projeto();
    const provider = caixa(true);
    svc.setMailTestProvider(provider);
    expect(await ctx().envForProject(p)).toMatchObject({ SMTP_HOST: "paas-mailtest-api" });
    expect(await ctx().mailTestForProject(p)).toEqual({ network: "paas-mailtest-api" });
    expect(provider.prepared).toEqual([null]);
  });

  it("as senhas do Mailpit são mascaradas na aba Logs como qualquer segredo do projeto", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    expect(await svc.logSecretValues(p)).toContain("senha-gerada");
  });

  it("B3: só as senhas são mascaradas; o usuário (mailtest), o host, a porta e false/smtp não", async () => {
    const p = await projeto();
    svc.setMailTestProvider(caixa(true));
    const secrets = await svc.logSecretValues(p);
    expect(secrets).toContain("senha-gerada");
    // a URL única leva a senha, então segue mascarada
    expect(secrets.some((v) => v.startsWith("smtp://mailtest:"))).toBe(true);
    for (const harmless of ["mailtest", "paas-mailtest-api", "1025", "false", "smtp", "null"]) expect(secrets).not.toContain(harmless);
  });

  it("M1: a tela de Variáveis sabe se a caixa já vale (active), se falta reiniciar (pendingOn) e se foi desligada sem reiniciar (pendingOff)", async () => {
    const p = await projeto();
    const on = caixa(true);
    svc.setMailTestProvider(on);
    expect((await svc.mailTestInfo(p.id))?.state).toBe("active");
    svc.setMailTestProvider({ ...on, pending: async () => "on" });
    const pendingOn = await svc.mailTestInfo(p.id);
    expect(pendingOn?.state).toBe("pendingOn");
    expect(pendingOn?.variables).toContain("SMTP_HOST");
    // desligada, mas os containers ainda apontam para a caixa
    svc.setMailTestProvider({ ...caixa(false), pending: async () => "off" });
    const pendingOff = await svc.mailTestInfo(p.id);
    expect(pendingOff).toMatchObject({ host: "paas-mailtest-api", state: "pendingOff" });
    expect(pendingOff?.variables).toContain("SMTP_HOST");
    // desligada e em dia: nada a mostrar
    svc.setMailTestProvider(caixa(false));
    expect(await svc.mailTestInfo(p.id)).toBeNull();
  });
});

describe("REVISÃO B2: o aplicado só vale depois de um deploy/reinício que terminou bem", () => {
  const recreateWith = (fn: () => Promise<void>) => {
    const recreate = vi.fn(fn);
    (svc as unknown as { engine: { recreate: typeof recreate } }).engine.recreate = recreate;
  };

  it("o ambiente do deploy e o registro de aplicado usam a MESMA fotografia, mesmo que a caixa mude no meio", async () => {
    const p = await projeto();
    p.lastDeployStatus = "success";
    let on = false;
    const provider = {
      ...caixa(false),
      active: async () => (on ? BOX : null),
      snapshot: async () => ({ version: on ? "v-on" : "off", box: on ? BOX : null }),
    };
    svc.setMailTestProvider(provider);
    recreateWith(async () => {
      await ctx().envForProject(p); // começo: caixa desligada
      on = true; // alguém liga durante o build
      expect(await ctx().injectEnvForProject(p)).toEqual({}); // continua valendo a fotografia
      expect(await ctx().mailTestForProject(p)).toBeNull();
    });
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    // o que os containers ganharam foi "off", não a caixa que foi ligada depois
    expect(provider.appliedVersions).toEqual(["off"]);
    // a fotografia foi solta: o que vem depois volta a olhar o estado de agora
    expect((await ctx().injectEnvForProject(p)).SMTP_HOST).toBe("paas-mailtest-api");
  });

  it("reinício que falha NÃO registra aplicado e solta a fotografia", async () => {
    const p = await projeto();
    p.lastDeployStatus = "success";
    const provider = caixa(true);
    svc.setMailTestProvider(provider);
    recreateWith(async () => {
      await ctx().envForProject(p);
      throw new Error("container não ficou saudável");
    });
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("failed"));
    expect(provider.appliedVersions).toEqual([]);
    await ctx().mailTestForProject(p);
    expect(provider.prepared.at(-1)).toBeNull();
  });

  it("registrar o aplicado nunca derruba o reinício", async () => {
    const p = await projeto();
    p.lastDeployStatus = "success";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    svc.setMailTestProvider({ ...caixa(true), applied: async () => Promise.reject(new Error("disco cheio")) });
    recreateWith(async () => void (await ctx().envForProject(p)));
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disco cheio"));
    warn.mockRestore();
  });

  it("a fotografia é tirada pelo job, no começo, mesmo que o motor nem peça o ambiente", async () => {
    const p = await projeto();
    p.lastDeployStatus = "success";
    const provider = caixa(true);
    svc.setMailTestProvider(provider);
    recreateWith(async () => undefined);
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(provider.appliedVersions).toEqual(["v-on"]);
  });

  it("REVISÃO R2-B1: GET da tela (fuso, guardrails) no meio do job NÃO troca a fotografia nem o aplicado", async () => {
    const p = await projeto();
    p.lastDeployStatus = "success";
    let on = false;
    const prepared: Array<MailTestSnapshot | null> = [];
    const provider = {
      ...caixa(false),
      active: async () => (on ? BOX : null),
      snapshot: async () => ({ version: on ? "v-on" : "off", box: on ? BOX : null }),
      prepare: async (_p: unknown, snap: MailTestSnapshot | null) => {
        prepared.push(snap);
        return snap?.box ? { network: "paas-mailtest-api" } : null;
      },
    };
    svc.setEnvProvider(async () => EMAIL_REAL);
    svc.setMailTestProvider(provider);
    let envNoJob: Record<string, string> = {};
    recreateWith(async () => {
      const env = await ctx().envForProject(p); // Etapa 2: caixa desligada
      expect(env.SMTP_HOST).toBe("mail.example.com");
      on = true; // a pessoa liga a caixa durante o build
      await (svc as unknown as { timezoneDefinitions: (x: unknown) => Promise<unknown> }).timezoneDefinitions(p); // GET do fuso
      await (svc as unknown as { guardrailVariables: (x: unknown) => Promise<unknown> }).guardrailVariables(p); // GET de guardrails
      expect((await ctx().injectEnvForProject(p)).SMTP_HOST).toBe("mail.example.com");
      await ctx().mailTestForProject(p);
    });
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(prepared).toEqual([{ version: "off", box: null }]);
    expect(provider.appliedVersions).toEqual(["off"]);
    // depois do job, fora dele, ler de novo mostra o estado de agora e não grava nada
    envNoJob = await ctx().envForProject(p);
    expect(envNoJob.SMTP_HOST).toBe("paas-mailtest-api");
    await ctx().mailTestForProject(p);
    expect(prepared.at(-1)).toBeNull();
  });
});

describe("variáveis que a caixa não controla", () => {
  it("nomes das Variáveis do painel que parecem de e-mail e não são redirecionados; falha na leitura vira lista vazia", async () => {
    const p = await projeto();
    await svc.setEnv(p.id, [{ key: "RESEND_API_KEY", value: "k" }, { key: "MAIL_HOST", value: "x" }]);
    expect(await svc.mailTestUncontrolled(p)).toEqual([{ name: "RESEND_API_KEY", file: "Variáveis do painel", kind: "api" }]);
    vi.spyOn((svc as unknown as { env: { get: () => Promise<never> } }).env, "get").mockRejectedValue(new Error("cofre"));
    expect(await svc.mailTestUncontrolled(p)).toEqual([]);
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
    expect(log2.join("")).toContain("docker network rm");
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
