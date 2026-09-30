/**
 * settings.ts — Configurações do painel.
 *  PUT /api/settings/preferences  (sessão) — preferências de interface da conta
 *
 * As preferências também chegam em GET /api/auth/me, junto com a sessão: o
 * painel é desenhado já no formato escolhido.
 */
import type { FastifyPluginAsync } from "fastify";
import {
  DEFAULT_USER_PREFERENCES,
  NAV_LAYOUTS,
  type UpdatePreferencesRequest,
  type UpdatePreferencesResponse,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";

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
};

export default settingsRoutes;
