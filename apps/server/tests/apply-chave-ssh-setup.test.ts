/**
 * Primeira instalação: o assistente chama POST /api/security/apply (fase 01, com chave SSH) só com o
 * setup token, ainda sem conta nem sessão. O token é a prova de quem está instalando; nunca pode virar 500.
 * Sem sessão, a confirmação de identidade responde 401 (e não quebra lendo a sessão nula).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import securityRoutes from "../src/routes/security.js";
import { confirmIdentity } from "../src/services/confirm-identity.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT dono";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  restoreJobsFromDisk: vi.fn(),
}));

vi.mock("../src/services/security-service.js", () => ({
  SecurityService: vi.fn().mockImplementation(function () {
    return mocks;
  }),
}));

const JOB = {
  id: "job1",
  phase: "01",
  phaseKey: "ssh",
  title: "Acesso SSH",
  dryRun: false,
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
  mocks.apply.mockResolvedValue(JOB);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { securityTarget: "container" } as ServerConfig);
  await app.register(securityRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("assistente de instalação (setup token, sem sessão)", () => {
  it("fase 01 de verdade com chave SSH: o setup token basta, sem senha", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "01", dryRun: false, sshUser: "deploy", sshPublicKey: KEY },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply.mock.calls[0]![2]).toMatchObject({ sshUser: "deploy", sshPublicKey: KEY });
  });

  it("mandar senha junto também não quebra (é ignorada sem sessão)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      headers: auth,
      payload: { phase: "01", dryRun: false, sshUser: "deploy", sshPublicKey: KEY, currentPassword: "Qualquer-Senha-123" },
    });
    expect(res.statusCode, res.body).toBe(202);
  });

  it("sem o setup token continua barrado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/security/apply",
      payload: { phase: "01", dryRun: false, sshUser: "deploy", sshPublicKey: KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

describe("confirmIdentity sem sessão", () => {
  function fakeReply() {
    const out: { status?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        out.status = status;
        return reply;
      },
      send(body: unknown) {
        out.body = body;
        return reply;
      },
    };
    return { reply: reply as unknown as FastifyReply, out };
  }

  it("responde 401 e devolve null, nunca lança", async () => {
    const { reply, out } = fakeReply();
    const request = { session: null, ip: "203.0.113.5" } as unknown as FastifyRequest;
    const result = await confirmIdentity(app, request, reply, { currentPassword: "x" }, { emailCode: "if-enabled", action: "access.keys" });
    expect(result).toBeNull();
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ error: "unauthorized" });
  });

  it("usar o código por e-mail sem informar a ação é erro de programação", async () => {
    const { reply } = fakeReply();
    const request = { session: { id: "s", userId: "u" }, ip: "203.0.113.5" } as unknown as FastifyRequest;
    await expect(confirmIdentity(app, request, reply, { currentPassword: "x" }, { emailCode: "if-enabled" })).rejects.toThrow(/ação é obrigatória/);
  });
});
