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
import { ApiTokenStore } from "./services/api-token-store.js";
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
import apiTokenRoutes from "./routes/api-tokens.js";
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
import projectLogsRoutes from "./routes/project-logs.js";
import { ProjectLogsService } from "./services/project-logs.js";
import { dockerInspect, dockerLogs } from "./services/docker-logs.js";
import { listContainers } from "./services/docker-service.js";
import dockerRoutes from "./routes/docker.js";
import domainsRoutes, { makeHostState, publicIpFromConfig } from "./routes/domains.js";
import mailRoutes from "./routes/mail.js";
import certificatesRoutes, { buildCertificateService } from "./routes/certificates.js";
import { ManualCertificateStore } from "./services/certificate-store.js";
import monitoringRoutes from "./routes/monitoring.js";
import terminalRoutes from "./routes/terminal.js";
import panelDomainRoutes, { buildPanelDomainService } from "./routes/panel-domain.js";
import appsDomainRoutes, { buildAppsDomainService } from "./routes/apps-domain.js";
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
import backupsRoutes from "./routes/backups.js";
import restoreReconciliationRoutes from "./routes/restore-reconciliation.js";
import { MailService } from "./services/mail-service.js";
import { RestoreReconciliation } from "./services/restore-reconciliation.js";
import { BackupService } from "./services/backup-service.js";
import { DockerCli } from "./services/backup-docker.js";
import { SevenZip } from "./services/backup-archive.js";
import { S3Storage } from "./services/backup-s3.js";
import { verifyPasswordTimingSafe, warmUpDummyHash } from "./services/password.js";
import timezoneRoutes from "./routes/timezone.js";
import { TimezoneService, createHostTimezoneBridge } from "./services/timezone-service.js";
import { startupTimezone } from "./services/host-timezone.js";
import { loggerOptions } from "./log-config.js";
import { TrustedProxies } from "./services/trusted-proxies.js";
import { LoginLimiter } from "./services/login-limiter.js";
import { LoginWatch } from "./services/login-watch.js";
import { EdgeWatch } from "./services/edge-watch.js";
import { HOST_TIMEZONE_READ_CMD, NsenterHostRunner, buildSetTimezoneCommand, parseHostTimezoneOutput } from "@paas/security";
import { PAAS_STALWART_CONTAINER, PAAS_STALWART_VOLUME, PAAS_WEBMAIL_CONTAINER, PAAS_WEBMAIL_VOLUME } from "@paas/core";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    deployService: DeployService;
    /** Aba Logs do projeto (project-logs.ts). */
    projectLogs: ProjectLogsService;
    auditService: AuditService;
    alertsService: AlertsService;
    /** Aviso ao dono quando a senha certa chega sem o código certo (login-watch.ts). */
    loginWatch: LoginWatch;
    /** Limite por CONTA nas rotas que pedem senha/código com a sessão aberta (action-guard.ts). */
    actionLimiter: LoginLimiter;
    /** Percebe o proxy da Cloudflare na frente do painel (edge-watch.ts). */
    edgeWatch: EdgeWatch;
  }
}

export interface BuildAppOptions {
  /** Fábrica de PTY do terminal web (testes injetam um fake sem Docker). */
  terminalPtyFactory?: PtyFactory;
}

export async function buildApp(options?: BuildAppOptions): Promise<FastifyInstance> {
  const config = loadConfig();
  const trustedProxies = new TrustedProxies();

  const app = Fastify({
    ajv: AJV_OPTIONS,
    // nível, redact e serializador de req (sem o token da URL): log-config.ts
    logger: loggerOptions(process.env.LOG_LEVEL ?? "info"),
    // Só o Caddy (e o loopback) informa o IP do cliente — ver trusted-proxies.ts (A4).
    trustProxy: trustedProxies.isTrusted,
  });
  if (existsSync("/.dockerenv")) {
    void trustedProxies.refresh();
    const trustedProxiesTimer = setInterval(() => void trustedProxies.refresh(), 60_000);
    trustedProxiesTimer.unref();
    app.addHook("onClose", async () => clearInterval(trustedProxiesTimer));
  }

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
  // Tokens de API (Configurações → Acesso por IA): carga preguiçosa, o painel sobe mesmo com o arquivo ilegível.
  app.decorate("apiTokens", new ApiTokenStore(config.dataDir, (m) => app.log.warn(m)));
  // Fase 4: auditoria + alertas no escopo raiz — consumidos por todas as rotas.
  app.decorate("auditService", new AuditService(config.dataDir));
  app.decorate("alertsService", new AlertsService(config.dataDir));
  const loginWatch = new LoginWatch({
    alerts: app.alertsService,
    audit: app.auditService,
    log: (m) => app.log.warn(m),
  });
  app.decorate("loginWatch", loginWatch);
  app.decorate("actionLimiter", new LoginLimiter());
  // Bearer inválido por IP: contagem própria, para não trancar o login de quem divide o IP.
  app.decorate("tokenLimiter", new LoginLimiter());
  const edgeWatch = new EdgeWatch();
  app.decorate("edgeWatch", edgeWatch);
  app.addHook("onRequest", async (request) => edgeWatch.observe(request.headers));
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
  // Backups: criado logo abaixo (precisa do DeployService). O gancho do
  // deploy só o usa depois que ele existe.
  let backupService: BackupService | null = null;
  // DeployService no escopo raiz: compartilhado entre as rotas de projetos e
  // de e-mail (Fase 3 registra o provedor de env vars SMTP nele).
  app.decorate(
    "deployService",
    new DeployService(config, {
      audit: app.auditService,
      alerts: app.alertsService,
      // DNS do par com/sem www dos domínios: só nome que já aponta para a VPS ganha redirecionamento
      hostState: makeHostState(() => publicIpFromConfig(config.panelDomain)),
      onDeployFinished: (e) => {
        notify(deployNotification(e));
        // A aba Backups do projeto mostra o que foi detectado DEPOIS do deploy.
        if (e.status === "success") {
          void backupService?.detectProject(e.projectId).catch((err: unknown) => {
            app.log.warn("backups: detecção depois do deploy falhou (%s)", err instanceof Error ? err.message : String(err));
          });
        }
      },
    }),
  );
  // Backups no escopo RAIZ: as rotas de backup, as de projetos (escolha na
  // criação, projeto apagado) e o gancho do deploy usam o mesmo objeto.
  const backupDocker = new DockerCli({ socketPath: config.dockerSocketPath, helperImage: config.hostHelperImage });
  // "O painel antigo tinha X ativo": compara o backup restaurado com o que roda de fato (Docker) e guarda as pendências.
  const restoreReconciliation = new RestoreReconciliation({
    dataDir: config.dataDir,
    containers: { stalwart: PAAS_STALWART_CONTAINER, webmail: PAAS_WEBMAIL_CONTAINER },
    probes: {
      container: (name) => backupDocker.probe(name),
      // Uma instância nova a cada consulta (lê o mail.json do disco na hora), como o roteiro faz em onboarding-sources.ts.
      mailAuth: () => new MailService(config, { log: () => undefined }).checkAdminAuth(),
      repairMailAuth: () => new MailService(config, { log: (m) => app.log.warn(m) }).repairAdminAuth(),
      // O serviço do domínio nasce depois; a função só roda numa restauração ou na conferência da tela, com tudo no ar.
      // DNS sem resposta ou sem IP público (túnel) lança: a conferência diz "não foi possível conferir".
      panelDomainPointsHere: (domain) => app.panelDomainService.pointsHereOrThrow(domain),
    },
    log: (m) => app.log.warn(m),
  });
  app.decorate("restoreReconciliation", restoreReconciliation);
  backupService = new BackupService({
    dataDir: config.dataDir,
    projectsDir: config.projectsDir,
    docker: backupDocker,
    reconciliation: restoreReconciliation,
    mailAuth: { repair: () => new MailService(config, { log: (m) => app.log.warn(m) }).repairAdminAuth() },
    // mailAdopt: o plugin de rotas do e-mail entrega o serviço da tela (backupService.setMailAdopt); ele não existe neste escopo.
    archiver: new SevenZip(),
    storage: (cfg) => new S3Storage(cfg),
    // O serviço do domínio nasce depois deste (linha abaixo); a função só roda numa restauração, com tudo no ar.
    panelDomainPointsHere: (domain) => app.panelDomainService.pointsHere(domain),
    projects: {
      list: () => app.deployService.listProjects(),
      get: (id) => app.deployService.getProject(id),
      srcDir: (p) => app.deployService.backupSourceDir(p),
      // Teste de restauração: nenhum deploy do projeto de destino começa enquanto o banco dele está sendo restaurado.
      hold: (id) => app.deployService.holdProject(id),
      // "VPS nova": publica do GitHub e espera terminar antes de pôr os dados de volta.
      redeploy: async (id) => {
        const job = await app.deployService.startDeploy(id);
        const deadline = Date.now() + 45 * 60_000;
        for (;;) {
          const current = await app.deployService.getJob(id, job.id);
          if (current && current.status !== "running" && current.status !== "queued") {
            if (current.status !== "success") throw new Error(`o deploy falhou: ${current.error ?? "veja o log do deploy"}`);
            return;
          }
          if (Date.now() > deadline) throw new Error("o deploy passou de 45 minutos");
          await new Promise((r) => setTimeout(r, 3000));
        }
      },
    },
    mail: {
      container: PAAS_STALWART_CONTAINER,
      volume: PAAS_STALWART_VOLUME,
      dataPath: "/opt/stalwart-mail/data",
      etcPath: "/opt/stalwart-mail/etc",
      webmailContainer: PAAS_WEBMAIL_CONTAINER,
      webmailVolume: PAAS_WEBMAIL_VOLUME,
      webmailPath: "/var/roundcube",
    },
    verifyLogin: async (userId, password) => {
      const user = await userStore.findById(userId);
      return verifyPasswordTimingSafe(user?.passwordHash ?? null, password);
    },
    notify,
    audit: app.auditService,
    log: (m) => app.log.warn(m),
    // Depois de preparar a restauração do painel: encerra o processo e o
    // Docker (restart: unless-stopped) sobe de novo; a troca acontece na
    // subida (index.ts → restorePanelAtBoot), que termina ou desfaz a troca.
    restartPanel: () => {
      app.log.warn("Backups: reiniciando o painel para terminar a restauração.");
      process.kill(process.pid, "SIGTERM");
    },
    timezoneName: () => timezoneService.current(),
  });
  app.decorate("backupService", backupService);
  // Fuso horário da VPS (Configurações → Fuso horário) no escopo RAIZ: as
  // rotas de fuso, os projetos ("Igual ao da VPS") e a agenda dos backups.
  // Com PAAS_TARGET=host o fuso é lido e trocado pelo host bridge (comandos
  // da allowlist, auditados); fora disso só dá para ver (dev/teste).
  const timezoneService: TimezoneService = new TimezoneService({
    dataDir: config.dataDir,
    bridge:
      config.securityTarget === "host"
        ? createHostTimezoneBridge(
            new NsenterHostRunner({
              image: config.hostHelperImage,
              onAudit: (detail) => void app.auditService.record({ action: "timezone.host-exec", detail }).catch(() => undefined),
            }),
            { read: HOST_TIMEZONE_READ_CMD, set: buildSetTimezoneCommand, parse: parseHostTimezoneOutput },
          )
        : null,
    startup: startupTimezone(),
    projects: {
      list: () => app.deployService.listProjects(),
      setTimezone: (id, setting, actor) => app.deployService.setProjectTimezone(id, setting, actor),
      recreate: (id, actor) => app.deployService.startRecreate(id, actor),
    },
    audit: app.auditService,
    log: (m) => app.log.warn(m),
    onChange: (zone, previous) => {
      app.log.info("Fuso horário: %s → %s (a agenda dos backups recalcula).", previous, zone);
      void backupService.timezoneChanged().catch((err: unknown) => {
        app.log.warn("backups: agenda não recalculada (%s)", err instanceof Error ? err.message : String(err));
      });
    },
  });
  app.decorate("timezoneService", timezoneService);
  app.deployService.setHostTimezoneProvider(() => timezoneService.vpsZone());
  // A montagem /host/etc/localtime congela quando o fuso muda na VPS: lê de
  // novo pelo host bridge logo depois de subir (em segundo plano).
  void timezoneService.refresh();
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
  // Domínio de aplicações (Configurações → Domínio de aplicações): base própria
  // para os endereços automáticos dos projetos, em data/apps-domain.json.
  const appsDomainService = buildAppsDomainService(app);
  await appsDomainService.init();
  app.decorate("appsDomainService", appsDomainService);
  // Acesso por HTTPS (PAAS_PANEL_DOMAIN): o Caddy central sobe JUNTO com o
  // painel, já com o site dele — senão só subiria no primeiro deploy.
  app.deployService.startPanelRoute({
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
  });
  // A4: containers antigos na paas-net com nome de painel como alias recebem aviso (só aviso)
  // (só no painel em container: é onde a migração de rede existe; testes e dev local não tocam o Docker)
  if (existsSync("/.dockerenv")) void app.deployService.warnReservedNetworkAliases({ warn: (msg) => app.log.warn(msg) });
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
      // O terminal é do operador. A sessão do PTY vive mais que a requisição que a
      // abriu: sem ator explícito, o evento herdaria o contexto de um token de API
      // (que só tocou o terminal de passagem) e sairia como `token:<nome>`.
      void app.auditService.record({ action, detail, actor: "operador" });
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

  // Setup concluído: não há token a carregar (ver loadSetupToken). Estado
  // ilegível derruba a subida, como as demais cargas estritas (M7).
  const token = await loadSetupToken(config.setupTokenFile, {
    setupCompleted: (await app.setupState.load()).completed,
    hasAdmin: await userStore.hasAdmin(),
  });
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
  await app.register(apiTokenRoutes);
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
      backupFacts: () => backupService.facts(),
    }),
  });
  await app.register(panelDomainRoutes);
  await app.register(appsDomainRoutes);
  await app.register(notificationsRoutes);
  await app.register(backupsRoutes);
  await app.register(restoreReconciliationRoutes);
  // Painel recém-restaurado: o mail.json pode ter a senha de administração de outro servidor; 20 s depois da subida
  // (com o Docker e o Stalwart no ar) o painel reaplica a configuração, se preciso. Nunca derruba a subida.
  const authRepair = setTimeout(() => {
    void restoreReconciliation.repairOpen().catch(() => undefined);
  }, 20_000);
  authRepair.unref();
  app.addHook("onClose", async () => clearTimeout(authRepair));
  await app.register(timezoneRoutes);
  await app.register(serverFolderRoutes);
  await app.register(integrationRoutes);
  await app.register(setupRestartRoutes);
  await app.register(securityRoutes);
  app.decorate(
    "projectLogs",
    new ProjectLogsService({
      listContainers: (timeoutMs, signal) => listContainers(config.dockerSocketPath, timeoutMs, signal),
      inspect: (id, timeoutMs, signal) => dockerInspect(config.dockerSocketPath, id, timeoutMs, signal),
      logs: (id, opts) => dockerLogs(config.dockerSocketPath, id, opts),
      now: () => Date.now(),
    }),
  );
  await app.register(projectsRoutes);
  await app.register(projectLogsRoutes);
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
  loginWatch.start();
  void warmUpDummyHash();
  const disk = new DiskWatcher({ path: config.dataDir, statfs, notify: async (e) => notify(e) });
  const certificates = new CertificateWatcher({
    list: async () => (await app.certificateService.list()).items,
    notify: async (e) => notify(e),
  });
  const reconcileDomainPairs = async () => {
    try {
      await app.deployService.reconcilePairs();
    } catch (err) {
      app.log.warn("domínios: conferência do par com/sem www falhou (%s)", err instanceof Error ? err.message : String(err));
    }
  };
  const watcherTimers = [
    setTimeout(() => void disk.check(), 2 * 60_000),
    setInterval(() => void disk.check(), 15 * 60_000),
    setTimeout(() => void certificates.check(), 10 * 60_000),
    setInterval(() => void certificates.check(), 6 * 60 * 60_000),
    // Par com/sem www: o DNS é configurado depois de conectar o domínio; quando ele passa a
    // apontar (ou deixa de), o redirecionamento nasce (ou sai) sozinho, sem novo deploy.
    setTimeout(() => void reconcileDomainPairs(), 3 * 60_000),
    setInterval(() => void reconcileDomainPairs(), 10 * 60_000),
  ];
  for (const t of watcherTimers) t.unref();
  // Backups: a agenda confere a cada minuto (horário, atraso, lembrete).
  backupService.start();
  // "Painel iniciado" (desligado por padrão): quando o servidor fica pronto.
  app.addHook("onReady", async () => notify(panelStartedNotification(new Date())));

  app.addHook("onClose", async () => {
    loginWatch.stop();
    backupService.stop();
    for (const t of watcherTimers) clearTimeout(t);
    await notificationService.close();
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
