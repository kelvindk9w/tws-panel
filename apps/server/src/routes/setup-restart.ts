/**
 * setup-restart.ts — "Recomeçar do zero" pelo painel (Setup concluído).
 *  POST /api/settings/restart-setup  (sessão + senha atual + "recomeçar" + código do 2FA)
 *
 * Mesmo efeito de `scripts/reset-setup.sh --full`: apaga a conta, as sessões e
 * o progresso do assistente. Projetos, domínios, e-mail e histórico de
 * segurança ficam. Gera um token de setup NOVO (o antigo deixa de valer) e
 * devolve o link para continuar direto no assistente.
 *
 * Confirmação forte, pedida pelo dono do produto: senha atual, digitar
 * "recomeçar" e o código da verificação em duas etapas. Sem 2FA ativo o painel
 * não tem um segundo fator para confirmar que é você (envio de e-mail ainda
 * não existe): recusa e aponta o script na VPS.
 *
 * Registrado com fastify-plugin: o token novo precisa trocar o valor GLOBAL
 * (app.setupToken), que o plugin de auth e as rotas de setup leem.
 */
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { SESSION_COOKIE } from "@paas/core";
import { verifyPasswordTimingSafe } from "../services/password.js";

export const RESTART_CONFIRMATION = "recomeçar";

interface RestartBody {
  currentPassword: string;
  confirm: string;
  code?: string;
}

const restartSchema = {
  body: {
    type: "object",
    required: ["currentPassword", "confirm"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      confirm: { type: "string", maxLength: 40 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const setupRestartRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RestartBody }>("/api/settings/restart-setup", { schema: restartSchema }, async (request, reply) => {
    const session = request.session!;
    const user = await app.userStore.findById(session.userId);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });

    if (request.body.confirm.trim().toLowerCase() !== RESTART_CONFIRMATION) {
      return reply.code(400).send({ error: "confirmation_mismatch", message: `Digite "${RESTART_CONFIRMATION}" para confirmar.` });
    }
    if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
      return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
    }
    if (!user.twoFactor) {
      return reply.code(409).send({
        error: "two_factor_required",
        message:
          "Para recomeçar pelo painel, ative antes a verificação em duas etapas (Configurações → Segurança): é ela " +
          "que confirma que é você. O envio de código por e-mail ainda não existe no painel. Sem ela, o caminho é " +
          "pela VPS: sudo ./scripts/reset-setup.sh --full",
      });
    }
    const check = request.body.code ? await app.twoFactor.verify(user, request.body.code) : null;
    if (!check) {
      return reply.code(400).send({
        error: "invalid_two_factor_code",
        message: "Código incorreto ou já usado. Digite o código que aparece agora no app.",
      });
    }

    // Auditoria ANTES de apagar: ela fica num arquivo próprio, que continua.
    await app.auditService.record({
      actor: user.username,
      action: "setup.restarted",
      detail:
        "Assistente de configuração recomeçado pelo painel (senha + verificação em duas etapas): conta, sessões e " +
        "progresso apagados; token de setup novo gerado. Projetos mantidos.",
    });

    const token = randomBytes(24).toString("base64url");
    await writeFile(app.config.setupTokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(app.config.setupTokenFile, 0o600).catch(() => undefined);
    app.setupToken = token;

    await app.sessionStore.destroyAll();
    await app.userStore.removeAll();
    await app.setupState.reset();

    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ setupUrl: `/setup?token=${encodeURIComponent(token)}` });
  });
};

export default fp(setupRestartRoutes, { name: "setup-restart" });
