/**
 * access.ts — Segurança → Acesso: o que o painel faz pelo ACESSO à VPS.
 *  GET  /api/security/access                 chaves SSH do usuário de administração + estado
 *  POST /api/security/access/keys            adiciona uma chave pública
 *  POST /api/security/access/keys/remove     remove uma chave (nunca a última)
 *  POST /api/security/access/linux-password  troca a senha do usuário de administração no Linux
 *  GET  /api/security/access/bans            IPs bloqueados pelo fail2ban (sshd e recidive)
 *  POST /api/security/access/bans/unban      desbloqueia um IP
 *  POST /api/security/access/kit             dados do kit de recuperação (sem segredos)
 *
 * Toda escrita exige reautenticação: senha do painel + código do app (2FA ligado
 * é obrigatório) + (quando o usuário ligou) o código por e-mail. Só sessão humana:
 * nenhum token de API alcança estas rotas (services/token-policy-table.ts).
 *
 * O painel NÃO abre SSH por senha e NÃO mexe no firewall por aqui.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  EmailCodeAction,
  AddSshKeyRequest,
  RecoveryKitResponse,
  RemoveSshKeyRequest,
  SetLinuxPasswordRequest,
  UnbanRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { AccessService } from "../services/access-service.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    accessService: AccessService;
  }
}

const INSTALL_DIR = "/opt/tws-panel";

const credentials = {
  currentPassword: { type: "string", minLength: 1, maxLength: 512 },
  code: { type: "string", minLength: 1, maxLength: 64 },
  emailCode: { type: "string", minLength: 1, maxLength: 16 },
} as const;

const schemaWith = (extra: Record<string, unknown>, required: string[]) =>
  ({
    body: {
      type: "object",
      required: ["currentPassword", ...required],
      additionalProperties: false,
      properties: { ...credentials, ...extra },
    },
  }) as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode
      ? e.code === "host_failed"
        ? `${e.message} Se o código por e-mail estiver ligado, peça outro para tentar de novo: o anterior já foi usado.`
        : e.message
      : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const accessRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const logError = (err: unknown) => app.log.error({ err }, "acesso: falha inesperada");
  const strictFor = (action: EmailCodeAction) => ({ requireTwoFactor: true, emailCode: "if-enabled", action }) as const;

  app.get("/api/security/access", async (request, reply) => {
    try {
      const user = await app.userStore.findById(request.session!.userId);
      return reply.send(
        await app.accessService.status({
          twoFactorEnabled: Boolean(user?.twoFactor),
          emailCodeEnabled: Boolean(user?.emailCodeEnabledAt),
        }),
      );
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post<{ Body: AddSshKeyRequest }>(
    "/api/security/access/keys",
    { schema: schemaWith({ publicKey: { type: "string", minLength: 1, maxLength: 2100 } }, ["publicKey"]) },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, strictFor("access.keys"));
      if (!confirmed) return reply;
      try {
        const key = await app.accessService.addKey(request.body.publicKey, confirmed.user.username);
        await app.emailCode.alertAccessChange(confirmed.user, `chave SSH adicionada (${key.fingerprint}${key.comment ? `, ${key.comment}` : ""})`, request.ip);
        confirmed.attempt.success();
        return reply.send({ key, keys: await app.accessService.listKeys() });
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.post<{ Body: RemoveSshKeyRequest }>(
    "/api/security/access/keys/remove",
    { schema: schemaWith({ fingerprint: { type: "string", minLength: 8, maxLength: 80 } }, ["fingerprint"]) },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, strictFor("access.keys"));
      if (!confirmed) return reply;
      try {
        await app.accessService.removeKey(request.body.fingerprint, confirmed.user.username);
        await app.emailCode.alertAccessChange(confirmed.user, `chave SSH removida (${request.body.fingerprint})`, request.ip);
        confirmed.attempt.success();
        return reply.send({ keys: await app.accessService.listKeys() });
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.post<{ Body: SetLinuxPasswordRequest }>(
    "/api/security/access/linux-password",
    { schema: schemaWith({ newLinuxPassword: { type: "string", minLength: 1, maxLength: 200 } }, ["newLinuxPassword"]) },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, strictFor("access.password"));
      if (!confirmed) return reply;
      try {
        await app.accessService.setLinuxPassword(request.body.newLinuxPassword, confirmed.user.username);
        await app.emailCode.alertAccessChange(confirmed.user, "senha do usuário Linux de administração trocada", request.ip);
        confirmed.attempt.success();
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.get("/api/security/access/bans", async (request, reply) => {
    try {
      return reply.send({ ...(await app.accessService.bans()), yourIp: request.ip || null });
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post<{ Body: UnbanRequest }>(
    "/api/security/access/bans/unban",
    { schema: schemaWith({ ip: { type: "string", minLength: 2, maxLength: 45 } }, ["ip"]) },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, strictFor("access.unban"));
      if (!confirmed) return reply;
      try {
        await app.accessService.unban(request.body.ip, confirmed.user.username);
        await app.emailCode.alertAccessChange(confirmed.user, `IP ${request.body.ip} desbloqueado no fail2ban`, request.ip);
        confirmed.attempt.success();
        return reply.send({ ...(await app.accessService.bans()), yourIp: request.ip || null });
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.post<{ Body: { currentPassword: string; code?: string; emailCode?: string } }>(
    "/api/security/access/kit",
    { schema: schemaWith({}, []) },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, strictFor("access.kit"));
      if (!confirmed) return reply;
      try {
        const [keysResult, facts, panel] = await Promise.all([
          app.accessService.availability().available ? app.accessService.listKeys().catch(() => []) : Promise.resolve([]),
          app.accessService.sshFacts(),
          app.panelDomainService.facts(""),
        ]);
        const domainAddress = panel.domain && panel.active && panel.certificateValid ? panel.domain : null;
        const kit: RecoveryKitResponse = {
          generatedAt: new Date().toISOString(),
          panelAddress: domainAddress ?? panel.ipAddress ?? null,
          panelAddressIp: panel.ipAddress ?? null,
          linuxUser: app.accessService.availability().user,
          sshPort: facts.port,
          keys: keysResult,
          hostKeys: facts.hostKeys,
          recoveryCodesLeft: confirmed.user.twoFactor?.recoveryHashes.length ?? 0,
          emailCodeEnabled: Boolean(confirmed.user.emailCodeEnabledAt),
          installDir: INSTALL_DIR,
        };
        confirmed.attempt.success();
        await app.accessService.recordKit(confirmed.user.username);
        return reply.send(kit);
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );
};

export default accessRoutes;
