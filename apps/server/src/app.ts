import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { loadConfig, type ServerConfig } from "./config.js";
import { loadSetupToken } from "./services/setup-token.js";
import { SetupStateStore } from "./services/setup-state.js";
import { UserStore } from "./services/user-store.js";
import { SessionStore } from "./services/session-store.js";
import { DeployService } from "./services/deploy-service.js";
import { AuditService } from "./services/audit-service.js";
import { AlertsService } from "./services/alerts-service.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import setupRoutes from "./routes/setup.js";
import healthRoutes from "./routes/health.js";
import securityRoutes from "./routes/security.js";
import projectsRoutes from "./routes/projects.js";
import dockerRoutes from "./routes/docker.js";
import domainsRoutes from "./routes/domains.js";
import mailRoutes from "./routes/mail.js";
import monitoringRoutes from "./routes/monitoring.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    deployService: DeployService;
    auditService: AuditService;
    alertsService: AlertsService;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // logs estruturados (pino) — nunca logar tokens
      redact: {
        paths: [
          "req.headers.authorization",
          `req.headers["x-setup-token"]`,
          "req.headers.cookie",
          "req.query.token",
        ],
        censor: "[redacted]",
      },
    },
    trustProxy: true,
  });

  app.decorate("config", config);
  app.decorate("setupState", new SetupStateStore(config.dataDir));
  app.decorate("userStore", new UserStore(config.dataDir));
  const sessionStore = new SessionStore(config.dataDir);
  await sessionStore.init();
  app.decorate("sessionStore", sessionStore);
  // Fase 4: auditoria + alertas no escopo raiz — consumidos por todas as rotas.
  app.decorate("auditService", new AuditService(config.dataDir));
  app.decorate("alertsService", new AlertsService(config.dataDir));
  // DeployService no escopo raiz: compartilhado entre as rotas de projetos e
  // de e-mail (Fase 3 registra o provedor de env vars SMTP nele).
  app.decorate(
    "deployService",
    new DeployService(config, { audit: app.auditService, alerts: app.alertsService }),
  );

  const token = await loadSetupToken(config.setupTokenFile);
  app.decorate("setupToken", token);
  if (!token) {
    app.log.warn(
      "SETUP_TOKEN não encontrado (nem em variável de ambiente, nem em %s). A API responderá 503 até ser configurado.",
      config.setupTokenFile,
    );
  }

  // Segurança HTTP
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind injeta estilos inline
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        // o wizard roda em http://IP:9000 antes do SSL (Fase 2); sem isso o
        // navegador tentaria promover os assets para https e quebraria a página
        upgradeInsecureRequests: null,
      },
    },
  });

  // CORS restrito: por padrão apenas same-origin; origens extras via ALLOWED_ORIGINS
  await app.register(cors, {
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    credentials: true,
  });

  // Rate limit básico
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 200),
    timeWindow: "1 minute",
  });

  // Auth (setup token enquanto setup pendente; sessão depois) + rotas da API
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(healthRoutes);
  await app.register(securityRoutes);
  await app.register(projectsRoutes);
  await app.register(dockerRoutes);
  await app.register(domainsRoutes);
  await app.register(mailRoutes);
  // Fase 4 — por último: consome mailService (hook de blacklist no scan).
  await app.register(monitoringRoutes);

  // Frontend estático (build do Vite) com fallback SPA
  if (existsSync(path.join(config.webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found", message: "Rota não encontrada." });
    });
  } else {
    app.log.warn("Build do frontend não encontrado em %s — servindo apenas a API.", config.webDist);
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: "not_found", message: "Rota não encontrada." }),
    );
  }

  return app;
}
