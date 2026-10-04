import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  CreateProjectRequest,
  DeployJobListResponse,
  DeployJobResponse,
  DeployRequest,
  DetectResponse,
  GuardrailReportResponse,
  Project,
  ProjectCredentialResponse,
  ProjectListResponse,
  ProjectResponse,
  SetPortRequest,
  SetProjectCredentialRequest,
  UpdateProjectRequest,
} from "@paas/core";
import { httpError, type HttpError } from "../services/deploy-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

// Schemas de validação. `additionalProperties: false` recusa campo desconhecido
// no corpo — impede que um cliente tente definir campos internos do projeto.
const INGEST_MODE = {
  type: "string",
  enum: ["git", "upload", "existing"],
} as const;

const createProjectSchema = {
  body: {
    type: "object",
    required: ["name", "ingestMode", "source", "domain"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      ingestMode: INGEST_MODE,
      source: { type: "string", minLength: 1, maxLength: 500 },
      branch: { type: "string", maxLength: 200 },
      domain: { type: "string", minLength: 1, maxLength: 253 },
      websocket: { type: "boolean" },
      proxyService: { type: ["string", "null"], maxLength: 100 },
      proxyPort: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
    },
  },
} as const;

// Params de projeto: o id é gerado pelo painel (hex de 16 chars). Validar o
// formato na borda evita que valor absurdo chegue às buscas e aos logs.
const projectIdParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const projectIdParamsSchema = { params: projectIdParams } as const;

const domainParams = {
  type: "object",
  required: ["id", "domain"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    domain: { type: "string", minLength: 1, maxLength: 253 },
  },
} as const;

const jobParamsSchema = {
  params: {
    type: "object",
    required: ["id", "jobId"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
      jobId: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

// deleteSource decide se o código-fonte é apagado do disco. Enum fechado: um
// valor ambíguo é recusado, nunca interpretado como false por omissão.
const deleteProjectSchema = {
  params: projectIdParams,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { deleteSource: { type: "string", enum: ["true", "false"] } },
  },
} as const;

// Corpo opcional: `POST /deploy` sem corpo é um deploy padrão (sem override),
// caso de uso legítimo de qualquer cliente de API — daí o "null" no type. Com
// corpo presente, o conteúdo é validado normalmente.
const deploySchema = {
  params: projectIdParams,
  body: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: { guardrailOverride: { type: "boolean" } },
  },
} as const;

const updateProjectSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  },
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      source: { type: "string", minLength: 1, maxLength: 500 },
      branch: { type: "string", maxLength: 200 },
      domain: { type: "string", minLength: 1, maxLength: 253 },
      websocket: { type: "boolean" },
      // Anuláveis: a UI envia null para limpar o override (NewProjectPage).
      proxyService: { type: ["string", "null"], maxLength: 100 },
      proxyPort: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
    },
  },
} as const;

// Credencial de LEITURA do repositório privado. O token entra por aqui e
// NUNCA volta: as respostas só dizem que existe e mostram os 4 últimos
// caracteres. `additionalProperties: false` impede um cliente de tentar
// pedir escopo/permissão extra — o painel só lê repositórios.
const setCredentialSchema = {
  params: projectIdParams,
  body: {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1, maxLength: 500 },
      username: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

// Troca da porta do SERVIDOR (modal Portas). Só 1024–65535 (abaixo é do
// sistema; 80/443 são do painel) e só os dois endereços que o painel oferece:
// 127.0.0.1 (só no servidor) ou 0.0.0.0 (todos). A porta interna não entra.
const setPortSchema = {
  params: projectIdParams,
  body: {
    type: "object",
    required: ["service", "original", "action"],
    additionalProperties: false,
    properties: {
      service: { type: "string", minLength: 1, maxLength: 100 },
      original: { type: "string", minLength: 1, maxLength: 200 },
      action: { type: "string", enum: ["change", "remove", "reset"] },
      hostPort: { type: "integer", minimum: 1024, maximum: 65535 },
      hostIp: { type: "string", enum: ["127.0.0.1", "0.0.0.0"] },
    },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
    // relatório de guardrails quando o deploy é bloqueado (Fase 4)
    ...(e.report ? { report: e.report } : {}),
    ...(e.missing ? { missing: e.missing } : {}),
  });
}

/**
 * Falha de gravação do cofre (ver persist() em services/credential-vault.ts).
 * A mensagem genérica do store não diz o que ficou valendo — cada rota troca
 * pela do contexto, sem detalhe do sistema de arquivos.
 */
function isStorageWriteFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "storage_write_failed";
}

const projectsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  // DeployService compartilhado (decorado no escopo raiz em app.ts).
  const service = app.deployService;

  /**
   * Monta a resposta de um projeto. Centralizado de propósito: a informação de
   * credencial é sempre a versão pública (existe? dica?), nunca o valor — e um
   * único lugar de montagem é o que garante isso em TODAS as rotas.
   */
  async function projectResponse(
    project: Project,
    containers?: Awaited<ReturnType<typeof service.listContainers>>,
  ): Promise<ProjectResponse> {
    const { status, containers: mine } = await service.statusOf(project, containers);
    return {
      project,
      status,
      containers: mine,
      url: service.projectUrl(project),
      credential: await service.credentialInfo(project),
    };
  }

  // Lista projetos + status calculado a partir dos containers.
  app.get("/api/projects", async (_request, reply) => {
    const containers = await service.listContainers();
    const projects = await service.listProjects();
    const responses: ProjectResponse[] = [];
    for (const project of projects) {
      responses.push(await projectResponse(project, containers));
    }
    const response: ProjectListResponse = { projects: responses };
    return reply.send(response);
  });

  // Cria projeto.
  app.post<{ Body: CreateProjectRequest }>(
    "/api/projects",
    { schema: createProjectSchema },
    async (request, reply) => {
      try {
        const project = await service.createProject(
          request.body ?? ({} as CreateProjectRequest),
        );
        return reply.code(201).send(await projectResponse(project));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Detalhe de um projeto.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) {
        return reply
          .code(404)
          .send({
            error: "project_not_found",
            message: "Projeto não encontrado.",
          });
      }
      return reply.send(await projectResponse(project));
    },
  );

  // Seção Variáveis: variáveis de ambiente do projeto (valem no próximo deploy).
  app.get<{ Params: { id: string } }>("/api/projects/:id/env", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      const [vars, compose, provided, providedValues, links, example] = await Promise.all([
        service.getEnv(request.params.id),
        service.composeVariablesFor(request.params.id),
        service.providedEnvKeys(request.params.id),
        // valores do que o painel fornece, para o olho da tela — sem a senha da caixa
        service.providedEnvValues(request.params.id),
        // ligadas ao e-mail (SMTP_SENHA ← SMTP_PASS) e nomes do .env.example: só nomes
        service.envLinkSources(request.params.id),
        service.envExampleFor(request.params.id),
      ]);
      return reply.send({ vars, compose, provided, providedValues, links, example });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { vars: Array<{ key: string; value: string }> } }>(
    "/api/projects/:id/env",
    {
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["vars"],
          additionalProperties: false,
          properties: {
            vars: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                required: ["key", "value"],
                additionalProperties: false,
                properties: {
                  key: { type: "string", minLength: 1, maxLength: 128 },
                  value: { type: "string", maxLength: 32768 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({ vars: await service.setEnv(request.params.id, request.body.vars) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Seção Git: o repositório é público? (esconde o bloco de token quando é)
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/repo-visibility",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      const visibility = project.ingestMode === "git" ? await service.github.repoVisibility(project.source) : "unknown";
      return reply.send({ visibility });
    },
  );

  // Visão geral: o certificado HTTPS de cada domínio está válido? (quem emitiu, até quando)
  app.get<{ Params: { id: string } }>("/api/projects/:id/https", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      return reply.send({ domains: await service.httpsStatus(request.params.id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Domínios do projeto: o principal + quantos adicionais o operador quiser.
  // Publicado, a mudança vale na hora (Caddy recarregado pelo serviço).
  app.post<{ Params: { id: string }; Body: { domain: string } }>(
    "/api/projects/:id/domains",
    {
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["domain"],
          additionalProperties: false,
          properties: { domain: { type: "string", minLength: 1, maxLength: 253 } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await projectResponse(await service.addDomain(request.params.id, request.body.domain)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; domain: string } }>(
    "/api/projects/:id/domains/:domain",
    { schema: { params: domainParams } },
    async (request, reply) => {
      try {
        return reply.send(await projectResponse(await service.removeDomain(request.params.id, request.params.domain)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string; domain: string }; Body: { port: number | null } }>(
    "/api/projects/:id/domains/:domain/port",
    {
      schema: {
        params: domainParams,
        body: {
          type: "object",
          required: ["port"],
          additionalProperties: false,
          properties: { port: { type: ["integer", "null"], minimum: 1, maximum: 65535 } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await projectResponse(await service.setDomainPort(request.params.id, request.params.domain, request.body.port)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; domain: string } }>(
    "/api/projects/:id/domains/:domain/primary",
    { schema: { params: domainParams } },
    async (request, reply) => {
      try {
        return reply.send(
          await projectResponse(await service.setPrimaryDomain(request.params.id, request.params.domain)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Portas (modal "Portas"): somente leitura, sem segredos — o que está no ar
  // (docker ps, uma listagem por consulta) e o que cada projeto vai publicar.
  app.get("/api/ports", async (_request, reply) => {
    try {
      return reply.send(await service.portsOverview());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/ports", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      return reply.send(await service.projectPorts(request.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Troca a porta do servidor (vale no próximo deploy; registrada na auditoria).
  app.put<{ Params: { id: string }; Body: SetPortRequest }>(
    "/api/projects/:id/ports",
    { schema: setPortSchema },
    async (request, reply) => {
      try {
        return reply.send(await service.setPort(request.params.id, request.body));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Atualiza domínio/flags antes do próximo deploy.
  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    "/api/projects/:id",
    { schema: updateProjectSchema },
    async (request, reply) => {
      try {
        const project = await service.updateProject(
          request.params.id,
          request.body ?? {},
        );
        return reply.send(await projectResponse(project));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Define/substitui a credencial de LEITURA do repositório privado.
  //
  // O corpo carrega o token, mas a resposta e a auditoria carregam apenas o
  // FATO: existe uma credencial, cadastrada agora, terminada em XXXX. O valor
  // vive só no cofre cifrado (services/credential-vault.ts) e no ambiente do
  // processo git durante o clone.
  app.put<{ Params: { id: string }; Body: SetProjectCredentialRequest }>(
    "/api/projects/:id/credential",
    { schema: setCredentialSchema },
    async (request, reply) => {
      try {
        const credential = await service.setCredential(request.params.id, request.body);
        await app.auditService.record({
          action: "project.credential.set",
          target: request.params.id,
          detail:
            `Credencial de LEITURA do repositório definida (usuário "${credential.username ?? "-"}", ` +
            `token terminado em ${credential.hint ?? "????"}). O valor não é registrado.`,
        });
        const response: ProjectCredentialResponse = { credential };
        return reply.send(response);
      } catch (err) {
        if (isStorageWriteFailure(err)) {
          request.log.error({ err }, "falha ao gravar a credencial no cofre");
          return sendError(reply, {
            statusCode: 500,
            code: "storage_write_failed",
            message:
              "Não foi possível salvar a credencial no servidor. Nada foi alterado: a credencial " +
              "anterior (se havia uma) continua valendo.",
          });
        }
        return sendError(reply, err);
      }
    },
  );

  // Remove a credencial de leitura do projeto.
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/credential",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const havia = await service.removeCredential(request.params.id);
        await app.auditService.record({
          action: "project.credential.remove",
          target: request.params.id,
          detail: havia
            ? "Credencial de LEITURA do repositório removida do cofre."
            : "Remoção de credencial solicitada, mas o projeto não tinha nenhuma cadastrada.",
        });
        return reply.send({
          ok: true,
          credential: { configured: false, hint: null, username: null, updatedAt: null },
        });
      } catch (err) {
        if (isStorageWriteFailure(err)) {
          request.log.error({ err }, "falha ao gravar a remoção da credencial no cofre");
          return sendError(reply, {
            statusCode: 500,
            code: "storage_write_failed",
            message:
              "Não foi possível remover a credencial no servidor. Nada foi alterado: a credencial " +
              "continua cadastrada.",
          });
        }
        return sendError(reply, err);
      }
    },
  );

  // Detecção automática de tipo + guardrails.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/detect",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const detection = await service.detect(request.params.id);
        const response: DetectResponse = { detection };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Relatório de guardrails sob demanda (Fase 4) — exibido antes do deploy.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/guardrails",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const { report, note } = await service.guardrailsForProject(
          request.params.id,
        );
        const response: GuardrailReportResponse = { report, note };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Inicia deploy (job assíncrono). Body opcional: { guardrailOverride: true }
  // para confirmar explicitamente o override de bloqueios de guardrail (Fase 4).
  app.post<{ Params: { id: string }; Body: DeployRequest }>(
    "/api/projects/:id/deploy",
    { schema: deploySchema },
    async (request, reply) => {
      try {
        const job = await service.startDeploy(request.params.id, {
          guardrailOverride: request.body?.guardrailOverride === true,
        });
        const response: DeployJobResponse = { job };
        return reply.code(202).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Status + log de um job de deploy.
  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/projects/:id/jobs/:jobId",
    { schema: jobParamsSchema },
    async (request, reply) => {
      const job = await service.getJob(request.params.id, request.params.jobId);
      if (!job) {
        return reply
          .code(404)
          .send({ error: "job_not_found", message: "Job não encontrado." });
      }
      const response: DeployJobResponse = { job };
      return reply.send(response);
    },
  );

  // Histórico de deploys do projeto. Mesmo contrato 404 das demais rotas
  // :id — sem isso, projeto inexistente devolvia 200 com lista vazia,
  // indistinguível de "projeto existe mas nunca teve deploy".
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/jobs",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) {
        return reply
          .code(404)
          .send({
            error: "project_not_found",
            message: "Projeto não encontrado.",
          });
      }
      const jobs = await service.listJobs(request.params.id);
      const response: DeployJobListResponse = { jobs };
      return reply.send(response);
    },
  );

  // Para a stack do projeto.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/stop",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const log: string[] = [];
      try {
        await service.stop(request.params.id, (chunk) => log.push(chunk));
        return reply.send({ ok: true, log: log.join("") });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Sobe a stack do projeto.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/start",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const log: string[] = [];
      try {
        await service.start(request.params.id, (chunk) => log.push(chunk));
        return reply.send({ ok: true, log: log.join("") });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Remove projeto (containers + domínio; código opcional via ?deleteSource=true).
  app.delete<{
    Params: { id: string };
    Querystring: { deleteSource?: string };
  }>("/api/projects/:id", { schema: deleteProjectSchema }, async (request, reply) => {
    const log: string[] = [];
    try {
      await service.deleteProject(
        request.params.id,
        request.query.deleteSource === "true",
        (chunk) => log.push(chunk),
      );
      return reply.send({ ok: true, log: log.join("") });
    } catch (err) {
      return sendError(reply, err);
    }
  });
};

export default projectsRoutes;
