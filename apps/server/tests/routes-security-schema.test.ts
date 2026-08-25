/**
 * Validação de schema das rotas de segurança.
 *
 * Sem `schema` no Fastify a API aceita qualquer body/query/params e a
 * validação fica só a cargo do handler — inconsistente e fácil de esquecer
 * num endpoint novo. Estes testes fixam o contrato: entrada malformada é
 * recusada com 400 no formato de erro do painel ({ error, message }) e o
 * SecurityService nunca chega a ser chamado.
 *
 * O SecurityService é mockado porque o plugin o instancia internamente
 * (`new SecurityService(app.config, {...})`) em vez de recebê-lo injetado —
 * mockar o módulo evita depender de Docker/host bridge reais no teste.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import securityRoutes from "../src/routes/security.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  getJob: vi.fn(),
  confirmAccess: vi.fn(),
  manualCommands: vi.fn(),
  history: vi.fn(),
  // restoreJobsFromDisk() é chamado uma vez no registro da rota (restaura
  // jobs persistidos de uma execução anterior do painel — ver security-service.ts).
  restoreJobsFromDisk: vi.fn(),
}));

vi.mock("../src/services/security-service.js", () => ({
  SecurityService: vi.fn().mockImplementation(() => mocks),
}));

const REPORT = {
  id: "s1",
  scannedAt: new Date().toISOString(),
  durationMs: 10,
  target: "container",
  hardeningIndex: 50,
  hardeningIndexSource: "internal",
  lynisAvailable: false,
  checks: [],
  summary: { total: 0, pass: 0, fail: 0, unknown: 0, critical: 0, warning: 0 },
  profile: "container",
  skippedChecks: [],
  profileNote: null,
};

const JOB = {
  id: "job1",
  phase: "00",
  phaseKey: "update",
  title: "Atualizações do sistema",
  dryRun: true,
  status: "queued",
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
  steps: [],
  log: "",
  rollbackScheduled: false,
  rollbackDeadline: null,
  error: null,
};

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.scan.mockResolvedValue({ report: REPORT, cached: true, refreshing: false });
  mocks.plan.mockResolvedValue({ id: "p1", createdAt: new Date().toISOString(), basedOnScanId: "s1", hardeningIndex: 50, actions: [] });
  mocks.apply.mockResolvedValue(JOB);
  mocks.getJob.mockReturnValue(JOB);
  mocks.confirmAccess.mockResolvedValue(JOB);
  mocks.manualCommands.mockResolvedValue({
    phase: "00",
    phaseKey: "update",
    title: "Atualizações do sistema",
    script: "00-update.sh",
    commands: [],
    scriptContent: "",
    notes: [],
  });
  mocks.history.mockResolvedValue({ entries: [], firstIndex: null, latestIndex: null, applied: null });

  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { securityTarget: "container" } as ServerConfig);
  await app.register(securityRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("GET /api/security/scan — schema", () => {
  it("aceita sem query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/scan", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mocks.scan).toHaveBeenCalledWith(false);
  });

  it("aceita fresh=1", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/scan?fresh=1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mocks.scan).toHaveBeenCalledWith(true);
  });

  it("recusa valor de fresh fora do conjunto aceito", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/scan?fresh=yes", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});

describe("POST /api/security/apply — schema", () => {
  it("aceita corpo válido (dry run)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "00", dryRun: true },
    });
    expect(res.statusCode).toBe(202);
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it("recusa corpo sem os campos obrigatórios", async () => {
    const res = await app.inject({ method: "POST", url: "/api/security/apply", headers: auth, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("recusa fase fora da lista de fases de hardening", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "99", dryRun: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("recusa dryRun não booleano", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "00", dryRun: "sim" },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "00", dryRun: true, isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("ainda recusa sshUser/sshPublicKey fora da fase 01 (regra de negócio do handler)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "00", dryRun: true, sshUser: "deploy" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_params");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

describe("GET /api/security/jobs/:id — schema", () => {
  it("aceita id válido", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/jobs/job1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mocks.getJob).toHaveBeenCalledWith("job1");
  });

  it("recusa id maior que o limite", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/security/jobs/${"a".repeat(65)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.getJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/security/confirm-access — schema", () => {
  it("aceita corpo válido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/confirm-access",
      headers: auth,
      payload: { jobId: "job1" },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.confirmAccess).toHaveBeenCalledWith("job1");
  });

  it("recusa corpo sem jobId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/confirm-access",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(mocks.confirmAccess).not.toHaveBeenCalled();
  });

  it("recusa jobId vazio", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/confirm-access",
      headers: auth,
      payload: { jobId: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.confirmAccess).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/confirm-access",
      headers: auth,
      payload: { jobId: "job1", force: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.confirmAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/security/phases/:phase/manual — schema", () => {
  it("aceita fase válida", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/phases/00/manual", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mocks.manualCommands).toHaveBeenCalledWith("00");
  });

  it("recusa fase fora da lista", async () => {
    const res = await app.inject({ method: "GET", url: "/api/security/phases/99/manual", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(mocks.manualCommands).not.toHaveBeenCalled();
  });
});
