/**
 * mail-test.ts (rotas) — caixa de teste de e-mail do projeto (Mailpit).
 *
 *  GET    /api/projects/:id/mail-test                           estado (ligada?, container, contagem, variáveis redirecionadas)
 *  PUT    /api/projects/:id/mail-test                           liga, altera a retenção ou desliga
 *  GET    /api/projects/:id/mail-test/messages                  lista
 *  GET    /api/projects/:id/mail-test/messages/:mid             uma mensagem (texto, cabeçalhos, anexos, links)
 *  GET    /api/projects/:id/mail-test/messages/:mid/html        o HTML, para o iframe (CSP + sandbox)
 *  GET    /api/projects/:id/mail-test/messages/:mid/parts/:part anexo ou imagem embutida
 *  DELETE /api/projects/:id/mail-test/messages/:mid             apaga uma
 *  DELETE /api/projects/:id/mail-test/messages                  esvazia
 *
 * O painel é o único caminho até o Mailpit (proxy autenticado pela sessão; a interface dele nunca é
 * publicada). Token de API só enxerga o estado (GET do projeto): o conteúdo das mensagens traz links
 * de redefinição de senha e dados de clientes, e ligar/desligar muda para onde o e-mail vai — são
 * decisões da pessoa (token-policy.ts). Ler mensagens não é auditado (como a aba Logs); ligar,
 * alterar, desligar e apagar são.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { MailTestUpdateRequest, Project } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
import { SAFE_INLINE_IMAGE, embedInlineImages, mailHtmlCsp, renderMailHtml } from "../services/mail-test-html.js";

const idParam = { type: "string", minLength: 1, maxLength: 64 } as const;
// IDs do Mailpit são texto curto sem barra; a parte é um número com pontos ("1", "1.2")
const messageParam = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;
const partParam = { type: "string", minLength: 1, maxLength: 32, pattern: "^[0-9]+(\\.[0-9]+)*$" } as const;

const projectParams = { type: "object", required: ["id"], properties: { id: idParam } } as const;
const messageParams = { type: "object", required: ["id", "mid"], properties: { id: idParam, mid: messageParam } } as const;
const partParams = { type: "object", required: ["id", "mid", "part"], properties: { id: idParam, mid: messageParam, part: partParam } } as const;

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode || !e.code) throw err;
  return reply.code(e.statusCode).send({ error: e.code, message: e.message });
}

const mailTestRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  async function projectOf(id: string, reply: FastifyReply): Promise<Project | null> {
    const project = await app.deployService.getProject(id);
    if (!project) {
      void reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      return null;
    }
    return project;
  }

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/mail-test",
    { schema: { params: projectParams }, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      return reply.header("cache-control", "no-store").send(await app.mailTest.view(project));
    },
  );

  app.put<{ Params: { id: string }; Body: MailTestUpdateRequest }>(
    "/api/projects/:id/mail-test",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: projectParams,
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            maxMessages: { type: "integer" },
            maxAgeDays: { type: "integer" },
            deleteMessages: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        return reply.send(await app.mailTest.update(project, request.body, request.session?.username));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { start?: string; limit?: string } }>(
    "/api/projects/:id/mail-test/messages",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        params: projectParams,
        // a coerção de tipos do Ajv está desligada: a query chega como texto
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: { type: "string", pattern: "^[0-9]{1,6}$" },
            limit: { type: "string", pattern: "^([1-9][0-9]?|100)$" },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        const res = await app.mailTest.list(project, Number(request.query.start ?? "0"), Number(request.query.limit ?? "50"));
        return reply.header("cache-control", "no-store").send(res);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string; mid: string } }>(
    "/api/projects/:id/mail-test/messages/:mid",
    { schema: { params: messageParams }, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        const { message } = await app.mailTest.message(project, request.params.mid);
        return reply.header("cache-control", "no-store").send({ message });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // O HTML do e-mail para o iframe da tela. É conteúdo não confiável: a resposta se isola sozinha
  // (CSP com sandbox: sem scripts, formulários nem acesso ao painel; sem imagens remotas por padrão).
  app.get<{ Params: { id: string; mid: string }; Querystring: { images?: string } }>(
    "/api/projects/:id/mail-test/messages/:mid/html",
    {
      schema: {
        params: messageParams,
        querystring: { type: "object", additionalProperties: false, properties: { images: { type: "string", enum: ["0", "1"] } } },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        const { html, inline } = await app.mailTest.message(project, request.params.mid);
        const images = await embedInlineImages(html, inline, (partId) => app.mailTest.part(project, request.params.mid, partId));
        return reply
          .header("content-security-policy", mailHtmlCsp(request.query.images === "1"))
          .header("x-content-type-options", "nosniff")
          .header("referrer-policy", "no-referrer")
          .header("cache-control", "no-store")
          .type("text/html; charset=utf-8")
          .send(renderMailHtml(html, images));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string; mid: string; part: string }; Querystring: { download?: string } }>(
    "/api/projects/:id/mail-test/messages/:mid/parts/:part",
    {
      schema: {
        params: partParams,
        querystring: { type: "object", additionalProperties: false, properties: { download: { type: "string", enum: ["0", "1"] } } },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        const part = await app.mailTest.part(project, request.params.mid, request.params.part);
        const type = part.contentType.split(";")[0]!.trim();
        // imagem comum aparece no corpo; o resto (e tudo com ?download=1) só baixa, como binário
        const inlineImage = request.query.download !== "1" && SAFE_INLINE_IMAGE.test(type);
        return reply
          .header("content-security-policy", "sandbox; default-src 'none'")
          .header("x-content-type-options", "nosniff")
          .header("cache-control", "no-store")
          .header("content-disposition", inlineImage ? "inline" : "attachment")
          .type(inlineImage ? type : "application/octet-stream")
          .send(part.body);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; mid: string } }>(
    "/api/projects/:id/mail-test/messages/:mid",
    { schema: { params: messageParams }, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        await app.mailTest.deleteMessage(project, request.params.mid, request.session?.username);
        return reply.send({ ok: true });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/mail-test/messages",
    { schema: { params: projectParams }, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const project = await projectOf(request.params.id, reply);
      if (!project) return reply;
      try {
        await app.mailTest.clear(project, request.session?.username);
        return reply.send({ ok: true });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
};

export default mailTestRoutes;
