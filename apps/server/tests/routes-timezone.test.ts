/**
 * routes-timezone.test.ts — rotas do fuso horário: Configurações → Fuso
 * horário (também no assistente de instalação, com o setup token) e o campo
 * "Fuso horário" do projeto, com o reinício que faz o TZ entrar.
 * Os serviços são dublês (a regra está em timezone-service.test.ts e
 * deploy-timezone.test.ts).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import timezoneRoutes from "../src/routes/timezone.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import type { TimezoneService } from "../src/services/timezone-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;
let tz: Record<string, ReturnType<typeof vi.fn>>;
let deploy: Record<string, ReturnType<typeof vi.fn>>;

async function build(over: { tz?: Record<string, ReturnType<typeof vi.fn>>; deploy?: Record<string, ReturnType<typeof vi.fn>> } = {}) {
  tz = {
    status: vi.fn(async () => ({ zone: "America/Sao_Paulo" })),
    apply: vi.fn(async () => ({ status: { zone: "America/Manaus" }, projects: [] })),
    ...over.tz,
  };
  deploy = {
    timezoneView: vi.fn(async () => ({ setting: { mode: "host" } })),
    setProjectTimezone: vi.fn(async () => ({})),
    setAppTimezoneVariable: vi.fn(async () => ({ framework: "laravel" })),
    startRecreate: vi.fn(async () => ({ id: "job1", kind: "recreate" })),
    ...over.deploy,
  };
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("timezoneService", tz as unknown as TimezoneService);
  app.decorate("deployService", deploy as unknown as DeployService);
  await app.register(timezoneRoutes);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("Configurações → Fuso horário", () => {
  it("sem setup token nem sessão: 401", async () => {
    await build();
    expect((await app.inject({ method: "GET", url: "/api/timezone" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/timezone", payload: { zone: "UTC" } })).statusCode).toBe(401);
  });

  it("o assistente de instalação lê e aplica com o setup token", async () => {
    await build();
    const get = await app.inject({ method: "GET", url: "/api/timezone", headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ zone: "America/Sao_Paulo" });
    const put = await app.inject({ method: "PUT", url: "/api/timezone", headers: auth, payload: { zone: "America/Manaus", projects: ["p1"] } });
    expect(put.statusCode).toBe(200);
    expect(tz.apply).toHaveBeenCalledWith("America/Manaus", ["p1"], "assistente de instalação");
    await app.inject({ method: "PUT", url: "/api/timezone", headers: auth, payload: { zone: "UTC" } });
    expect(tz.apply).toHaveBeenLastCalledWith("UTC", [], "assistente de instalação");
  });

  it("corpo validado: campo desconhecido ou sem zona é 400", async () => {
    await build();
    for (const payload of [{}, { zone: "UTC", cmd: "reboot" }, { zone: "" }, { zone: "UTC", projects: "p1" }]) {
      const res = await app.inject({ method: "PUT", url: "/api/timezone", headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(tz.apply).not.toHaveBeenCalled();
  });

  it("erros do serviço chegam com o código; inesperado vira 500 sem detalhe", async () => {
    await build({
      tz: {
        apply: vi.fn(async () => Promise.reject(httpError(409, "host_bridge_unavailable", "O painel não está ligado à VPS."))),
        status: vi.fn(async () => Promise.reject(new Error("ENOENT /data"))),
      },
    });
    const put = await app.inject({ method: "PUT", url: "/api/timezone", headers: auth, payload: { zone: "UTC" } });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toEqual({ error: "host_bridge_unavailable", message: "O painel não está ligado à VPS." });
    const get = await app.inject({ method: "GET", url: "/api/timezone", headers: auth });
    expect(get.statusCode).toBe(500);
    expect(get.json().message).not.toContain("ENOENT");
  });
});

describe("fuso do projeto", () => {
  it("lê, salva (devolve a visão nova) e reinicia", async () => {
    await build();
    const get = await app.inject({ method: "GET", url: "/api/projects/p1/timezone", headers: auth });
    expect(get.json()).toEqual({ setting: { mode: "host" } });
    const put = await app.inject({ method: "PUT", url: "/api/projects/p1/timezone", headers: auth, payload: { mode: "zone", zone: "Europe/Lisbon" } });
    expect(put.statusCode).toBe(200);
    expect(deploy.setProjectTimezone).toHaveBeenCalledWith("p1", { mode: "zone", zone: "Europe/Lisbon" }, undefined);
    const app2 = await app.inject({ method: "POST", url: "/api/projects/p1/timezone/app-timezone", headers: auth });
    expect(app2.statusCode).toBe(200);
    expect(deploy.setAppTimezoneVariable).toHaveBeenCalledWith("p1", undefined);
    const post = await app.inject({ method: "POST", url: "/api/projects/p1/recreate", headers: auth });
    expect(post.statusCode).toBe(202);
    expect(post.json()).toEqual({ job: { id: "job1", kind: "recreate" } });
  });

  it("modo fora da lista é 400; erros do serviço chegam com o código", async () => {
    await build({
      deploy: {
        timezoneView: vi.fn(async () => Promise.reject(httpError(404, "project_not_found", "Projeto não encontrado."))),
        setProjectTimezone: vi.fn(async () => Promise.reject(httpError(400, "invalid_timezone", "Escolha um fuso da lista."))),
        setAppTimezoneVariable: vi.fn(async () => Promise.reject(httpError(409, "app_timezone_exists", "O projeto já tem a variável APP_TIMEZONE."))),
        startRecreate: vi.fn(async () => Promise.reject(httpError(409, "not_deployed", "Faça o primeiro deploy do projeto: o fuso entra junto."))),
      },
    });
    expect((await app.inject({ method: "PUT", url: "/api/projects/p1/timezone", headers: auth, payload: { mode: "outro" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/x/timezone", headers: auth })).statusCode).toBe(404);
    const bad = await app.inject({ method: "PUT", url: "/api/projects/p1/timezone", headers: auth, payload: { mode: "zone", zone: "X/Y" } });
    expect(bad.json().error).toBe("invalid_timezone");
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/timezone/app-timezone", headers: auth })).json().error).toBe("app_timezone_exists");
    const post = await app.inject({ method: "POST", url: "/api/projects/p1/recreate", headers: auth });
    expect(post.statusCode).toBe(409);
    expect(post.json().error).toBe("not_deployed");
  });
});
