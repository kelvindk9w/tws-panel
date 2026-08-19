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
  // DeployService compartilhado (decorado no escopo raiz em app.ts).
  const service = app.deployService;

  // Lista projetos + status calculado a partir dos containers.
  app.get("/api/projects", async (_request, reply) => {
    const containers = await service.listContainers();
    const projects = await service.listProjects();
    const responses: ProjectResponse[] = [];
    for (const project of projects) {
      const { status, containers: mine } = await service.statusOf(project, containers);
      responses.push({ project, status, containers: mine, url: service.projectUrl(project) });
    }
    const response: ProjectListResponse = { projects: responses };
    return reply.send(response);
  });

  // Cria projeto.
  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (request, reply) => {
    try {
      const project = await service.createProject(request.body ?? ({} as CreateProjectRequest));
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
  });

  // Detalhe de um projeto.
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = await service.getProject(request.params.id);
    if (!project) {
      return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
    }
    const { status, containers } = await service.statusOf(project);
    const response: ProjectResponse = {
      project,
      status,
      containers,
      url: service.projectUrl(project),
    };
    return reply.send(response);
  });

  // Atualiza domínio/flags antes do próximo deploy.
  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    "/api/projects/:id",
    async (request, reply) => {
      try {
        const project = await service.updateProject(request.params.id, request.body ?? {});
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
  app.post<{ Params: { id: string } }>("/api/projects/:id/detect", async (request, reply) => {
    try {
      const detection = await service.detect(request.params.id);
      const response: DetectResponse = { detection };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Relatório de guardrails sob demanda (Fase 4) — exibido antes do deploy.
  app.get<{ Params: { id: string } }>("/api/projects/:id/guardrails", async (request, reply) => {
    try {
      const { report, note } = await service.guardrailsForProject(request.params.id);
      const response: GuardrailReportResponse = { report, note };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Inicia deploy (job assíncrono). Body opcional: { guardrailOverride: true }
  // para confirmar explicitamente o override de bloqueios de guardrail (Fase 4).
  app.post<{ Params: { id: string }; Body: DeployRequest }>(
    "/api/projects/:id/deploy",
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
    async (request, reply) => {
      const job = await service.getJob(request.params.id, request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: "job_not_found", message: "Job não encontrado." });
      }
      const response: DeployJobResponse = { job };
      return reply.send(response);
    },
  );

  // Histórico de deploys do projeto.
  app.get<{ Params: { id: string } }>("/api/projects/:id/jobs", async (request, reply) => {
    const jobs = await service.listJobs(request.params.id);
    const response: DeployJobListResponse = { jobs };
    return reply.send(response);
  });

  // Para a stack do projeto.
  app.post<{ Params: { id: string } }>("/api/projects/:id/stop", async (request, reply) => {
    const log: string[] = [];
    try {
      await service.stop(request.params.id, (chunk) => log.push(chunk));
      return reply.send({ ok: true, log: log.join("") });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Sobe a stack do projeto.
  app.post<{ Params: { id: string } }>("/api/projects/:id/start", async (request, reply) => {
    const log: string[] = [];
    try {
      await service.start(request.params.id, (chunk) => log.push(chunk));
      return reply.send({ ok: true, log: log.join("") });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Remove projeto (containers + domínio; código opcional via ?deleteSource=true).
  app.delete<{ Params: { id: string }; Querystring: { deleteSource?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
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
    },
  );
};

export default projectsRoutes;
