/**
 * mail-diagnosis-routes.ts — diagnóstico de e-mail:
 *
 *  GET  /api/mail/envios/recusas                  tentativas recusadas antes da fila (todas; filtro por projeto)
 *  GET  /api/projects/:id/email/recusas           as deste projeto
 *  GET  /api/projects/:id/email/diagnostico       "por que nada chegou", última tentativa e avisos do Laravel
 *  POST /api/projects/:id/email/testar-conexao    testa a conexão e o login SMTP a partir do painel (não envia nada)
 *
 * As três de leitura só trazem tipo, hora, login e nomes de variáveis: nunca senha, IP ou valor de variável.
 * O teste de conexão usa a senha da caixa do projeto, então nenhum token de API o alcança (token-policy-table.ts)
 * e a rota tem limite de pedidos por minuto. Registradas dentro do plugin de e-mail (routes/mail.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MailProbeResult, MailRefusalsResponse, Project, ProjectMailDiagnosis } from "@paas/core";
import type { HttpError } from "../services/http-error.js";

export interface MailDiagnosisRouteDeps {
  refusals(query: { projectId?: string; limit?: number }): Promise<MailRefusalsResponse>;
  /** Pede a leitura do registro do Stalwart se a última tem mais de 1 min (não é esperada). */
  refresh?: () => Promise<unknown>;
  diagnose(project: Project): Promise<ProjectMailDiagnosis>;
  probe(project: Project, actor: string): Promise<MailProbeResult>;
}

const PROJECT_ID = { type: "string", minLength: 1, maxLength: 64 } as const;
const LIMIT = { type: "string", pattern: "^[1-9][0-9]{0,2}$" } as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) return reply.code(500).send({ error: "internal_error", message: "Erro interno." });
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

export function mailDiagnosisRoutes(app: FastifyInstance, deps: MailDiagnosisRouteDeps): void {
  const refresh = () => void deps.refresh?.().catch(() => undefined);
  const projectSchema = { params: { type: "object", required: ["id"], properties: { id: PROJECT_ID } } } as const;

  app.get<{ Querystring: { projectId?: string; limit?: string } }>(
    "/api/mail/envios/recusas",
    { schema: { querystring: { type: "object", additionalProperties: false, properties: { projectId: PROJECT_ID, limit: LIMIT } } } },
    async (request, reply) => {
      refresh();
      const { projectId, limit } = request.query;
      return reply.send(await deps.refusals({ ...(projectId ? { projectId } : {}), ...(limit ? { limit: Number(limit) } : {}) }));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/projects/:id/email/recusas",
    {
      schema: {
        params: projectSchema.params,
        querystring: { type: "object", additionalProperties: false, properties: { limit: LIMIT } },
      },
    },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      refresh();
      const { limit } = request.query;
      return reply.send(await deps.refusals({ projectId: project.id, ...(limit ? { limit: Number(limit) } : {}) }));
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/email/diagnostico", { schema: projectSchema }, async (request, reply) => {
    const project = await app.deployService.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
    refresh();
    return reply.send(await deps.diagnose(project));
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/email/testar-conexao",
    { schema: projectSchema, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      try {
        return reply.header("cache-control", "no-store").send(await deps.probe(project, request.session?.username ?? "operador"));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
