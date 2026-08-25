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
import { registerErrorHandler } from "../plugins/error-handler.js";

// Passo máximo válido do wizard (usado no schema de /api/setup/advance).
const MAX_STEP = Math.max(...SETUP_STEPS.map((s) => s.id));

// Schemas de validação. `additionalProperties: false` recusa campo
// desconhecido no corpo. `maxLength` em toda string é defesa contra payload
// gigante — nunca menor que 200 na senha, para não recusar senha legítima.
//
// verify-token é público e tolera corpo sem `token` (a regra de negócio
// responde `valid: false`, não erro) — por isso `token` não é obrigatório
// aqui; o schema só garante que, quando presente, é string dentro do limite.
const verifyTokenSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      token: { type: "string", maxLength: 500 },
    },
  },
} as const;

const advanceSchema = {
  body: {
    type: "object",
    required: ["step"],
    additionalProperties: false,
    properties: {
      step: { type: "integer", minimum: 0, maximum: MAX_STEP },
    },
  },
} as const;

const createAdminSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    additionalProperties: false,
    properties: {
      username: { type: "string", minLength: 1, maxLength: 100 },
      password: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

const setupRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  // Público por natureza: valida o token informado no corpo.
  app.post<{ Body: { token?: string } }>(
    "/api/setup/verify-token",
    { schema: verifyTokenSchema },
    async (request, reply) => {
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
    },
  );

  app.get("/api/setup/status", async (request, reply) => {
    const state = await app.setupState.load();
    const response: SetupStatusResponse = { state, steps: SETUP_STEPS };
    return reply.send(response);
  });

  // Avanço de passo do wizard (idempotente).
  app.post<{ Body: { step?: number } }>(
    "/api/setup/advance",
    { schema: advanceSchema },
    async (request, reply) => {
    const step = request.body?.step;
    if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step > MAX_STEP) {
      return reply.code(400).send({
        error: "invalid_step",
        message: `Passo inválido. Informe um inteiro entre 0 e ${MAX_STEP}.`,
      });
    }
    const current = await app.setupState.load();
    // Idempotente para o mesmo passo (o wizard reenvia o passo atual sem
    // problema), mas NUNCA retrocede o estado persistido: o "voltar" do
    // frontend (goTo) é navegação local, não chama este endpoint — se um
    // step menor chegar aqui é payload adulterado ou corrida, não fluxo
    // legítimo do wizard.
    if (step < current.currentStep) {
      return reply.code(400).send({
        error: "step_regression",
        message: `O setup já avançou até o passo ${current.currentStep}; não é possível retroceder para ${step}.`,
      });
    }
    const state = await app.setupState.setStep(step);
    const response: SetupStatusResponse = { state, steps: SETUP_STEPS };
    return reply.send(response);
    },
  );

  /**
   * Passo 4 do wizard: cria a ÚNICA conta admin e conclui o setup.
   * A partir daqui o plugin de auth trava as rotas /api/setup/* (403) e o
   * setup token perde a validade — todo acesso passa a exigir sessão.
   */
  app.post<{ Body: CreateAdminRequest }>(
    "/api/setup/admin",
    { schema: createAdminSchema },
    async (request, reply) => {
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
    },
  );

  // Referência aos nomes dos parâmetros aceitos (documentação viva).
  void SETUP_TOKEN_HEADER;
  void SETUP_TOKEN_QUERY;
};

export default setupRoutes;
