import type { FastifyPluginAsync } from "fastify";
import {
  SETUP_TOKEN_HEADER,
  SETUP_TOKEN_QUERY,
  type SetupStatusResponse,
  type VerifyTokenResponse,
} from "@paas/core";
import { tokenMatches } from "../services/setup-token.js";
import { SETUP_STEPS } from "../services/setup-state.js";

const setupRoutes: FastifyPluginAsync = async (app) => {
  // Público por natureza: valida o token informado no corpo.
  app.post<{ Body: { token?: string } }>("/api/setup/verify-token", async (request, reply) => {
    const token = request.body?.token;
    if (!app.setupToken) {
      return reply.code(503).send({
        error: "setup_token_missing",
        message: "Servidor sem setup token configurado.",
      });
    }
    const response: VerifyTokenResponse = {
      valid: typeof token === "string" && tokenMatches(token, app.setupToken),
    };
    return reply.send(response);
  });

  app.get("/api/setup/status", async (request, reply) => {
    const state = await app.setupState.load();
    const response: SetupStatusResponse = { state, steps: SETUP_STEPS };
    return reply.send(response);
  });

  // Avanço de passo do wizard (idempotente).
  app.post<{ Body: { step?: number } }>("/api/setup/advance", async (request, reply) => {
    const step = request.body?.step;
    const maxStep = Math.max(...SETUP_STEPS.map((s) => s.id));
    if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step > maxStep) {
      return reply.code(400).send({
        error: "invalid_step",
        message: `Passo inválido. Informe um inteiro entre 0 e ${maxStep}.`,
      });
    }
    const state = await app.setupState.setStep(step);
    const response: SetupStatusResponse = { state, steps: SETUP_STEPS };
    return reply.send(response);
  });

  // Referência aos nomes dos parâmetros aceitos (documentação viva).
  void SETUP_TOKEN_HEADER;
  void SETUP_TOKEN_QUERY;
};

export default setupRoutes;
