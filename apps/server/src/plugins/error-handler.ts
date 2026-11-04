/**
 * Handler de erro padronizado.
 *
 * O Fastify responde erros de validação de schema no formato dele
 * ({ statusCode, error: "Bad Request", message: "body/name must be string" }),
 * que difere do formato do painel ({ error, message }) e ainda ecoa o caminho
 * do campo — detalhe interno que não precisa chegar ao cliente. Este handler
 * converte validação em 400 `invalid_request` e deixa os demais erros seguirem
 * a serialização padrão.
 */
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { scrubUrl } from "../log-config.js";
import { mailAuthError } from "../services/mail-auth-error.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error.validation) {
      // O detalhe completo (jargão do Ajv, caminho do schema) fica no log do
      // servidor. Na resposta vai só o nome do campo — suficiente para a UI
      // orientar quem preencheu o formulário, sem expor a estrutura interna.
      request.log.warn(
        { validation: error.validation, url: scrubUrl(request.url) },
        "requisição recusada por validação de schema",
      );
      return reply.code(400).send({
        error: "invalid_request",
        message: invalidFieldMessage(error),
      });
    }
    // Rota sem try/catch própria: um 401 do Stalwart nunca pode sair como 401 (o navegador leria "sessão acabou").
    const mailAuth = mailAuthError(error);
    if (mailAuth) return reply.code(mailAuth.statusCode).send({ error: mailAuth.code, message: mailAuth.message });
    return reply.send(error);
  });
}

/** Mensagem em pt-BR nomeando o campo recusado, sem o jargão do validador. */
function invalidFieldMessage(error: FastifyError): string {
  const first = error.validation?.[0];
  if (!first) return "Requisição inválida: verifique os campos enviados.";

  const params = (first.params ?? {}) as Record<string, unknown>;
  if (first.keyword === "required") {
    return `Campo obrigatório ausente: ${String(params.missingProperty)}.`;
  }
  if (first.keyword === "additionalProperties") {
    return `Campo desconhecido no corpo da requisição: ${String(params.additionalProperty)}.`;
  }

  // instancePath vem como "/proxyPort" (ou "/a/b" em objeto aninhado).
  const field = String(first.instancePath ?? "")
    .replace(/^\//, "")
    .replace(/\//g, ".");
  return field ? `Campo inválido: ${field}.` : "Requisição inválida: verifique os campos enviados.";
}
