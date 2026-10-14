import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { loadConfig, resolveTerminalAccess, type ServerConfig } from "./config.js";
import { AJV_OPTIONS } from "./ajv-options.js";
import { loadSetupToken } from "./services/setup-token.js";
import { SetupStateStore } from "./services/setup-state.js";
import { TwoFactorService } from "./services/two-factor.js";
import { UserStore } from "./services/user-store.js";
import { SessionStore } from "./services/session-store.js";
import { DeployService } from "./services/deploy-service.js";
import { AuditService } from "./services/audit-service.js";
import { AlertsService } from "./services/alerts-service.js";
import { TerminalService } from "./services/terminal-service.js";
import {
  createDockerPtyFactory,
  createHostDockerAccessProbe,
  removeOrphanTerminalHelpers,
  type PtyFactory,
} from "./services/docker-socket.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import setupRoutes from "./routes/setup.js";
import healthRoutes from "./routes/health.js";
import settingsRoutes from "./routes/settings.js";
import onboardingRoutes from "./routes/onboarding.js";
import { createOnboardingChecks } from "./services/onboarding.js";
import { mailFactsSource } from "./services/onboarding-sources.js";
import serverFolderRoutes from "./routes/server-folders.js";
import integrationRoutes from "./routes/integrations.js";
import setupRestartRoutes from "./routes/setup-restart.js";
import securityRoutes from "./routes/security.js";
import projectsRoutes from "./routes/projects.js";
import dockerRoutes from "./routes/docker.js";
import domainsRoutes from "./routes/domains.js";
import mailRoutes from "./routes/mail.js";
import certificatesRoutes, { buildCertificateService } from "./routes/certificates.js";
import { ManualCertificateStore } from "./services/certificate-store.js";
import monitoringRoutes from "./routes/monitoring.js";
import terminalRoutes from "./routes/terminal.js";
import panelDomainRoutes, { buildPanelDomainService } from "./routes/panel-domain.js";
import notificationsRoutes from "./routes/notifications.js";
import { NotificationService, type NotificationEvent } from "./services/notification-service.js";
import {
  CertificateWatcher,
  DiskWatcher,
  alertNotification,
  deployNotification,
  panelStartedNotification,
} from "./services/notification-sources.js";
import { createTelegramClient } from "./services/telegram-client.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    deployService: DeployService;
    auditService: AuditService;
    alertsService: AlertsService;
  }
}

export interface BuildAppOptions {
  /** Fábrica de PTY do terminal web (testes injetam um fake sem Docker). */
  terminalPtyFactory?: PtyFactory;
}

export async function buildApp(options?: BuildAppOptions): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    ajv: AJV_OPTIONS,
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
  const userStore = new UserStore(config.dataDir);
  app.decorate("userStore", userStore);
  app.decorate(
    "twoFactor",
    new TwoFactorService(config.dataDir, userStore, { accountSuffix: config.panelDomain }),
  );
  const sessionStore = new SessionStore(config.dataDir);
  await sessionStore.init();
  app.decorate("sessionStore", sessionStore);
  // Fase 4: auditoria + alertas no escopo raiz — consumidos por todas as rotas.
  app.decorate("auditService", new AuditService(config.dataDir));
  app.decorate("alertsService", new AlertsService(config.dataDir));
  // Notificações (Telegram/e-mail) no escopo RAIZ: alertas, deploy, vigias e
  // o plugin de e-mail (que registra o envio por e-mail) precisam do MESMO
  // objeto — decorado dentro de um plugin, os outros não o enxergariam (foi
  // assim que a checagem de blacklist ficou sem rodar). Quem avisa não
  // conhece o serviço: o AlertsService e o DeployService só chamam ganchos.
  const notificationService = new NotificationService({
    dataDir: config.dataDir,
    telegram: createTelegramClient(),
    audit: app.auditService,
    log: (m) => app.log.warn(m),
    // Link nas mensagens só com endereço próprio (o …sslip.io tem o IP no nome).
    panelUrl: async () => {
      const facts = await app.panelDomainService.facts("");
      if (facts.domain && facts.active && facts.certificateValid) return `https://${facts.domain}`;
      const own = facts.ipAddress;
      return own && !own.endsWith(".sslip.io") && !/^[\d.:]+$/.test(own) ? `https://${own}` : null;
    },
  });
  app.decorate("notificationService", notificationService);
  const notify = (event: NotificationEvent | null): void => {
    if (!event) return;
    notificationService.notify(event).catch((err: unknown) => {
      app.log.warn("notificações: aviso não enviado (%s)", err instanceof Error ? err.message : String(err));
    });
  };
  app.alertsService.onCreated((alert) => notify(alertNotification(alert)));
  // DeployService no escopo raiz: compartilhado entre as rotas de projetos e
  // de e-mail (Fase 3 registra o provedor de env vars SMTP nele).
  app.decorate(
    "deployService",
    new DeployService(config, {
      audit: app.auditService,
      alerts: app.alertsService,
      onDeployFinished: (e) => notify(deployNotification(e)),
    }),
  );
  // Certificados manuais (página Certificados): no escopo raiz porque o
  // proxy (Caddyfile com `tls`) e o e-mail (Stalwart) usam o mesmo par.
  const certificateStore = new ManualCertificateStore(config.dataDir);
  app.decorate("certificateStore", certificateStore);
  app.deployService.setManualCertificatesProvider(() => certificateStore.pairs());
  // Serviço da página Certificados também no escopo raiz: a verificação de
  // DNS do e-mail pede a emissão de mail.<domínio> por ele (mesmo limite de
  // 1 pedido por minuto que o botão "Tentar emitir agora").
  app.decorate("certificateService", buildCertificateService(app));
  // Domínio do painel (Configurações → Domínio do painel): lê a escolha
  // gravada em data/panel-domain.json ANTES de o proxy subir — um reinício do
  // painel mantém o domínio próprio e o acesso pelo IP como estavam.
  const panelDomainService = buildPanelDomainService(app);
  await panelDomainService.init();
  app.decorate("panelDomainService", panelDomainService);
  // Acesso por HTTPS (PAAS_PANEL_DOMAIN): o Caddy central sobe JUNTO com o
  // painel, já com o site dele — senão só subiria no primeiro deploy.
  app.deployService.startPanelRoute({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });
  // Terminal web embutido: uma sessão de PTY no alvo (host via host bridge ou
  // container de dev), compartilhada entre o WS do painel e o executor de
  // hardening. Relay puro — input do usuário nunca é logado/auditado.
  const terminalAccess = resolveTerminalAccess(config);
  // Testes que injetam um PTY falso não falam com Docker nenhum.
  const hostDockerAccessProbe = options?.terminalPtyFactory ? null : createHostDockerAccessProbe(config);
  const terminalService = new TerminalService({
    openPty: options?.terminalPtyFactory ?? createDockerPtyFactory(config),
    idleTimeoutMs: config.terminalIdleTimeoutMs,
    // Modo senha: observa a SAÍDA atrás do prompt do sudo (nunca o input).
    watchSudoPrompt: terminalAccess.elevation === "senha",
    // Espera pela senha com o prompt aberto (PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS):
    // 0 = sem prazo (padrão); positivo = o prazo da contagem regressiva do alerta.
    sudoPasswordTimeoutMs: config.terminalSudoPasswordTimeoutMs,
    // Modos de usuário comum: confere no host se o usuário tem acesso ao
    // Docker (= root sem senha) e expõe em /api/terminal/info. Não bloqueia.
    ...(hostDockerAccessProbe ? { probeHostDockerAccess: hostDockerAccessProbe } : {}),
    audit: (action, detail) => {
      void app.auditService.record({ action, detail });
    },
  });
  app.decorate("terminalService", terminalService);
  // Transparência: quem é o terminal e como o root acontece, no log de boot.
  app.log.info(
    "Terminal web: usuário=%s, modo=%s (monitoramento agendado roda como root pelo host bridge em qualquer modo)",
    terminalAccess.user,
    terminalAccess.elevation,
  );

  // Reaper de boot (uma vez, não fatal): remove containers paas-terminal-*
  // órfãos de um processo anterior do painel — a sessão morre com o processo
  // e o helper (AutoRemove só dispara na saída do bash) ficaria para trás.
  void removeOrphanTerminalHelpers(config.dockerSocketPath)
    .then((removed) => {
      for (const name of removed) {
        app.log.info("helper de terminal órfão removido no boot: %s", name);
      }
    })
    .catch((err: unknown) => {
      app.log.warn(
        "reaper de helpers de terminal falhou (não fatal): %s",
        err instanceof Error ? err.message : String(err),
      );
    });

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
  await app.register(settingsRoutes);
  // Roteiro "Deixe o painel pronto" (Dashboard): status de cada passo lido do
  // estado real (segurança em data/, 2FA da conta, domínio do painel, e-mail).
  await app.register(onboardingRoutes, {
    checks: createOnboardingChecks({
      config,
      userStore,
      emailFacts: mailFactsSource(config),
      panelDomainFacts: (host) => panelDomainService.facts(host),
      notificationFacts: () => notificationService.facts(),
    }),
  });
  await app.register(panelDomainRoutes);
  await app.register(notificationsRoutes);
  await app.register(serverFolderRoutes);
  await app.register(integrationRoutes);
  await app.register(setupRestartRoutes);
  await app.register(securityRoutes);
  await app.register(projectsRoutes);
  await app.register(dockerRoutes);
  await app.register(domainsRoutes);
  await app.register(mailRoutes);
  // Página Certificados: depois do e-mail (que registra no deployService os
  // hosts mail.<domínio> e a instalação do certificado no Stalwart).
  await app.register(certificatesRoutes);
  // Fase 4 — por último. A checagem de blacklist do e-mail não passa mais por
  // aqui: é agendada dentro do plugin de e-mail (mail-reputation-service.ts).
  await app.register(monitoringRoutes);
  await app.register(terminalRoutes);

  // Notificações: novas tentativas e resumos a cada 30 s; disco a cada 15 min
  // e certificados a cada 6 h (só leitura). O primeiro giro dos vigias espera
  // o painel assentar (o proxy e o e-mail sobem em segundo plano).
  notificationService.start();
  const disk = new DiskWatcher({ path: config.dataDir, statfs, notify: async (e) => notify(e) });
  const certificates = new CertificateWatcher({
    list: async () => (await app.certificateService.list()).items,
    notify: async (e) => notify(e),
  });
  const watcherTimers = [
    setTimeout(() => void disk.check(), 2 * 60_000),
    setInterval(() => void disk.check(), 15 * 60_000),
    setTimeout(() => void certificates.check(), 10 * 60_000),
    setInterval(() => void certificates.check(), 6 * 60 * 60_000),
  ];
  for (const t of watcherTimers) t.unref();
  // "Painel iniciado" (desligado por padrão): quando o servidor fica pronto.
  app.addHook("onReady", async () => notify(panelStartedNotification(new Date())));

  app.addHook("onClose", async () => {
    notificationService.stop();
    for (const t of watcherTimers) clearTimeout(t);
    await notificationService.flush();
    await terminalService.dispose();
    // Depois do dispose: encerrar terminais dispara auditoria sem await, e
    // essas gravações precisam terminar antes de o processo sair.
    await app.auditService.flush();
  });

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
