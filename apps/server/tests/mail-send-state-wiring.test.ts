/**
 * Ligação, no plugin de e-mail, do que mantém o status dos envios por SMTP em dia:
 *  - abrir a lista de envios pede a leitura do registro de entrega do Stalwart;
 *  - a reconciliação reaplica os resultados de entrega que o histórico já guardou.
 * Os dois fios saem de apps/server/src/routes/mail.ts; sem este teste, apagá-los não
 * derrubava nada e o status voltava a ficar em "na fila" até a leitura seguinte (5 min).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, SETUP_TOKEN_HEADER } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import type { ServerConfig } from "../src/config.js";
import { MailService } from "../src/services/mail-service.js";
import { MailEnviosService } from "../src/services/mail-envios-service.js";
import { MailSendLogService } from "../src/services/mail-send-log-service.js";
import { MailSendStore, type StoredSend } from "../src/services/mail-send-store.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const logs = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/services/stalwart-logs.js", () => ({ readStalwartLogs: logs.read }));

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const SENDER = { address: "loja@envio.test", mailbox: "loja@envio.test", projectId: "p1", system: false };

let ctx: AuthTestContext;
let app: FastifyInstance;
/** Leituras pedidas pela tela e ainda em andamento: o teste espera por elas antes de apagar a pasta. */
let inFlight: Array<Promise<unknown>> = [];

function deliveredLine(at: string, id: string): string {
  return `${at} INFO DSN success notification (delivery.dsn-success) queueId = ${id}, from = "loja@envio.test", to = ["a@x.org"], size = 1, total = 1, to = "a@x.org", hostname = "mx.dest.test", code = 250, details = "OK"`;
}

function stored(id: string, state: "queued" | "unconfirmed", at: string): StoredSend {
  return {
    id,
    at,
    from: "loja@envio.test",
    login: "loja@envio.test",
    mailbox: "loja@envio.test",
    origin: "project",
    projectId: "p1",
    projectName: "Loja",
    size: 10,
    attachments: [],
    recipients: [{ address: "a@x.org", domain: "x.org", state, deferrals: 0, updatedAt: null, nextRetryAt: null, remoteHost: null, error: null }],
    content: "none",
    truncated: false,
    captured: true,
  };
}

async function seed(rec: StoredSend) {
  const store = new MailSendStore(ctx.dir);
  await store.load();
  await store.put(rec);
}

beforeEach(async () => {
  inFlight = [];
  const refresh = MailEnviosService.prototype.refreshIfStale;
  vi.spyOn(MailEnviosService.prototype, "refreshIfStale").mockImplementation(function (this: MailEnviosService) {
    const p = refresh.call(this);
    inFlight.push(p);
    return p;
  });
  logs.read.mockReset();
  logs.read.mockResolvedValue(undefined);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(),
    listProjects: vi.fn(async () => [{ id: "p1", name: "Loja" }]),
  } as unknown as FastifyInstance["deployService"]);
  vi.spyOn(MailService.prototype, "enviosSenders").mockResolvedValue([SENDER]);
  vi.spyOn(MailService.prototype, "enviosServerCreated").mockResolvedValue(true);
  vi.spyOn(MailService.prototype, "enviosQueue").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(MailService.prototype, "listDomains").mockResolvedValue([{ name: "envio.test" }] as never);
  vi.spyOn(MailService.prototype, "sendHookConfigured").mockResolvedValue(true);
});

afterEach(async () => {
  await Promise.all(inFlight);
  vi.restoreAllMocks();
  await closeAuthTestApp(ctx);
});

const stateOf = async (url = "/api/mail/envios/saidas") =>
  ((await app.inject({ method: "GET", url, headers: auth })).json() as { items: Array<{ id: string; state: string }> }).items.map((i) => `${i.id}:${i.state}`);

describe("abrir a lista de envios", () => {
  it("lê o registro de entrega: o envio já entregue deixa de aparecer 'na fila' na abertura seguinte (sem esperar os 5 min)", async () => {
    const at = new Date().toISOString();
    await seed(stored("100", "queued", new Date(Date.now() - 60_000).toISOString()));
    logs.read.mockImplementation(async (_since: unknown, onLine: (l: string) => void) => onLine(deliveredLine(at, "100")));
    await app.register(mailRoutes);
    await app.ready();
    expect(logs.read).not.toHaveBeenCalled();
    // a primeira abertura pede a leitura (sem esperar por ela); as seguintes (a tela repete a cada ~10 s) veem o resultado
    await stateOf();
    await vi.waitFor(async () => expect(await stateOf()).toEqual(["100:delivered"]), { timeout: 3000, interval: 50 });
    expect(logs.read).toHaveBeenCalledTimes(1);
  });

  it("a lista do projeto também pede a leitura", async () => {
    await app.register(mailRoutes);
    await app.ready();
    await app.inject({ method: "GET", url: "/api/projects/p1/email/saidas", headers: auth });
    await vi.waitFor(() => expect(logs.read).toHaveBeenCalledTimes(1));
  });

  it("com o Stalwart fora do ar, 30 aberturas em seguida fazem uma só tentativa de leitura", async () => {
    logs.read.mockRejectedValue(new Error("docker fora do ar"));
    await app.register(mailRoutes);
    await app.ready();
    for (let i = 0; i < 30; i++) expect((await app.inject({ method: "GET", url: "/api/mail/envios/saidas", headers: auth })).statusCode).toBe(200);
    await vi.waitFor(() => expect(logs.read).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.read).toHaveBeenCalledTimes(1);
  });
});

describe("reconciliação do painel", () => {
  it("reaplica o resultado já guardado no histórico (envio antigo que ficou 'sem confirmação')", async () => {
    // histórico de entregas já gravado em disco, como se a coleta tivesse rodado antes
    const at = new Date().toISOString();
    const earlier = new MailEnviosService({
      dataDir: ctx.dir,
      serverCreated: async () => true,
      listQueue: async () => ({ items: [], total: 0 }),
      retry: async () => true,
      cancel: async () => true,
      senders: async () => [SENDER],
      projectNames: async () => new Map(),
      readLogs: async (_since, onLine) => onLine(deliveredLine(at, "200")),
    });
    await earlier.collect();
    await seed(stored("200", "unconfirmed", new Date(Date.now() - 3_600_000).toISOString()));

    let sends: MailSendLogService | null = null;
    vi.spyOn(MailSendLogService.prototype, "start").mockImplementation(function (this: MailSendLogService) {
      sends = this;
    });
    await app.register(mailRoutes);
    await app.ready();
    expect(sends).not.toBeNull();
    expect((await sends!.list({})).items[0]!.state).toBe("unconfirmed");
    await sends!.reconcile();
    expect((await sends!.list({})).items[0]!.state).toBe("delivered");
  });
});
