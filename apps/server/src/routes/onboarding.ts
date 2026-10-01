/**
 * onboarding.ts — roteiro "Deixe o painel pronto" do Dashboard.
 *  GET  /api/onboarding             (sessão) — status real de cada passo + progresso da conta
 *  POST /api/onboarding/start       (sessão) — a pessoa começou o roteiro (deixa de abrir expandido)
 *  PUT  /api/onboarding/steps/:id   (sessão) — "Não vou usar" / desfazer, só em passo opcional
 *
 * As conferências chegam pelas opções do plugin (app.ts liga as fontes reais;
 * os testes injetam conferências falsas, sem Docker). O progresso fica na
 * conta, em data/users.json, ao lado das preferências.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  OPTIONAL_ONBOARDING_STEPS,
  type OnboardingResponse,
  type OnboardingSkipRequest,
  type OnboardingStepId,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { buildOnboardingResponse, type OnboardingChecks } from "../services/onboarding.js";
import type { StoredUser } from "../services/user-store.js";

export interface OnboardingRoutesOptions {
  checks: OnboardingChecks;
}

const skipSchema = {
  params: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string", enum: [...OPTIONAL_ONBOARDING_STEPS] } },
  },
  body: {
    type: "object",
    required: ["skipped"],
    additionalProperties: false,
    properties: { skipped: { type: "boolean" } },
  },
} as const;

const onboardingRoutes: FastifyPluginAsync<OnboardingRoutesOptions> = async (app, opts) => {
  registerErrorHandler(app);
  const { checks } = opts;

  async function respond(user: StoredUser, reply: FastifyReply): Promise<FastifyReply> {
    const response: OnboardingResponse = await buildOnboardingResponse(
      checks,
      { userId: user.id },
      user.onboarding,
      app.config.projectsDir,
    );
    return reply.send(response);
  }

  async function unauthorized(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    await app.sessionStore.destroy(request.session!.id);
    return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
  }

  app.get("/api/onboarding", async (request, reply) => {
    const user = await app.userStore.findById(request.session!.userId);
    if (!user) return unauthorized(request, reply);
    return respond(user, reply);
  });

  app.post("/api/onboarding/start", async (request, reply) => {
    const user = await app.userStore.updateOnboarding(request.session!.userId, (current) => ({
      ...current,
      startedAt: current.startedAt ?? new Date().toISOString(),
    }));
    if (!user) return unauthorized(request, reply);
    return respond(user, reply);
  });

  app.put<{ Params: { id: OnboardingStepId }; Body: OnboardingSkipRequest }>(
    "/api/onboarding/steps/:id",
    { schema: skipSchema },
    async (request, reply) => {
      const { id } = request.params;
      const { skipped } = request.body;
      const user = await app.userStore.updateOnboarding(request.session!.userId, (current) => ({
        // Escolher "Não vou usar" também conta como ter começado o roteiro.
        startedAt: current.startedAt ?? new Date().toISOString(),
        skipped: skipped
          ? [...current.skipped.filter((s) => s !== id), id]
          : current.skipped.filter((s) => s !== id),
      }));
      if (!user) return unauthorized(request, reply);
      await app.auditService.record({
        actor: user.username,
        action: skipped ? "settings.onboarding_step_skipped" : "settings.onboarding_step_unskipped",
        target: id,
        detail: skipped
          ? `Roteiro de primeiros passos: "${id}" marcado como "Não vou usar".`
          : `Roteiro de primeiros passos: "${id}" voltou a ser considerado.`,
      });
      return respond(user, reply);
    },
  );
};

export default onboardingRoutes;
