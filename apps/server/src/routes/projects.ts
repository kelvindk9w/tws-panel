import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  CreateProjectRequest,
  DeployJobListResponse,
  DeployJobResponse,
  DeployRequest,
  DetectResponse,
  GuardrailReportResponse,
  ProjectListResponse,
  ProjectResponse,
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

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
    // relatório de guardrails quando o deploy é bloqueado (Fase 4)
    ...(e.report ? { report: e.report } : {}),
  });
}

const projectsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  // DeployService compartilhado (decorado no escopo raiz em app.ts).
  const service = app.deployService;

  // Lista projetos + status calculado a partir dos containers.
  app.get("/api/projects", async (_request, reply) => {
    const containers = await service.listContainers();
    const projects = await service.listProjects();
    const responses: ProjectResponse[] = [];
    for (const project of projects) {
      const { status, containers: mine } = await service.statusOf(
        project,
        containers,
      );
      responses.push({
        project,
        status,
        containers: mine,
        url: service.projectUrl(project),
      });
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
        const { status, containers } = await service.statusOf(project);
        const response: ProjectResponse = {
          project,
          status,
          containers,
          url: service.projectUrl(project),
        };
        return reply.code(201).send(response);
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
      const { status, containers } = await service.statusOf(project);
      const response: ProjectResponse = {
        project,
        status,
        containers,
        url: service.projectUrl(project),
      };
      return reply.send(response);
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
        const { status, containers } = await service.statusOf(project);
        const response: ProjectResponse = {
          project,
          status,
          containers,
          url: service.projectUrl(project),
        };
        return reply.send(response);
      } catch (err) {
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
