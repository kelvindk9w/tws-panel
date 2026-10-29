/**
 * test-utils.ts — helper para montar uma app Fastify de teste com o plugin de
 * auth real (cookie + setupState + userStore + sessionStore em dir temporário).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { AJV_OPTIONS } from "../src/ajv-options.js";
import authPlugin from "../src/plugins/auth.js";
import { AlertsService } from "../src/services/alerts-service.js";
import { AuditService } from "../src/services/audit-service.js";
import { LoginLimiter } from "../src/services/login-limiter.js";
import { LoginWatch } from "../src/services/login-watch.js";
import { ApiTokenStore } from "../src/services/api-token-store.js";
import { SessionStore } from "../src/services/session-store.js";
import { SetupStateStore } from "../src/services/setup-state.js";
import { TwoFactorService } from "../src/services/two-factor.js";
import { UserStore } from "../src/services/user-store.js";

export interface AuthTestContext {
  app: FastifyInstance;
  dir: string;
  setupState: SetupStateStore;
  userStore: UserStore;
  sessionStore: SessionStore;
  auditService: AuditService;
  twoFactor: TwoFactorService;
  alertsService: AlertsService;
  loginWatch: LoginWatch;
  actionLimiter: LoginLimiter;
  apiTokens: ApiTokenStore;
  tokenLimiter: LoginLimiter;
}

export async function buildAuthTestApp(
  setupToken: string | null = "token-de-teste",
  opts: { now?: () => number; watchNow?: () => number; trustProxy?: boolean | ((address: string, hop: number) => boolean); logger?: object } = {},
): Promise<AuthTestContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "paas-auth-test-"));
  // Mesmas opções de validação da produção (app.ts), para que os testes de
  // rota exerçam o comportamento real do Ajv.
  const app = Fastify({ logger: opts.logger ?? false, ajv: AJV_OPTIONS, trustProxy: opts.trustProxy ?? false });
  const setupState = new SetupStateStore(dir);
  const userStore = new UserStore(dir);
  const sessionStore = new SessionStore(dir);
  await sessionStore.init();
  const auditService = new AuditService(dir);
  app.decorate("setupToken", setupToken);
  app.decorate("setupState", setupState);
  app.decorate("userStore", userStore);
  const twoFactor = new TwoFactorService(dir, userStore, opts.now ? { now: opts.now } : {});
  app.decorate("twoFactor", twoFactor);
  app.decorate("sessionStore", sessionStore);
  app.decorate("auditService", auditService);
  const alertsService = new AlertsService(dir, { log: () => undefined });
  const loginWatch = new LoginWatch({
    alerts: alertsService,
    audit: auditService,
    log: () => undefined,
    ...(opts.watchNow ? { now: opts.watchNow } : {}),
  });
  app.decorate("loginWatch", loginWatch);
  const actionLimiter = new LoginLimiter();
  app.decorate("actionLimiter", actionLimiter);
  const apiTokens = new ApiTokenStore(dir);
  app.decorate("apiTokens", apiTokens);
  const tokenLimiter = new LoginLimiter();
  app.decorate("tokenLimiter", tokenLimiter);
  await app.register(authPlugin);
  return { app, dir, setupState, userStore, sessionStore, auditService, twoFactor, alertsService, loginWatch, actionLimiter, apiTokens, tokenLimiter };
}

export async function closeAuthTestApp(ctx: AuthTestContext): Promise<void> {
  await ctx.app.close();
  // A app de teste registra só o plugin de auth, sem o hook onClose do app.ts:
  // o dreno precisa ser explícito aqui. Sem ele, uma auditoria disparada com
  // `void record(...)` recria o diretório no meio do rm e o apagamento falha
  // com ENOTEMPTY — de forma intermitente, dependendo do timing da máquina.
  await ctx.auditService.flush();
  await ctx.apiTokens.flush();
  await rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Extrai o valor do cookie de sessão de uma resposta (para reuso nas próximas). */
export function sessionCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^(?:__Host-)?paas_session=[^;]+/.exec(String(header ?? ""));
  if (!match) throw new Error(`set-cookie ausente/inesperado: ${String(header)}`);
  return match[0];
}
