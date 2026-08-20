import type { FastifyPluginAsync } from "fastify";
import {
  SETUP_TOKEN_HEADER,
  SETUP_TOKEN_QUERY,
  passwordStrengthErrors,
  validateUsername,
  type CreateAdminRequest,
  type CreateAdminResponse,
  type SetupStatusResponse,
  type VerifyTokenResponse,
} from "@paas/core";
import { tokenMatches } from "../services/setup-token.js";
import { hashPassword } from "../services/password.js";
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

  /**
   * Passo 4 do wizard: cria a ÚNICA conta admin e conclui o setup.
   * A partir daqui o plugin de auth trava as rotas /api/setup/* (403) e o
   * setup token perde a validade — todo acesso passa a exigir sessão.
   */
  app.post<{ Body: CreateAdminRequest }>("/api/setup/admin", async (request, reply) => {
    if (await app.userStore.hasAdmin()) {
      return reply.code(409).send({
        error: "admin_exists",
        message: "A conta de administrador já foi criada. Entre pela tela de login.",
      });
    }

    const { username, password } = request.body ?? {};
    if (typeof username !== "string" || !validateUsername(username)) {
      return reply.code(400).send({
        error: "invalid_username",
        message:
          "Usuário inválido: 3 a 32 caracteres, começando com letra ou número (letras, números, '_', '.', '-').",
      });
    }
    if (typeof password !== "string") {
      return reply.code(400).send({ error: "invalid_payload", message: "Informe a senha." });
    }
    const errors = passwordStrengthErrors(password);
    if (errors.length > 0) {
      return reply.code(400).send({
        error: "weak_password",
        message: `Senha fraca: ${errors.join(", ")}.`,
      });
    }

    let user;
    try {
      user = await app.userStore.create(username, await hashPassword(password));
    } catch {
      // corrida: outra requisição criou o admin entre a checagem e a criação
      return reply.code(409).send({
        error: "admin_exists",
        message: "A conta de administrador já foi criada. Entre pela tela de login.",
      });
    }

    await app.setupState.complete();
    await app.auditService.record({
      actor: user.username,
      action: "setup.admin_created",
      detail: "Conta de administrador criada; setup concluído e setup token invalidado.",
    });

    const response: CreateAdminResponse = {
      ok: true,
      user: { username: user.username, createdAt: user.createdAt },
    };
    return reply.code(201).send(response);
  });

  // Referência aos nomes dos parâmetros aceitos (documentação viva).
  void SETUP_TOKEN_HEADER;
  void SETUP_TOKEN_QUERY;
};

export default setupRoutes;
