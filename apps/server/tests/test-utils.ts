/**
 * test-utils.ts — helper para montar uma app Fastify de teste com o plugin de
 * auth real (cookie + setupState + userStore + sessionStore em dir temporário).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import authPlugin from "../src/plugins/auth.js";
import { AuditService } from "../src/services/audit-service.js";
import { SessionStore } from "../src/services/session-store.js";
import { SetupStateStore } from "../src/services/setup-state.js";
import { UserStore } from "../src/services/user-store.js";

export interface AuthTestContext {
  app: FastifyInstance;
  dir: string;
  setupState: SetupStateStore;
  userStore: UserStore;
  sessionStore: SessionStore;
  auditService: AuditService;
}

export async function buildAuthTestApp(
  setupToken: string | null = "token-de-teste",
): Promise<AuthTestContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "paas-auth-test-"));
  const app = Fastify({ logger: false });
  const setupState = new SetupStateStore(dir);
  const userStore = new UserStore(dir);
  const sessionStore = new SessionStore(dir);
  await sessionStore.init();
  const auditService = new AuditService(dir);
  app.decorate("setupToken", setupToken);
  app.decorate("setupState", setupState);
  app.decorate("userStore", userStore);
  app.decorate("sessionStore", sessionStore);
  app.decorate("auditService", auditService);
  await app.register(authPlugin);
  return { app, dir, setupState, userStore, sessionStore, auditService };
}

export async function closeAuthTestApp(ctx: AuthTestContext): Promise<void> {
  await ctx.app.close();
  await rm(ctx.dir, { recursive: true, force: true });
}

/** Extrai o valor do cookie de sessão de uma resposta (para reuso nas próximas). */
export function sessionCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^paas_session=[^;]+/.exec(String(header ?? ""));
  if (!match) throw new Error(`set-cookie ausente/inesperado: ${String(header)}`);
  return match[0];
}
