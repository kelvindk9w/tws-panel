/**
 * real-panel.ts — painel REAL (buildApp) numa pasta temporária, sem Docker real
 * (socket inexistente), com a conta admin criada, para os testes de alcance dos
 * tokens (Fase 0b). Nada aqui fala com a rede nem com o Docker: o proxy já é
 * trocado por mock em tests/setup-no-docker.ts.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { buildApp } from "../../src/app.js";
import { sessionCookieOf } from "../test-utils.js";
import { removeDir } from "./tmp.js";

export const SETUP = "token-de-teste";
export const PASSWORD = "MinhaSenha123";

export interface RealPanel {
  app: FastifyInstance;
  dir: string;
  cookie: string;
  close(): Promise<void>;
  /** Cria projeto (repositório remoto de mentira) como humano. Devolve o id. */
  createProject(name: string, domain: string): Promise<string>;
  /** Cria token como humano; devolve o valor, o id e o corpo. */
  createToken(body: Record<string, unknown>): Promise<{ status: number; token: string; id: string; json: Record<string, any> }>;
}

const ENV_KEYS = ["RATE_LIMIT_MAX", "PAAS_DATA_DIR", "SETUP_TOKEN_FILE", "PAAS_PUBLIC_IP", "LOG_LEVEL", "DOCKER_HOST", "DOCKER_SOCKET_PATH", "PAAS_PROJECTS_DIR"] as const;

/** `beforeReady`: último momento para pendurar hooks no app (depois do ready o Fastify não deixa). */
export async function startRealPanel(opts: { beforeReady?: (app: FastifyInstance) => void } = {}): Promise<RealPanel> {
  const dir = await mkdtemp(path.join(tmpdir(), "paas-alcance-"));
  await writeFile(path.join(dir, "setup-token"), SETUP);
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    RATE_LIMIT_MAX: "1000000",
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
    // nenhum teste fala com o Docker real
    DOCKER_HOST: "unix:///nonexistent/docker.sock",
    DOCKER_SOCKET_PATH: "/nonexistent/docker.sock",
    PAAS_PROJECTS_DIR: path.join(dir, "projects"),
  };
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, env);

  const app = await buildApp();
  opts.beforeReady?.(app);
  await app.ready();
  app.terminalService.setEnsureTarget(undefined);
  const created = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: SETUP },
    payload: { username: "admin", password: PASSWORD },
  });
  if (created.statusCode !== 201) throw new Error(`setup falhou: ${created.statusCode} ${created.body}`);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  const cookie = sessionCookieOf(login);

  return {
    app,
    dir,
    cookie,
    async close() {
      await app.close();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await removeDir(dir);
    },
    async createProject(name, domain) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie },
        payload: { name, ingestMode: "git", source: `https://example.com/${name.toLowerCase().replace(/\W+/g, "-")}.git`, domain, backup: false },
      });
      if (res.statusCode !== 201) throw new Error(`criar projeto falhou: ${res.statusCode} ${res.body}`);
      return res.json().project.id as string;
    },
    async createToken(body) {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/api-tokens",
        headers: { cookie },
        payload: { name: "t", scope: "admin", currentPassword: PASSWORD, ...body },
      });
      const json = res.json() as Record<string, any>;
      return { status: res.statusCode, token: json.token, id: json.info?.id, json };
    },
  };
}
