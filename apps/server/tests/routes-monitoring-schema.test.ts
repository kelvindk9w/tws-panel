/**
 * Validação de schema das rotas de monitoramento (alertas, baseline, scan
 * recorrente e auditoria).
 *
 * Sem `schema` no Fastify a API aceita qualquer body/query/params. Estes
 * testes fixam o contrato: entrada malformada é recusada com 400 no formato
 * de erro do painel ({ error, message }) e o serviço correspondente nunca
 * chega a ser chamado.
 *
 * O MonitorService é mockado porque o plugin o instancia internamente
 * (`new MonitorService(app.config, alerts)`) e chama `start()` no registro —
 * mockar o módulo evita agendar um scan real de segurança no teste.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import monitoringRoutes from "../src/routes/monitoring.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const monitorMocks = vi.hoisted(() => ({
  setMailBlacklistHook: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getBaseline: vi.fn(),
  createBaseline: vi.fn(),
  runNow: vi.fn(),
  getState: vi.fn(),
  setIntervalMs: vi.fn(),
}));

vi.mock("../src/services/monitor-service.js", () => ({
  MonitorService: vi.fn().mockImplementation(() => monitorMocks),
}));

const ALERT = {
  id: "a1",
  severity: "warning" as const,
  source: "scan" as const,
  title: "Porta nova aberta",
  detail: "8081/tcp",
  status: "open" as const,
  createdAt: new Date().toISOString(),
  acknowledgedAt: null,
  resolvedAt: null,
};

const BASELINE = {
  id: "b1",
  createdAt: new Date().toISOString(),
  target: "container:paas-target",
  packages: [],
  ports: [],
  files: {},
};

const SCAN_RESULT = {
  id: "r1",
  ranAt: new Date().toISOString(),
  target: "container:paas-target",
  durationMs: 5,
  baselineId: "b1",
  baselineAt: BASELINE.createdAt,
  diff: null,
  alertsCreated: 0,
  note: null,
};

const STATE = {
  config: { intervalMs: 21_600_000 },
  schedulerRunning: true,
  lastRunAt: null,
  lastResult: null,
  baseline: null,
};

let ctx: AuthTestContext;
let app: FastifyInstance;
let listAlerts: ReturnType<typeof vi.fn>;
let setStatus: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  monitorMocks.start.mockResolvedValue(undefined);
  monitorMocks.getBaseline.mockResolvedValue(null);
  monitorMocks.createBaseline.mockResolvedValue(BASELINE);
  monitorMocks.runNow.mockResolvedValue(SCAN_RESULT);
  monitorMocks.getState.mockResolvedValue(STATE);
  monitorMocks.setIntervalMs.mockResolvedValue(undefined);

  listAlerts = vi.fn(async () => ({ alerts: [ALERT], total: 1, openCount: 1, page: 1, perPage: 50 }));
  setStatus = vi.fn(async () => ALERT);

  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { securityTarget: "container", securityTargetContainer: "paas-target-test" } as ServerConfig);
  app.decorate("alertsService", { list: listAlerts, setStatus } as never);
  await app.register(monitoringRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("GET /api/alerts — schema", () => {
  it("aceita sem query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(listAlerts).toHaveBeenCalledOnce();
  });

  it("aceita filtros válidos e paginação", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/alerts?status=open&severity=critical&source=scan&page=2&perPage=10",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(listAlerts).toHaveBeenCalledWith({ status: "open", severity: "critical", source: "scan", page: 2, perPage: 10 });
  });

  it("recusa status fora da lista", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts?status=archived", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it("recusa perPage não numérico", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts?perPage=todos", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it("recusa perPage com valor absurdamente alto (mais dígitos que o permitido)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts?perPage=1000000", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it("recusa querystring desconhecida", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts?foo=bar", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(listAlerts).not.toHaveBeenCalled();
  });
});

describe("POST /api/alerts/:id/ack e /resolve — schema", () => {
  it("aceita id válido em ack", async () => {
    const res = await app.inject({ method: "POST", url: "/api/alerts/a1/ack", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(setStatus).toHaveBeenCalledWith("a1", "acknowledged");
  });

  it("aceita id válido em resolve", async () => {
    const res = await app.inject({ method: "POST", url: "/api/alerts/a1/resolve", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(setStatus).toHaveBeenCalledWith("a1", "resolved");
  });

  it("recusa id maior que o limite em ack", async () => {
    const res = await app.inject({ method: "POST", url: `/api/alerts/${"a".repeat(65)}/ack`, headers: auth });
    expect(res.statusCode).toBe(400);
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("PUT /api/security/monitor/config — schema", () => {
  it("aceita intervalMs válido", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/monitor/config",
      headers: auth,
      payload: { intervalMs: 60_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(monitorMocks.setIntervalMs).toHaveBeenCalledWith(60_000);
  });

  it("recusa corpo sem intervalMs", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/security/monitor/config", headers: auth, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(monitorMocks.setIntervalMs).not.toHaveBeenCalled();
  });

  it("recusa intervalMs abaixo do mínimo (MONITOR_MIN_INTERVAL_MS)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/monitor/config",
      headers: auth,
      payload: { intervalMs: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect(monitorMocks.setIntervalMs).not.toHaveBeenCalled();
  });

  it("recusa intervalMs não inteiro", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/monitor/config",
      headers: auth,
      payload: { intervalMs: 60_000.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(monitorMocks.setIntervalMs).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/monitor/config",
      headers: auth,
      payload: { intervalMs: 60_000, force: true },
    });
    expect(res.statusCode).toBe(400);
    expect(monitorMocks.setIntervalMs).not.toHaveBeenCalled();
  });
});

describe("GET /api/audit — schema", () => {
  it("aceita sem query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("aceita page/perPage numéricos", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?page=2&perPage=25", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("recusa page não numérico", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?page=um", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa querystring desconhecida", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?foo=bar", headers: auth });
    expect(res.statusCode).toBe(400);
  });
});
