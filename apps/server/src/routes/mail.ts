/**
 * mail.ts — rotas do módulo de e-mail (Fase 3, plano §5.3).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { MAILBOX_DISPLAY_NAME_MAX, MAILBOX_DISPLAY_NAME_PATTERN, MAILBOX_PASSWORD_MIN, PROJECT_EMAIL_VALUE_KEYS } from "@paas/core";
import { mailAuthError, mailAuthRepairFailedError, mailSyncError } from "../services/mail-auth-error.js";
import type {
  ChangeMailboxPasswordRequest,
  CreateMailDomainRequest,
  CreateMailboxRequest,
  DnsChecklistResponse,
  DnsVerifyResponse,
  EnableProjectEmailRequest,
  ProjectEmailMailboxesResponse,
  MailDomainListResponse,
  MailDomainResponse,
  Mailbox,
  MailboxCredentialsResponse,
  MailboxListResponse,
  MailboxResponse,
  MailSyncResponse,
  MailServerActionResponse,
  MailServerStatus,
  MailTestResponse,
  MailTlsStatusResponse,
  ProjectEmailResponse,
  SendTestEmailRequest,
  SetMailboxDisplayNameRequest,
  SetMailboxDisplayNameResponse,
  SetProjectEmailLinksRequest,
} from "@paas/core";
import { MailService } from "../services/mail-service.js";
import { WebmailService } from "../services/webmail-service.js";
import webmailRoutes from "./webmail.js";
import { MailEnviosService } from "../services/mail-envios-service.js";
import { MailReputationService } from "../services/mail-reputation-service.js";
import { readStalwartLogs } from "../services/stalwart-logs.js";
import { migrateMailNetworks } from "../services/mail-network-migration.js";
import { mailEnviosRoutes } from "./mail-envios.js";
import { httpError, type HttpError } from "../services/deploy-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

declare module "fastify" {
  interface FastifyInstance {
    mailService: MailService;
  }
}

// -----------------------------------------------------------------------------
// Schemas de validação.
//
// Param `:domain`: o valor vira nome de diretório e argumento de comando no
// Stalwart (ver MailService/StalwartManager) — o caso mais sensível deste
// arquivo. O pattern abaixo espelha a MESMA regra de hostname usada em
// normalizeMailDomain (apps/server/src/services/mail-service.ts), para que a
// recusa aconteça já na borda HTTP e não só no service. normalizeMailDomain
// testa o valor após trim + minúsculas; aqui aceitamos as duas caixas para
// não restringir o conjunto de domínios aceitos além do que o service aceita.
const MAIL_DOMAIN_PATTERN =
  "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$";

const MAIL_DOMAIN_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  pattern: MAIL_DOMAIN_PATTERN,
} as const;

const domainParamSchema = {
  params: {
    type: "object",
    required: ["domain"],
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
} as const;

const createMailDomainSchema = {
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: {
      domain: MAIL_DOMAIN_SCHEMA,
      // Confirmação explícita de que o domínio já recebe e-mail em outro
      // servidor e o operador quer seguir mesmo assim (ver addDomain).
      confirmExistingMail: { type: "boolean" },
    },
  },
} as const;

// Local-part de caixa (parte antes do @): mesmo alfabeto aceito por
// normalizeLocalPart (mail-service.ts), nas duas caixas pelo mesmo motivo do
// domínio acima — o service normaliza para minúsculas antes de validar.
const MAILBOX_LOCAL_PART_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
} as const;

// Senha de caixa: o service (createMailbox) recusa senha com menos de 8
// caracteres — mesmo mínimo aqui, para recusar já na borda. maxLength alto
// (200) para não impedir senhas geradas por gerenciadores externos.
// A pessoa define a senha (o painel nunca a mostra de volta).
const MAILBOX_PASSWORD_SCHEMA = {
  type: "string",
  minLength: MAILBOX_PASSWORD_MIN,
  maxLength: 200,
} as const;

// Nome de exibição: vai para o campo description do Stalwart (JSON), para o
// cabeçalho From e para o MAIL_FROM_NAME. Sem controle (CR/LF/TAB), < >, aspas
// nem barra invertida; vazio = sem nome (o service normaliza e confere de novo).
const MAILBOX_DISPLAY_NAME_SCHEMA = {
  type: "string",
  maxLength: MAILBOX_DISPLAY_NAME_MAX,
  pattern: MAILBOX_DISPLAY_NAME_PATTERN,
} as const;

// Id de caixa (endereço completo, ex.: vendas@exemplo.com, por vezes
// URL-encoded). 90 fica abaixo do teto padrão de param do Fastify (100, que
// responde 414 antes do schema) e é generoso para qualquer endereço real.
const MAILBOX_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 90,
} as const;

// Id de projeto: mesmo limite usado em projects.ts (updateProjectSchema).
const PROJECT_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 64 } as const;

// Listagem das caixas; com ?projectId=, só as daquele projeto.
const listMailboxesSchema = {
  params: domainParamSchema.params,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { projectId: PROJECT_ID_SCHEMA },
  },
} as const;

const createMailboxSchema = {
  params: {
    type: "object",
    required: ["domain"],
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
  body: {
    type: "object",
    required: ["localPart"],
    additionalProperties: false,
    properties: {
      localPart: MAILBOX_LOCAL_PART_SCHEMA,
      password: MAILBOX_PASSWORD_SCHEMA,
      generatePassword: { type: "boolean" },
      // criada pela aba Caixas do e-mail do projeto: a caixa fica sendo dele
      projectId: PROJECT_ID_SCHEMA,
      displayName: MAILBOX_DISPLAY_NAME_SCHEMA,
    },
    // a senha da pessoa OU "gere uma forte para mim"
    anyOf: [
      { required: ["password"] },
      { required: ["generatePassword"], properties: { generatePassword: { const: true } } },
    ],
  },
} as const;

const mailboxParamSchema = {
  params: {
    type: "object",
    required: ["domain", "id"],
    properties: {
      domain: MAIL_DOMAIN_SCHEMA,
      id: MAILBOX_ID_SCHEMA,
    },
  },
} as const;

const mailboxIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: MAILBOX_ID_SCHEMA },
  },
} as const;

const projectIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: PROJECT_ID_SCHEMA },
  },
} as const;

const enableProjectEmailSchema = {
  params: projectIdParamSchema.params,
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: {
      domain: MAIL_DOMAIN_SCHEMA,
      fromLocalPart: MAILBOX_LOCAL_PART_SCHEMA,
      // Vai para o cabeçalho From e para o Stalwart: mesma regra do nome de exibição das caixas.
      fromName: MAILBOX_DISPLAY_NAME_SCHEMA,
      // Senha da caixa do projeto: digitada pela pessoa ou gerada pelo painel.
      password: MAILBOX_PASSWORD_SCHEMA,
      generatePassword: { type: "boolean" },
      // Usar a caixa <fromLocalPart>@<domain> que já existe (nada é apagado).
      useExistingMailbox: { type: "string", enum: ["current_password", "keep_password", "replace_password"] },
    },
  },
} as const;

const projectEmailMailboxesSchema = {
  params: projectIdParamSchema.params,
  querystring: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
} as const;

// Ligação de variáveis do app a valores do e-mail: nome no padrão das
// Variáveis do projeto (o service confere também os nomes reservados) →
// um dos valores que o e-mail do projeto fornece.
const projectEmailLinksSchema = {
  params: projectIdParamSchema.params,
  body: {
    type: "object",
    required: ["links"],
    additionalProperties: false,
    properties: {
      links: {
        type: "object",
        maxProperties: 30,
        propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" },
        additionalProperties: { type: "string", enum: [...PROJECT_EMAIL_VALUE_KEYS] },
      },
    },
  },
} as const;

// E-mail de teste: UM destinatário. O valor vira argumento de comando SMTP
// (RCPT TO), então nada de espaço, quebra de linha, vírgula, ponto e vírgula
// ou <> — mesma regra de isSingleEmailAddress (@paas/mailer), que o service
// confere de novo. O remetente (opcional) segue a mesma regra.
const SINGLE_EMAIL_SCHEMA = {
  type: "string",
  minLength: 3,
  maxLength: 254,
  pattern:
    "^[^\\s@<>(),;:\"\\[\\]\\\\]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$",
} as const;

const sendTestEmailSchema = {
  params: domainParamSchema.params,
  body: {
    type: "object",
    required: ["to"],
    additionalProperties: false,
    properties: {
      to: SINGLE_EMAIL_SCHEMA,
      from: SINGLE_EMAIL_SCHEMA,
    },
  },
} as const;

const testEmailStatusSchema = {
  params: {
    type: "object",
    required: ["domain", "id"],
    properties: {
      domain: MAIL_DOMAIN_SCHEMA,
      id: { type: "string", pattern: "^[a-f0-9]{16}$" },
    },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  // 401/403 do Stalwart (senha de administração divergente depois de restaurar): mensagem única, ver mail-auth-error.ts
  err = mailAuthError(err) ?? err;
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
    ...(e.details ?? {}),
  });
}

/** Intervalo da manutenção do certificado (emissão nova e renovação). */
const TLS_MAINTENANCE_MS = 60 * 60 * 1000;

const mailRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  // O sink de auditoria precisa ser injetado aqui: sem ele, deleteMailbox
  // remove a caixa sem deixar registro na trilha, ao contrário de criar
  // domínio e criar caixa.
  const service = new MailService(app.config, {
    audit: app.auditService,
    // dono das caixas que o painel adota do Stalwart (endereço <slug>@ = caixa do projeto)
    projects: () => app.deployService.listProjects(),
    // Certificado manual de mail.<domínio> (página Certificados) vence o do Caddy.
    ...(app.hasDecorator("certificateStore")
      ? { manualCertificate: (host: string) => app.certificateStore.forHost(host) }
      : {}),
  });
  app.decorate("mailService", service);
  // Avisos do painel por e-mail (Configurações → Notificações): o serviço de
  // notificações mora no escopo raiz e só este plugin enxerga o MailService.
  if (app.hasDecorator("notificationService")) {
    app.notificationService.setEmailSender({
      readiness: () => service.systemMailReadiness(),
      send: (msg) => service.sendSystemMail(msg),
    });
  }
  // Restaurar o e-mail cadastra no painel o que o Stalwart trouxe: o backup
  // usa ESTE serviço (o da tela); uma segunda instância deixaria a da tela desatualizada.
  if (app.hasDecorator("backupService")) {
    app.backupService.setMailAdopt({ adopt: () => service.adoptFromStalwart() });
  }
  // Webmail (Roundcube em https://mail.<domínio>/): acompanha o servidor de
  // e-mail e conta ao proxy se os blocos mail.<domínio> abrem o webmail.
  const webmail = new WebmailService(app.config, service, {
    audit: app.auditService,
    log: (message) => app.log.warn(message),
  });
  app.deployService.setWebmailProvider?.(() => webmail.proxyState());
  await app.register(webmailRoutes, { webmail });
  /**
   * Nome de exibição das caixas no webmail (04/10/2026): salvar ou desativar
   * o e-mail do projeto regrava o arquivo de nomes. Em segundo plano — não
   * prende a resposta; falha fica no log e a sincronização de hora em hora
   * tenta de novo.
   */
  const syncWebmailInBackground = (): void => {
    webmail.sync().catch((err: unknown) => {
      app.log.warn(`Webmail: falha ao atualizar os nomes de exibição (${err instanceof Error ? err.message : String(err)}).`);
    });
  };

  /**
   * Validação real (02/10/2026): o domínio foi cadastrado antes de existir o
   * registro A de mail.<domínio>; o Caddy falhou e ficou esperando, e só o
   * "Tentar emitir agora" da página Certificados resolveu. Quando a
   * verificação encontra o registro A apontando para a VPS, faz o mesmo
   * pedido (o recarregamento do proxy roda em segundo plano). As regras da
   * página Certificados valem: certificado já válido, modo manual ou limite
   * do Let's Encrypt recusam, e a recusa não atrapalha a verificação. O
   * serviço de certificados fica no escopo raiz (app.ts); sem ele, nada é pedido.
   */
  async function requestMailCertificate(
    verify: DnsVerifyResponse,
    log: { info: (msg: string) => void },
  ): Promise<DnsVerifyResponse["certificateRetry"]> {
    const a = verify.records.find((r) => r.id === "a");
    if (a?.status !== "found" || !app.hasDecorator("certificateService")) return undefined;
    try {
      const { host, message } = await app.certificateService.retry(a.name, { background: true });
      return { host, message };
    } catch (err) {
      const e = err as Partial<HttpError>;
      // Pedido de há pouco (limite de 1 por minuto): a emissão já está pedida.
      if (e.code === "retry_too_soon") {
        return { host: a.name, message: `A emissão do certificado de ${a.name} já foi pedida há pouco.` };
      }
      log.info(`E-mail: certificado de ${a.name} não pedido na verificação (${e.code ?? e.message ?? String(err)}).`);
      return undefined;
    }
  }

  // Conecta a injeção SMTP ao fluxo de deploy da Fase 2.
  app.deployService.setEnvProvider(service.envForProject);
  // Projeto removido: o e-mail dele é solto (a caixa e as mensagens ficam). A falha sobe para o
  // deploy registrar no log da remoção; o que sobrar é limpo na próxima abertura do e-mail.
  app.deployService.setProjectRemovedListener?.(async (projectId) => {
    try {
      await service.releaseProjectEmail(projectId);
    } catch (err) {
      app.log.warn({ projectId, error: err instanceof Error ? err.message : String(err) }, "falha ao soltar o e-mail do projeto removido");
      throw err;
    }
  });
  // Variáveis do app ligadas a valores do e-mail (SMTP_SENHA ← SMTP_PASS…).
  app.deployService.setLinkedEnvProvider?.(service.linkedEnvForProject);
  // …e de onde vem cada uma (só nomes), para a seção Variáveis.
  app.deployService.setEnvLinkSourcesProvider?.(service.envLinksForProject);
  // O proxy central serve mail.<domínio> para o Caddy emitir o certificado
  // que o Stalwart passa a usar (ver MailService.syncTls).
  app.deployService.setMailHostsProvider(() => service.mailHosts());
  // A página Certificados instala no Stalwart na hora em que mail.<domínio> fica válido.
  app.deployService.setMailTlsSync?.(() => service.syncTls());

  /**
   * Os hosts de e-mail mudaram (domínio novo/removido, servidor iniciado):
   * recalcula o Caddyfile e instala o que já houver de certificado. Em
   * segundo plano — a emissão leva de segundos a minutos e não pode prender
   * a resposta; falha fica no log (e a página mostra o estado em /api/mail/tls).
   */
  let lastProxyHosts: string | null = null;
  // A4: tira o e-mail da paas-net dos projetos (uma vez por processo; falha tenta de novo na próxima rodada)
  let networksMigrated = false;
  const migrateNetworks = async (): Promise<void> => {
    if (networksMigrated) return;
    await migrateMailNetworks({
      mail: service,
      joinProject: (id) => app.deployService.joinMailNetwork(id),
      syncWebmail: () => webmail.sync(),
      log: (message) => app.log.warn(message),
    });
    networksMigrated = true;
  };
  const refreshMailTls = async (opts: { force: boolean }): Promise<void> => {
    await migrateNetworks().catch((err: unknown) => {
      app.log.warn(`E-mail: migração para as redes separadas falhou (${err instanceof Error ? err.message : String(err)}); tento de novo depois.`);
    });
    const hosts = (await service.mailHosts()).join(",");
    if (opts.force || hosts !== lastProxyHosts) {
      await app.deployService.refreshProxy();
      lastProxyHosts = hosts;
    }
    await service.syncTls();
    // domínio novo, certificado instalado, servidor iniciado: o webmail acompanha
    await webmail.sync();
  };
  const refreshInBackground = (opts: { force: boolean }): void => {
    refreshMailTls(opts).catch((err: unknown) => {
      app.log.warn(
        `Certificado do servidor de e-mail: falha ao atualizar (${err instanceof Error ? err.message : String(err)}).`,
      );
    });
  };
  // Renovação: o Let's Encrypt renova o certificado a cada ~60 dias (o Caddy
  // faz isso sozinho); a cada hora o painel confere e reinstala no Stalwart
  // se mudou. A primeira rodada sai 1 min depois do boot.
  const firstRun = setTimeout(() => refreshInBackground({ force: false }), 60_000);
  firstRun.unref();
  const maintenance = setInterval(() => refreshInBackground({ force: false }), TLS_MAINTENANCE_MS);
  maintenance.unref();
  app.addHook("onClose", async () => {
    clearTimeout(firstRun);
    clearInterval(maintenance);
  });

  // -------------------------------------------------------------------------
  // Página Envios: fila, histórico (registro do Stalwart a cada 5 min),
  // volume, listas de bloqueio (uma vez por dia) e a nota. Fica AQUI porque
  // só este plugin enxerga o MailService (ver mail-reputation-service.ts).
  // -------------------------------------------------------------------------
  const envios = new MailEnviosService({
    dataDir: app.config.dataDir,
    serverCreated: () => service.enviosServerCreated(),
    listQueue: () => service.enviosQueue(),
    retry: (id) => service.enviosRetry(id),
    cancel: (id) => service.enviosCancel(id),
    senders: () => service.enviosSenders(),
    projectNames: async () => new Map((await app.deployService.listProjects()).map((p) => [p.id, p.name])),
    readLogs: (since, onLine) => readStalwartLogs(since, onLine),
  });
  const reputation = new MailReputationService({
    dataDir: app.config.dataDir,
    targets: () => service.enviosBlacklistTargets(),
    facts: () => service.enviosDeliverabilityFacts(),
    onListed: async (lines) => {
      if (!app.hasDecorator("alertsService")) return;
      await app.alertsService.create({
        severity: "critical",
        source: "blacklist",
        title: "E-mail: IP ou domínio listado em blacklist",
        detail: lines.join("\n"),
      });
    },
  });
  mailEnviosRoutes(app, {
    envios,
    reputation,
    domainNames: async () => (await service.listDomains()).map((d) => d.name),
  });
  envios.start();
  reputation.start();
  app.addHook("onClose", async () => {
    envios.stop();
    reputation.stop();
  });

  // -------------------------------------------------------------------------
  // Servidor Stalwart
  // -------------------------------------------------------------------------

  app.get("/api/mail/status", async (_request, reply) => {
    try {
      const status: MailServerStatus = await service.status();
      return reply.send(status);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/mail/server/start", async (_request, reply) => {
    try {
      const status = await service.startServer();
      refreshInBackground({ force: true });
      const response: MailServerActionResponse = { ok: true, status };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Depois de restaurar: reescreve a configuração do Stalwart com a senha de administração do painel e reinicia (sem apagar dados).
  app.post("/api/mail/server/repair-auth", async (_request, reply) => {
    try {
      const result = await service.repairAdminAuth();
      // Não finge sucesso: o botão só some quando a senha passou a autenticar.
      if (result === "failed" || result === "unreachable" || result === "not_running") {
        return sendError(reply, mailAuthRepairFailedError(result));
      }
      await app.auditService.record({
        action: "mail.server.repair_auth",
        target: "mail-server",
        detail:
          result === "repaired"
            ? "Servidor de e-mail reiniciado com a configuração do painel: a senha de administração guardada não era a do servidor em execução."
            : "Senha de administração do servidor de e-mail conferida (resultado: " + result + ").",
      });
      return reply.send({ ok: true, result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Cadastra no painel os domínios e caixas que o Stalwart já tem (depois de restaurar o e-mail). Nada é ativado; senhas nunca são lidas.
  app.post(
    "/api/mail/sync",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      try {
        const result = await service.adoptFromStalwart();
        if (result.domains.length > 0 || result.mailboxes.length > 0) {
          refreshInBackground({ force: true });
          await app.auditService.record({
            action: "mail.sync",
            target: "mail-server",
            detail: `Cadastrados a partir do servidor de e-mail: ${result.domains.length} domínio(s) e ${result.mailboxes.length} caixa(s).`,
          });
        }
        if (result.passwordsRealigned !== undefined || result.passwordsReapplied !== undefined || result.passwordsFailed !== undefined) {
          // só contagens: nem senhas nem endereços vão para a trilha
          await app.auditService.record({
            action: "mail.sync",
            target: "mail-server",
            detail: `Senhas no servidor de e-mail: ${result.passwordsRealigned ?? 0} caixa(s) realinhada(s); ${result.passwordsReapplied ?? 0} caixa(s) reaplicada(s) sem conferir; ${result.passwordsFailed?.length ?? 0} falha(s).`,
          });
        }
        const response: MailSyncResponse = {
          ok: true,
          domainCount: result.domains.length,
          mailboxCount: result.mailboxes.length,
          ...result,
        };
        return reply.send(response);
      } catch (err) {
        // Senha de administração que o reparo automático não resolveu: o Dashboard passa a oferecer Reparar agora.
        const code = (err as Partial<HttpError>).code;
        if (code === "mail_auth_repair_failed" || code === "mail_auth_repair_incomplete" || code === "mail_auth_still_refused" || mailAuthError(err)) {
          await app.restoreReconciliation?.markPending(["mail-auth"], "email").catch((e: unknown) => {
            app.log.warn(`Reconciliação: não deu para guardar a pendência de autenticação (${e instanceof Error ? e.message : String(e)}).`);
          });
        }
        return sendError(reply, mailSyncError(err) ?? err);
      }
    },
  );

  app.post("/api/mail/server/stop", async (_request, reply) => {
    try {
      const status = await service.stopServer();
      webmail.followMailServer(false).catch((err: unknown) => {
        app.log.warn(`Webmail: falha ao parar junto com o servidor (${err instanceof Error ? err.message : String(err)}).`);
      });
      const response: MailServerActionResponse = { ok: true, status };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Domínios
  // -------------------------------------------------------------------------

  app.get("/api/mail/domains", async (_request, reply) => {
    const domains = await service.listDomains();
    const response: MailDomainListResponse = { domains };
    return reply.send(response);
  });

  app.post<{ Body: CreateMailDomainRequest }>(
    "/api/mail/domains",
    { schema: createMailDomainSchema },
    async (request, reply) => {
      try {
        const name = request.body?.domain ?? "";
        const domain = await service.addDomain(
          name,
          request.body?.confirmExistingMail ? { confirmExistingMail: true } : {},
        );
        refreshInBackground({ force: true });
        await app.auditService.record({
          action: "mail.domain.add",
          target: domain.name,
          detail: `Domínio de e-mail ${domain.name} provisionado (DKIM ${domain.dkimKeyBits}-bit).`,
        });
        const response: MailDomainResponse = { domain };
        return reply.code(201).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        await service.removeDomain(request.params.domain);
        refreshInBackground({ force: true });
        await app.auditService.record({
          action: "mail.domain.remove",
          target: request.params.domain,
          detail: `Domínio de e-mail ${request.params.domain} removido.`,
        });
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Certificado do servidor de e-mail (mail.<domínio>): válido ou o que falta.
  app.get("/api/mail/tls", async (_request, reply) => {
    try {
      const response: MailTlsStatusResponse = await service.tlsStatus();
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Check de blacklist (card da página Segurança): a mesma conferência da
  // página Envios (com a chave DQS e o resultado guardado). Sem domínio
  // cadastrado, confere só o IP, como antes.
  app.get("/api/mail/blacklist", async (_request, reply) => {
    try {
      const state = await reputation.check({ manual: false });
      const response = state.lastCheck ?? (await service.checkBlacklists());
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/dns",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        const response: DnsChecklistResponse = await service.dnsChecklist(request.params.domain);
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/verify",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        const response: DnsVerifyResponse = await service.verifyDomain(request.params.domain);
        const certificateRetry = await requestMailCertificate(response, request.log);
        return reply.send(certificateRetry ? { ...response, certificateRetry } : response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // E-mail de teste (página do domínio)
  // -------------------------------------------------------------------------

  // Envia uma mensagem simples de postmaster@<domínio> para o endereço
  // informado. Limite de frequência no service (1 a cada 30 s, 20 por hora)
  // para o botão não virar fonte de spam.
  app.post<{ Params: { domain: string }; Body: SendTestEmailRequest }>(
    "/api/mail/domains/:domain/test-email",
    { schema: sendTestEmailSchema },
    async (request, reply) => {
      try {
        const test = await service.sendTestEmail(request.params.domain, request.body.to, request.body.from);
        await app.auditService.record({
          action: "mail.test.send",
          target: test.domain,
          detail: `E-mail de teste enviado de ${test.from} para ${test.to}.`,
        });
        const response: MailTestResponse = { test };
        return reply.code(202).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Destino do e-mail de teste (a página consulta a cada poucos segundos).
  app.get<{ Params: { domain: string; id: string } }>(
    "/api/mail/domains/:domain/test-email/:id",
    { schema: testEmailStatusSchema },
    async (request, reply) => {
      try {
        const test = await service.testEmailStatus(request.params.domain, request.params.id);
        const response: MailTestResponse = { test };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Caixas de e-mail
  // -------------------------------------------------------------------------

  /** Põe o nome do projeto dono em cada caixa (projeto que não existe mais: sem nome). */
  async function withProjectNames(mailboxes: Mailbox[]): Promise<Mailbox[]> {
    const names = new Map<string, string | null>();
    for (const id of new Set(mailboxes.flatMap((m) => (m.projectId ? [m.projectId] : [])))) {
      names.set(id, (await app.deployService.getProject(id))?.name ?? null);
    }
    return mailboxes.map((m) => {
      const name = m.projectId ? names.get(m.projectId) : null;
      return name ? { ...m, projectName: name } : m;
    });
  }

  app.get<{ Params: { domain: string }; Querystring: { projectId?: string } }>(
    "/api/mail/domains/:domain/mailboxes",
    { schema: listMailboxesSchema },
    async (request, reply) => {
      try {
        const { projectId } = request.query;
        const mailboxes = await withProjectNames(
          await service.listMailboxes(request.params.domain, projectId ? { projectId } : {}),
        );
        const response: MailboxListResponse = { mailboxes };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { domain: string }; Body: CreateMailboxRequest }>(
    "/api/mail/domains/:domain/mailboxes",
    { schema: createMailboxSchema },
    async (request, reply) => {
      try {
        const generate = request.body?.generatePassword === true;
        const projectId = request.body?.projectId;
        // criada pela aba do projeto: o projeto precisa existir
        if (projectId && !(await app.deployService.getProject(projectId))) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const displayName = request.body?.displayName;
        const opts = {
          ...(generate ? { generate: true } : {}),
          ...(projectId ? { projectId } : {}),
          ...(displayName ? { displayName } : {}),
        };
        const { mailbox, generatedPassword } = await service.createMailbox(
          request.params.domain,
          request.body?.localPart ?? "",
          generate ? undefined : request.body?.password,
          ...(Object.keys(opts).length > 0 ? [opts] : []),
        );
        await app.auditService.record({
          action: "mail.mailbox.create",
          target: `${mailbox.localPart}@${request.params.domain}`,
          detail: `Caixa de e-mail ${mailbox.localPart}@${request.params.domain} criada.`,
        });
        if (displayName) syncWebmailInBackground();
        // a senha gerada sai só nesta resposta (nunca vai para a auditoria)
        const response: MailboxResponse = generatedPassword ? { mailbox, generatedPassword } : { mailbox };
        return reply.code(201).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Nome de exibição de qualquer caixa (global ou do projeto). Só ele muda:
  // senha, 2FA, senhas de app, aliases e mensagens ficam como estão. Com
  // `projectId`, a caixa precisa ser daquele projeto. Mesmo limite das demais
  // rotas de escrita do e-mail (200/min por IP); CSRF e sessão vêm do guard global.
  app.put<{ Params: { id: string }; Body: SetMailboxDisplayNameRequest }>(
    "/api/mail/mailboxes/:id/display-name",
    {
      schema: {
        ...mailboxIdParamSchema,
        body: {
          type: "object",
          required: ["displayName"],
          additionalProperties: false,
          properties: { displayName: MAILBOX_DISPLAY_NAME_SCHEMA, projectId: PROJECT_ID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      try {
        const { displayName, projectId } = request.body;
        if (projectId && !(await app.deployService.getProject(projectId))) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const result: SetMailboxDisplayNameResponse = await service.setMailboxDisplayName(request.params.id, displayName, {
          ...(projectId ? { projectId } : {}),
          projectName: async (id) => (await app.deployService.getProject(id))?.name,
        });
        // o webmail recebe o nome novo (em segundo plano)
        syncWebmailInBackground();
        const [withName] = await withProjectNames([result.mailbox]);
        return reply.send(withName ? { ...result, mailbox: withName } : result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { domain: string; id: string } }>(
    "/api/mail/domains/:domain/mailboxes/:id",
    { schema: mailboxParamSchema },
    async (request, reply) => {
      try {
        await service.deleteMailbox(request.params.domain, request.params.id);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Trocar a senha (quem esqueceu troca: a senha nunca é mostrada). Com
  // `generate: true`, o painel gera uma forte e a devolve só nesta resposta.
  app.put<{ Params: { id: string }; Body: ChangeMailboxPasswordRequest }>(
    "/api/mail/mailboxes/:id/password",
    {
      schema: {
        ...mailboxIdParamSchema,
        body: {
          type: "object",
          additionalProperties: false,
          anyOf: [{ required: ["password"] }, { required: ["generate"] }],
          properties: { password: MAILBOX_PASSWORD_SCHEMA, generate: { type: "boolean", const: true } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { mailbox, generatedPassword } = request.body.generate
          ? await service.changeMailboxPassword(request.params.id, undefined, { generate: true })
          : await service.changeMailboxPassword(request.params.id, request.body.password);
        await app.auditService.record({
          action: "mail.mailbox.password",
          target: mailbox.id,
          detail: `Senha da caixa de e-mail ${mailbox.id} trocada${generatedPassword ? " (gerada pelo painel)" : ""}.`,
        });
        const response: MailboxResponse = generatedPassword ? { mailbox, generatedPassword } : { mailbox };
        // A senha gerada aparece uma única vez: nada de cache no caminho.
        if (generatedPassword) reply.header("cache-control", "no-store");
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/mail/mailboxes/:id/credentials",
    { schema: mailboxIdParamSchema },
    async (request, reply) => {
      try {
        const credentials = await service.mailboxCredentials(request.params.id);
        const response: MailboxCredentialsResponse = { credentials };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // E-mail de projeto (injeção SMTP)
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/email",
    { schema: projectIdParamSchema },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      }
      const email = await service.projectEmailConfig(project.id);
      const response: ProjectEmailResponse = { email };
      return reply.send(response);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableProjectEmailRequest }>(
    "/api/projects/:id/email",
    { schema: enableProjectEmailSchema },
    async (request, reply) => {
      try {
        const project = await app.deployService.getProject(request.params.id);
        if (!project) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const { domain, fromLocalPart, fromName, password, generatePassword, useExistingMailbox } = request.body;
        if (useExistingMailbox) {
          if (!fromLocalPart) {
            throw httpError(400, "invalid_request", "Escolha a caixa que o projeto vai usar.");
          }
          const { email, generatedPassword, passwordVerified } = await service.connectExistingMailbox(project, domain, fromLocalPart, {
            mode: useExistingMailbox,
            ...(password !== undefined ? { password } : {}),
            ...(fromName ? { fromName } : {}),
          });
          await app.auditService.record({
            action: "mail.project.mailbox.connect",
            target: project.slug,
            // nunca a senha: só a caixa e o caminho escolhido
            detail: `E-mail do projeto ligado à caixa existente ${email.mailbox} (${
              useExistingMailbox === "replace_password"
                ? "senha trocada por uma gerada pelo painel"
                : useExistingMailbox === "keep_password"
                  ? "senha guardada mantida"
                  : "senha atual informada"
            }).`,
          });
          const connected: ProjectEmailResponse = {
            email,
            ...(generatedPassword ? { generatedPassword } : {}),
            ...(passwordVerified !== undefined ? { passwordVerified } : {}),
          };
          syncWebmailInBackground();
          if (generatedPassword) reply.header("cache-control", "no-store");
          return reply.send(connected);
        }
        const { email, generatedPassword } = await service.enableProjectEmail(project, domain, {
          ...(fromLocalPart ? { fromLocalPart } : {}),
          ...(fromName ? { fromName } : {}),
          ...(password !== undefined ? { password } : {}),
          ...(generatePassword ? { generatePassword: true } : {}),
        });
        const response: ProjectEmailResponse = generatedPassword ? { email, generatedPassword } : { email };
        // nome de exibição novo: o webmail recebe (em segundo plano)
        syncWebmailInBackground();
        // A senha gerada aparece uma única vez: nada de cache no caminho.
        if (generatedPassword) reply.header("cache-control", "no-store");
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Caixas do domínio que o projeto pode usar como a do e-mail dele (nunca traz senha).
  app.get<{ Params: { id: string }; Querystring: { domain: string } }>(
    "/api/projects/:id/email/mailboxes",
    { schema: projectEmailMailboxesSchema },
    async (request, reply) => {
      try {
        const project = await app.deployService.getProject(request.params.id);
        if (!project) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const mailboxes = await service.listUsableMailboxes(project, request.query.domain);
        const response: ProjectEmailMailboxesResponse = { mailboxes };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Liga variáveis do app a valores do e-mail (guarda só o mapeamento; o
  // deploy entrega o valor atual).
  app.put<{ Params: { id: string }; Body: SetProjectEmailLinksRequest }>(
    "/api/projects/:id/email/links",
    { schema: projectEmailLinksSchema },
    async (request, reply) => {
      try {
        const project = await app.deployService.getProject(request.params.id);
        if (!project) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const email = await service.setProjectEmailLinks(project.id, request.body.links);
        await app.auditService.record({
          action: "mail.project.links",
          target: project.slug,
          // só os nomes: o valor (a senha, inclusive) nunca vai para a auditoria
          detail: `Variáveis ligadas ao e-mail do projeto: ${Object.keys(request.body.links).join(", ") || "nenhuma"}.`,
        });
        const response: ProjectEmailResponse = { email };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/email",
    { schema: projectIdParamSchema },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      }
      const email = await service.disableProjectEmail(project.id);
      syncWebmailInBackground();
      const response: ProjectEmailResponse = { email };
      return reply.send(response);
    },
  );
};

export default mailRoutes;
