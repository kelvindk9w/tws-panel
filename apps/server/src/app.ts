import { isIP } from "node:net";
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
import { loadSetupToken, writeMcpSetupCredentialFile } from "./services/setup-token.js";
import { internalCallBucket } from "./services/internal-call.js";
import { SetupStateStore } from "./services/setup-state.js";
import { TwoFactorService } from "./services/two-factor.js";
import { EmailCodeService } from "./services/email-code.js";
import { AccessService } from "./services/access-service.js";
import { UserStore } from "./services/user-store.js";
import { SessionStore } from "./services/session-store.js";
import { ApiTokenStore } from "./services/api-token-store.js";
import { DeployService, PANEL_CONTAINER } from "./services/deploy-service.js";
import { MailTestService } from "./services/mail-test-service.js";
import { MailTestDocker } from "./services/mail-test-docker.js";
import mailTestRoutes from "./routes/mail-test.js";
import { DynamicDomainsService, PUBLIC_IP_UNKNOWN_REASON, dynamicRouting } from "./services/dynamic-domains.js";
import { ASK_PATH, buildAskServer, loadAskSecret } from "./services/dynamic-ask-server.js";
import { buildPointsHere, collectOwnIps } from "./services/dynamic-dns-check.js";
import { resolve4, resolve6 } from "node:dns/promises";
import dynamicDomainsRoutes from "./routes/dynamic-domains.js";
import mcpAdminRoutes from "./routes/mcp-admin.js";
import mcpRoutes from "./routes/mcp.js";
import { readPanelVersion } from "./routes/health.js";
import { McpProtocol } from "./services/mcp-protocol.js";
import { McpApprovals } from "./services/mcp-approvals.js";
import { McpSettings } from "./services/mcp-settings.js";
import { AuditService } from "./services/audit-service.js";
import { AlertsService } from "./services/alerts-service.js";
import { TerminalService } from "./services/terminal-service.js";
import { TerminalGate } from "./services/terminal-gate.js";
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
import cloudflareRoutes, { buildCloudflareDns } from "./routes/cloudflare.js";
import setupRestartRoutes from "./routes/setup-restart.js";
import securityRoutes from "./routes/security.js";
import projectsRoutes from "./routes/projects.js";
import projectLogsRoutes from "./routes/project-logs.js";
import databaseRoutes from "./routes/project-database.js";
import { DatabaseService } from "./services/database-service.js";
import { DatabaseSettingsStore } from "./services/database-settings.js";
import { DatabaseUnlock } from "./services/database-unlock.js";
import { DockerDatabaseExec } from "./services/database-docker.js";
import metricsRoutes from "./routes/metrics.js";
import { createMetricsService, type MetricsService } from "./services/metrics-service.js";
import { ProjectLogsService } from "./services/project-logs.js";
import { dockerInspect, dockerLogs } from "./services/docker-logs.js";
import { listContainers } from "./services/docker-service.js";
import dockerRoutes from "./routes/docker.js";
import domainsRoutes, { makeHostState, publicIpFromConfig, publicIpFromPanelDomain } from "./routes/domains.js";
import mailRoutes from "./routes/mail.js";
import certificatesRoutes, { buildCertificateService } from "./routes/certificates.js";
import { ManualCertificateStore } from "./services/certificate-store.js";
import monitoringRoutes from "./routes/monitoring.js";
import terminalRoutes from "./routes/terminal.js";
import terminalAccessRoutes from "./routes/terminal-access.js";
import panelDomainRoutes, { buildPanelDomainService } from "./routes/panel-domain.js";
import appsDomainRoutes, { buildAppsDomainService } from "./routes/apps-domain.js";
import notificationsRoutes from "./routes/notifications.js";
import { NotificationService, type NotificationEvent } from "./services/notification-service.js";
import { CertificateAlertWatcher } from "./services/certificate-alerts.js";
import { consumeCaddyReload } from "./services/caddy-restore-reload.js";
import {
  DiskWatcher,
  alertNotification,
  deployNotification,
  panelStartedNotification,
} from "./services/notification-sources.js";
import { createTelegramClient } from "./services/telegram-client.js";
import backupsRoutes from "./routes/backups.js";
import uploadRestoreRoutes from "./routes/upload-restore.js";
import { UploadRestoreService, uploadRestoreMaxBytes } from "./services/upload-restore.js";
import restoreReconciliationRoutes from "./routes/restore-reconciliation.js";
import { MailService } from "./services/mail-service.js";
import { RestoreReconciliation } from "./services/restore-reconciliation.js";
import { BackupService, projectTargetId } from "./services/backup-service.js";
import { DockerCli } from "./services/backup-docker.js";
import { SevenZip } from "./services/backup-archive.js";
import { S3Storage } from "./services/backup-s3.js";
import { verifyPasswordTimingSafe, warmUpDummyHash } from "./services/password.js";
import timezoneRoutes from "./routes/timezone.js";
import accessRoutes from "./routes/access.js";
import dockerBuildRoutes from "./routes/docker-build.js";
import { DockerBuildService } from "./services/docker-build-service.js";
import { checkBuildx, detectFramework, run as runCommand } from "@paas/deploy";
import emailCodeRoutes from "./routes/email-code.js";
import { TimezoneService, createHostTimezoneBridge } from "./services/timezone-service.js";
import { startupTimezone } from "./services/host-timezone.js";
import { loggerOptions } from "./log-config.js";
import { TrustedProxies } from "./services/trusted-proxies.js";
import { LoginLimiter } from "./services/login-limiter.js";
import { LoginWatch } from "./services/login-watch.js";
import { EdgeWatch } from "./services/edge-watch.js";
import { HOST_TIMEZONE_READ_CMD, NsenterHostRunner, setAccessAdminUser, buildSetTimezoneCommand, parseHostTimezoneOutput } from "@paas/security";
import { PAAS_CADDY_CONTAINER, PAAS_CADDY_DATA_VOLUME, PAAS_STALWART_CONTAINER, PAAS_STALWART_VOLUME, PAAS_WEBMAIL_CONTAINER, PAAS_WEBMAIL_VOLUME } from "@paas/core";

declare module "fastify" {
  interface FastifyInstance {
    config: ServerConfig;
    deployService: DeployService;
    /** Caixa de teste de e-mail dos projetos (mail-test-service.ts). */
    mailTest: MailTestService;
    /** Aba Logs do projeto (project-logs.ts). */
    projectLogs: ProjectLogsService;
    /** Monitoramento de recursos: coletor de 60 s, séries, semáforo e alertas (metrics-service.ts). */
    metrics: MetricsService;
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
  /** Resolvedor de DNS do `ask` dos domínios dinâmicos (testes injetam um fake; o padrão é o do sistema). */
  dnsResolver?: { resolve4(host: string): Promise<string[]>; resolve6(host: string): Promise<string[]> };
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
  for (const w of config.deployHistory?.warnings ?? []) app.log.warn(w);
  app.decorate("apiTokens", new ApiTokenStore(config.dataDir, (m) => app.log.warn(m)));
  // MCP (acesso por IA): desligado por padrão; as aprovações humanas das ações sensíveis ficam em memória.
  const mcpSettings = new McpSettings(config.dataDir);
  await mcpSettings.load();
  app.decorate("mcpSettings", mcpSettings);
  app.decorate("mcpApprovals", new McpApprovals());
  // Fase 4: auditoria + alertas no escopo raiz — consumidos por todas as rotas.
  app.decorate("auditService", new AuditService(config.dataDir));
  // Código por e-mail (fator extra opcional); o plugin de e-mail entrega o envio.
  app.decorate("emailCode", new EmailCodeService(app.auditService));
  // Protocolo MCP (sessões e ferramentas): no app inteiro porque a tela de Configurações precisa encerrar as sessões
  // ao desligar o MCP, e a rota /mcp o usa para atender o cliente.
  app.decorate(
    "mcp",
    new McpProtocol({ app, approvals: app.mcpApprovals, audit: (entry) => app.auditService.record(entry), serverVersion: readPanelVersion() }),
  );
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
  // Caixa de teste de e-mail (Mailpit) dos projetos: o SMTP do projeto vai para ela enquanto estiver ligada.
  app.decorate(
    "mailTest",
    new MailTestService({
      dataDir: config.dataDir,
      docker: new MailTestDocker(),
      panelContainer: PANEL_CONTAINER,
      redirected: async (id) => (await app.deployService.mailTestInfo(id))?.variables ?? [],
      uncontrolled: (project) => app.deployService.mailTestUncontrolled(project),
      audit: app.auditService,
    }),
  );
  app.deployService.setMailTestProvider(app.mailTest);
  app.deployService.setLogger(app.log);
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
      hold: (id, reason) => app.deployService.holdProject(id, reason),
      maintenance: (slug) => app.deployService.holdMaintenance(slug),
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
    // Certificados e conta do Let's Encrypt do Caddy: entram só na cópia externa CIFRADA do painel.
    caddy: { container: PAAS_CADDY_CONTAINER, volume: PAAS_CADDY_DATA_VOLUME, dataPath: "/data" },
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
  // "Restaurar de um arquivo" (aba Backups do projeto): o envio é gravado em data/uploads/restore e apagado ao terminar.
  const uploadRestore = new UploadRestoreService({
    dataDir: config.dataDir,
    docker: backupDocker,
    backups: backupService,
    archiver: new SevenZip(),
    projects: {
      get: (id) => app.deployService.getProject(id),
      hold: (id, reason) => app.deployService.holdProject(id, reason),
      maintenance: (slug) => app.deployService.holdMaintenance(slug),
    },
    audit: app.auditService,
    maxBytes: uploadRestoreMaxBytes(),
    log: (m) => app.log.warn(m),
  });
  app.decorate("uploadRestore", uploadRestore);
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
  // Gestão do acesso à VPS (Segurança → Acesso): chaves SSH e senha Linux do usuário de administração e
  // desbloqueio do fail2ban, pelo host bridge (allowlist própria, cada comando auditado). Só na VPS real.
  // A allowlist só aceita trocar a senha do usuário de administração configurado (nenhuma outra conta).
  setAccessAdminUser(config.securityTarget === "host" ? config.terminalUser : null);
  app.decorate(
    "accessService",
    new AccessService({
      runner:
        config.securityTarget === "host"
          ? new NsenterHostRunner({
              image: config.hostHelperImage,
              onAudit: (detail) => void app.auditService.record({ action: "access.host-exec", detail }).catch(() => undefined),
            })
          : null,
      user: config.terminalUser,
      audit: app.auditService,
    }),
  );
  // Docker e BuildKit (Saúde da VPS): o buildx no CLI do painel (só verificação: a imagem o traz) e no Docker da
  // VPS (leitura e, com confirmação de identidade, instalação do pacote certo pelo host bridge). Só na VPS real.
  app.decorate(
    "dockerBuildService",
    new DockerBuildService({
      runner:
        config.securityTarget === "host"
          ? new NsenterHostRunner({
              image: config.hostHelperImage,
              onAudit: (detail) => void app.auditService.record({ action: "docker.host-exec", detail }).catch(() => undefined),
            })
          : null,
      panelCheck: async () => {
        const r = await checkBuildx((file, args, opts) => runCommand(file, args, opts));
        return r.ok ? { ok: true, version: r.version } : { ok: false, detail: r.detail };
      },
      audit: app.auditService,
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
  // Domínios dinâmicos (SaaS multi-cliente): emissão sob demanda pelo Caddy, autorizada pelo `ask`
  // do painel (servidor à parte, só na rede interna). No escopo raiz: o Caddyfile, a página
  // Certificados e a trava de nome repetido nos sites fixos usam o mesmo objeto.
  const inContainer = existsSync("/.dockerenv");
  const askPort = config.askPort ?? 9101;
  /** Por onde o Caddy pergunta ao painel; sem URL, o Caddy não alcança o painel e nada dinâmico é servido. */
  const dynamicRoute = () =>
    dynamicRouting({ inContainer, askPort, panelServed: app.deployService.panelSite !== null, panelContainer: PANEL_CONTAINER, askPath: ASK_PATH });
  const askSecret = await loadAskSecret(config.dataDir);
  /** O segredo vai na query: o Caddy a preserva e acrescenta `domain=`. */
  const askUrl = (): string | null => {
    const url = dynamicRoute().askUrl;
    return url ? `${url}?k=${askSecret}` : null;
  };
  /** Todos os IPs públicos da VPS que o painel conhece (ambiente, sslip.io do painel e o informado em Configurações). */
  const ownIps = (): string[] => {
    const site = app.deployService.panelSite;
    return collectOwnIps({
      configured: [config.publicIp, config.publicIpv6],
      manual: app.hasDecorator("dynamicDomains") ? app.dynamicDomains.manualIps() : [],
      hosts: [site?.domain, ...(site?.aliases ?? []), config.panelDomain],
      fromHost: publicIpFromPanelDomain,
    });
  };
  const pointsHere = buildPointsHere({
    // os IPs públicos que o painel conhece: PAAS_PUBLIC_IP (ou o do endereço sslip.io do painel) e PAAS_PUBLIC_IPV6.
    // Sem nenhum, o ask recusa toda emissão nova (falha segura).
    ownIps,
    resolve4: (host) => (options?.dnsResolver ?? { resolve4, resolve6 }).resolve4(host),
    resolve6: (host) => (options?.dnsResolver ?? { resolve4, resolve6 }).resolve6(host),
  });
  const dynamicDomains = new DynamicDomainsService({
    dataDir: config.dataDir,
    projectExists: async (id) => (await app.deployService.listProjects()).some((p) => p.id === id),
    staticOccupant: (host) => app.deployService.staticOccupant(host),
    pointsHere,
    fixedHostsUnder: (suffix) => app.deployService.fixedHostsUnder(suffix),
    appsBase: async () => (app.hasDecorator("appsDomainService") ? (await app.appsDomainService.status()).base : null),
    ownIps,
    issuedCertificates: async () => (await app.deployService.issuedCertificates?.()) ?? null,
    mtaStsHosts: async () => ((await app.deployService.mtaStsSites?.()) ?? []).map((s) => s.host),
    onDiscarded: (message) => {
      void app.alertsService
        .create({ severity: "warning", source: "certificate", title: "Domínios dos clientes: nomes antigos descartados", detail: message })
        .catch(() => undefined);
    },
    onUnreadable: (message) => {
      void app.alertsService
        .create({
          severity: "critical",
          source: "certificate",
          title: "Domínios dos clientes: arquivo de estado ilegível",
          detail: message,
        })
        .catch(() => undefined);
    },
    refreshProxy: () => app.deployService.refreshProxy(),
    inspect: async (_projectId, hosts) => (await app.certificateService.list({ hosts })).items,
    routing: () => {
      const { ready, reason } = dynamicRoute();
      if (ready && ownIps().length === 0) return { ready: false, reason: PUBLIC_IP_UNKNOWN_REASON };
      return { ready, reason };
    },
    audit: app.auditService,
    log: (m) => app.log.warn(m),
  });
  app.decorate("dynamicDomains", dynamicDomains);
  await dynamicDomains.preload();
  app.deployService.setDynamicClaims((host) => dynamicDomains.claimsSync(host));
  // Domínio comum também gera certificado (um por nome, inclusive sob a base das aplicações: não há curinga na emissão): gasta
  // a cota dos dinâmicos. Só IP e .localhost não geram certificado.
  app.deployService.setDomainQuota(async (host, count, actor) => {
    const h = host.toLowerCase();
    if (isIP(h) !== 0 || h === "localhost" || h.endsWith(".localhost")) return { release: () => undefined };
    try {
      await dynamicDomains.ensureReady();
    } catch {
      // estado ilegível: recusa sem gravar a contagem (os tetos e a janela da semana não são conhecidos)
      return { reason: "state_unreadable" };
    }
    return dynamicDomains.reserveManual(h, count, actor);
  });
  app.deployService.setDynamicDomainsProvider(async () => {
    const url = askUrl();
    return url ? { askUrl: url, projects: await dynamicDomains.proxyProjects(), mtaSts: (await app.deployService.mtaStsSites?.()) ?? [] } : null;
  });
  let askServer: ReturnType<typeof buildAskServer> | null = null;
  app.addHook("onReady", async () => {
    if (!askUrl()) return;
    askServer = buildAskServer({ authorize: (host) => dynamicDomains.authorize(host), secret: askSecret });
    // porta ocupada ou erro nunca derrubam o painel: sem o ask nenhum certificado novo sai (falha fechada)
    askServer.on("error", (err) => app.log.warn(`Domínios dinâmicos: o ouvido do ask falhou (${err.message}).`));
    askServer.listen(askPort, "0.0.0.0");
  });
  app.addHook("onClose", async () => {
    dynamicDomains.close();
    if (askServer?.listening) await new Promise<void>((resolve) => askServer!.close(() => resolve()));
    await dynamicDomains.flush();
  });
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
  // Cloudflare (opcional): cria os registros DNS que o painel hoje só lista. Antes do e-mail: o plugin dele entrega a leitura do cadastro.
  app.decorate("cloudflareDns", buildCloudflareDns(app));
  app.addHook("onClose", async () => app.cloudflareDns.flush());
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
  // Depois do setup o terminal só abre habilitado (senha + 2FA), por uma janela curta
  // e só para a sessão que se reautenticou (services/terminal-gate.ts).
  const terminalGate = new TerminalGate({
    windowMs: config.terminalEnableWindowMs,
    idleMs: config.terminalEnableIdleMs,
    // senha/2FA trocados ou sessão revogada: o shell que ficou vivo morre e o histórico some
    wipeShell: () => void terminalService.wipe().catch(() => undefined),
    audit: (action, detail, actor) => {
      void app.auditService.record({ action, detail, actor });
    },
  });
  const stopWatchingSessions = terminalGate.watch(sessionStore);
  app.decorate("terminalGate", terminalGate);
  // Transparência: quem é o terminal e como o root acontece, no log de boot.
  app.log.info(
    "Terminal web: usuário=%s, modo=%s (monitoramento agendado roda como root pelo host bridge em qualquer modo)",
    terminalAccess.user,
    terminalAccess.elevation,
  );

  // Reaper de boot (uma vez, não fatal): remove containers paas-terminal-*
  // órfãos de um processo anterior do painel — a sessão morre com o processo
  // e o helper (AutoRemove só dispara na saída do bash) ficaria para trás.
  // Build interrompido na queda anterior: devolve os arquivos de ignore do código ao que eram (não fatal).
  void app.deployService.recoverBuildLeftovers(app.log);

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
  if (token && config.mcpSetupLevel) {
    // A IA que ajuda a instalar recebe só esta credencial derivada, que vale apenas no /mcp.
    try {
      const file = await writeMcpSetupCredentialFile(config.setupTokenFile, token);
      app.log.info("Credencial do MCP para a instalação gravada em %s (0600). Ela só vale em /mcp.", file);
    } catch (err) {
      app.log.warn("não foi possível gravar a credencial do MCP da instalação: %s", err instanceof Error ? err.message : String(err));
    }
  }
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
    // As chamadas que o MCP faz à própria API contam num balde por token, não no IP de quem usa a tela.
    keyGenerator: (request) => internalCallBucket(request) ?? request.ip,
  });

  // Auth (setup token enquanto setup pendente; sessão depois) + rotas da API
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(apiTokenRoutes);
  await app.register(mcpAdminRoutes);
  await app.register(mcpRoutes);
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
  await app.register(uploadRestoreRoutes);
  await app.register(restoreReconciliationRoutes);
  // Painel recém-restaurado: o mail.json pode ter a senha de administração de outro servidor; 20 s depois da subida
  // (com o Docker e o Stalwart no ar) o painel reaplica a configuração, se preciso. Nunca derruba a subida.
  const authRepair = setTimeout(() => {
    void restoreReconciliation.repairOpen().catch(() => undefined);
  }, 20_000);
  authRepair.unref();
  app.addHook("onClose", async () => clearTimeout(authRepair));
  await app.register(timezoneRoutes);
  await app.register(accessRoutes);
  await app.register(dockerBuildRoutes);
  await app.register(emailCodeRoutes);
  await app.register(serverFolderRoutes);
  await app.register(integrationRoutes);
  await app.register(cloudflareRoutes);
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
  // Aba Banco: usa a detecção, as credenciais (lidas no container) e o backup completo dos backups.
  app.decorate(
    "databaseService",
    new DatabaseService({
      projects: {
        get: (id) => app.deployService.getProject(id),
        srcDir: (p) => app.deployService.backupSourceDir(p),
        secrets: (p) => app.deployService.logSecretValues(p),
      },
      docker: backupDocker,
      exec: new DockerDatabaseExec(config.dockerSocketPath),
      backups: {
        detection: async (projectId) => (await backupService.projectView(projectId)).detection ?? (await backupService.detectProject(projectId)),
        run: (projectId, actor) => backupService.runNow(projectTargetId(projectId), actor),
        record: (id) => backupService.record(id),
        busy: (projectId) => backupService.isBusyFor(projectTargetId(projectId)),
        restoreCheck: async (projectId) => (await backupService.projectView(projectId)).restoreCheck,
      },
      detectFramework,
      audit: app.auditService,
    }),
  );
  // Liberar a edição do banco (reautenticação uma vez, por sessão e projeto) e a configuração dela.
  const databaseSettings = new DatabaseSettingsStore(config.dataDir);
  await databaseSettings.load();
  app.decorate("databaseSettings", databaseSettings);
  const databaseUnlock = new DatabaseUnlock({
    settings: databaseSettings,
    isSessionActive: (id) => sessionStore.isActive(id),
    audit: (input) => void app.auditService.record(input).catch(() => undefined),
  });
  const stopWatchingUnlocks = databaseUnlock.watch(sessionStore);
  app.decorate("databaseUnlock", databaseUnlock);
  await app.register(databaseRoutes);
  await app.register(mailTestRoutes);
  // Monitoramento de recursos (métricas): o coletor só começa a rodar junto dos vigias, mais abaixo.
  const metrics = await createMetricsService({
    dataDir: config.dataDir,
    dockerSocketPath: config.dockerSocketPath,
    config: config.metrics,
    alerts: {
      create: (input) => app.alertsService.create(input),
      setStatus: (id, status) => app.alertsService.setStatus(id, status),
      listOpen: async () => (await app.alertsService.list({ status: "open", source: "resources", perPage: 200 })).alerts.map((a) => ({ id: a.id, title: a.title })),
    },
    log: (m) => app.log.warn(m),
    intent: (slug) => app.deployService.intentOf(slug),
    desired: (slug) => app.deployService.desiredReplicas(slug),
  });
  app.decorate("metrics", metrics);
  await app.register(metricsRoutes);
  await app.register(dockerRoutes);
  await app.register(domainsRoutes);
  await app.register(dynamicDomainsRoutes);
  await app.register(mailRoutes);
  // Página Certificados: depois do e-mail (que registra no deployService os
  // hosts mail.<domínio> e a instalação do certificado no Stalwart).
  await app.register(certificatesRoutes);
  // Fase 4 — por último. A checagem de blacklist do e-mail não passa mais por
  // aqui: é agendada dentro do plugin de e-mail (mail-reputation-service.ts).
  await app.register(monitoringRoutes);
  await app.register(terminalRoutes);
  await app.register(terminalAccessRoutes);

  // Notificações: novas tentativas e resumos a cada 30 s; disco a cada 15 min
  // e certificados a cada 30 min (lê a lista; cria alerta se não renovou). O primeiro giro dos vigias espera
  // o painel assentar (o proxy e o e-mail sobem em segundo plano).
  notificationService.start();
  loginWatch.start();
  void warmUpDummyHash();
  const disk = new DiskWatcher({ path: config.dataDir, statfs, notify: async (e) => notify(e) });
  const certificates = new CertificateAlertWatcher({
    items: async () => (await app.certificateService.list()).items,
    alerts: app.alertsService,
    notify: async (e) => notify(e),
    log: (m) => app.log.warn(m),
  });
  // Nome dinâmico com certificado já emitido: a partir daí a renovação não gasta a cota de emissões novas.
  const reconcileDynamicIssued = async () => {
    try {
      await dynamicDomains.reconcileIssued(await app.deployService.issuedCertificates());
    } catch (err) {
      app.log.warn("domínios dinâmicos: conferência dos certificados emitidos falhou (%s)", err instanceof Error ? err.message : String(err));
    }
  };
  const reconcileDomainPairs = async () => {
    try {
      await app.deployService.reconcilePairs();
    } catch (err) {
      app.log.warn("domínios: conferência do par com/sem www falhou (%s)", err instanceof Error ? err.message : String(err));
    }
  };
  // Certificados do Caddy devolvidos por uma restauração: recarga forçada para o proxy os ler (repete se o proxy ainda não subiu).
  const reloadCaddyAfterRestore = () =>
    consumeCaddyReload({
      backupsDir: path.join(config.dataDir, "backups"),
      reload: () => app.deployService.refreshProxy(undefined, { force: true }),
      log: (m) => app.log.warn(m),
    });
  const watcherTimers = [
    setTimeout(() => void reloadCaddyAfterRestore(), 90_000),
    setInterval(() => void reloadCaddyAfterRestore(), 12 * 60_000),
    setTimeout(() => void disk.check(), 2 * 60_000),
    setInterval(() => void disk.check(), 15 * 60_000),
    // Alerta de renovação: confere a cada 30 min (a saída do alerta pede 2 conferências limpas).
    setTimeout(() => void certificates.check(), 5 * 60_000),
    setInterval(() => void certificates.check(), 30 * 60_000),
    // Par com/sem www: o DNS é configurado depois de conectar o domínio; quando ele passa a
    // apontar (ou deixa de), o redirecionamento nasce (ou sai) sozinho, sem novo deploy.
    setTimeout(() => void reconcileDynamicIssued(), 2 * 60_000),
    setInterval(() => void reconcileDynamicIssued(), 11 * 60_000),
    setTimeout(() => void reconcileDomainPairs(), 3 * 60_000),
    setInterval(() => void reconcileDomainPairs(), 10 * 60_000),
  ];
  for (const t of watcherTimers) t.unref();
  // Backups: a agenda confere a cada minuto (horário, atraso, lembrete).
  backupService.start();
  // Envios de "Restaurar de um arquivo" que sobraram de antes (o painel caiu no meio): apagados na partida e a cada hora.
  uploadRestore.start();
  // Métricas: primeira coleta 10 s depois de subir e, daí, a cada 60 s (PAAS_METRICS=off desliga).
  metrics.start();
  // "Painel iniciado" (desligado por padrão): quando o servidor fica pronto.
  app.addHook("onReady", async () => notify(panelStartedNotification(new Date())));

  app.addHook("onClose", async () => {
    loginWatch.stop();
    backupService.stop();
    await uploadRestore.stop();
    await metrics.stop();
    for (const t of watcherTimers) clearTimeout(t);
    await notificationService.close();
    stopWatchingSessions();
    stopWatchingUnlocks();
    databaseUnlock.dispose();
    terminalGate.dispose();
    await terminalService.dispose();
    // Depois do dispose: encerrar terminais dispara auditoria sem await, e
    // essas gravações precisam terminar antes de o processo sair.
    await app.auditService.flush();
    // Por último e com prazo curto: não pode atrasar o que é mais importante no desligamento.
    if (!(await backupService.drain())) app.log.warn("Backups: o trabalho em segundo plano não terminou a tempo; o encerramento seguiu sem esperar.");
  });

  // Frontend estático (build do Vite) com fallback SPA
  if (existsSync(path.join(config.webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      // /api e /mcp nunca caem no fallback da SPA: o MCP desligado (ou uma rota de API inexistente) é um 404 de verdade,
      // idêntico ao de qualquer rota desconhecida, e não o index.html da tela.
      if (request.method === "GET" && !isApiOrMcpPath(request.url)) {
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

/** O endereço (sem query) é da API ou do MCP: `/api`, `/api/*`, `/mcp` e `/mcp/*`? */
export function isApiOrMcpPath(url: string): boolean {
  let path = url.split(/[?#]/)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // malformado: confere o texto como veio
  }
  path = path.replace(/\/{2,}/g, "/");
  return /^\/(api|mcp)(\/|$)/i.test(path);
}
