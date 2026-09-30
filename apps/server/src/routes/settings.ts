/**
 * settings.ts — Configurações do painel.
 *  PUT /api/settings/preferences  (sessão) — preferências de interface da conta
 *  PUT /api/settings/profile      (sessão) — nome de exibição, e-mail e usuário
 *                                  de login (este exige a senha atual)
 *
 * As preferências também chegam em GET /api/auth/me, junto com a sessão: o
 * painel é desenhado já no formato escolhido.
 */
import type { FastifyPluginAsync } from "fastify";
import {
  DEFAULT_USER_PREFERENCES,
  DISPLAY_NAME_MAX_LENGTH,
  NAV_LAYOUTS,
  USERNAME_MAX_LENGTH,
  validateEmail,
  validateUsername,
  type UpdateProfileRequest,
  type UpdateProfileResponse,
  type UpdatePreferencesRequest,
  type UpdatePreferencesResponse,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { verifyPasswordTimingSafe } from "../services/password.js";
import { publicUser } from "../services/public-user.js";

const preferencesSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      navLayout: { type: "string", enum: [...NAV_LAYOUTS] },
    },
  },
} as const;

const profileSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      displayName: { type: "string", maxLength: DISPLAY_NAME_MAX_LENGTH },
      email: { type: "string", maxLength: 254 },
      username: { type: "string", minLength: 1, maxLength: USERNAME_MAX_LENGTH },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

/** Texto vazio (ou só espaços) apaga o campo. */
function optionalText(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const settingsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  app.put<{ Body: UpdatePreferencesRequest }>(
    "/api/settings/preferences",
    { schema: preferencesSchema },
    async (request, reply) => {
      const session = request.session!;
      const user = await app.userStore.updatePreferences(session.userId, request.body);
      if (!user) {
        await app.sessionStore.destroy(session.id);
        return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
      }
      const response: UpdatePreferencesResponse = {
        preferences: { ...DEFAULT_USER_PREFERENCES, ...user.preferences },
      };
      return reply.send(response);
    },
  );

  app.put<{ Body: UpdateProfileRequest }>(
    "/api/settings/profile",
    { schema: profileSchema },
    async (request, reply) => {
      const session = request.session!;
      const user = await app.userStore.findById(session.userId);
      if (!user) {
        await app.sessionStore.destroy(session.id);
        return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
      }
      const displayName = optionalText(request.body.displayName);
      const email = optionalText(request.body.email);
      if (email && !validateEmail(email)) {
        return reply.code(400).send({ error: "invalid_email", message: "E-mail inválido. Use o formato nome@dominio.com." });
      }
      const wanted = request.body.username?.trim();
      const usernameChanges = wanted !== undefined && wanted !== user.username;
      if (usernameChanges) {
        if (!validateUsername(wanted)) {
          return reply.code(400).send({
            error: "invalid_username",
            message: "Usuário inválido: de 3 a 32 caracteres, letras, números, ponto, hífen ou sublinhado, sem espaços.",
          });
        }
        // Trocar o que se digita no login é tão sensível quanto trocar a senha.
        if (!request.body.currentPassword) {
          return reply.code(400).send({
            error: "current_password_required",
            message: "Para trocar o usuário de login, confirme com a sua senha atual.",
          });
        }
        if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
          return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
        }
      }
      let updated;
      try {
        updated = await app.userStore.updateProfile(user.id, {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(usernameChanges ? { username: wanted } : {}),
        });
      } catch (err) {
        if ((err as Error).message === "username_taken") {
          return reply.code(409).send({ error: "username_taken", message: "Esse usuário já existe." });
        }
        throw err;
      }
      if (!updated) {
        return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
      }
      if (usernameChanges) {
        await app.auditService.record({
          actor: updated.username,
          action: "auth.username_changed",
          detail: `Usuário de login alterado de "${user.username}" para "${updated.username}".`,
        });
      } else {
        await app.auditService.record({
          actor: updated.username,
          action: "settings.profile_updated",
          detail: "Perfil atualizado (nome de exibição ou e-mail).",
        });
      }
      const response: UpdateProfileResponse = { user: publicUser(updated) };
      return reply.send(response);
    },
  );
};

export default settingsRoutes;
