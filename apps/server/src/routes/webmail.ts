/**
 * webmail.ts — rotas do webmail (Roundcube em https://mail.<domínio>/).
 * Registradas pelo módulo de e-mail (routes/mail.ts), que cria o serviço.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { WebmailActionResponse, WebmailStatus } from "@paas/core";
import type { HttpError } from "../services/http-error.js";
import type { WebmailService } from "../services/webmail-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

/** De quanto em quanto tempo o painel lê as senhas erradas do webmail. */
const FAILED_LOGIN_POLL_MS = 60_000;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
  });
}

const webmailRoutes: FastifyPluginAsync<{ webmail: WebmailService }> = async (app, opts) => {
  registerErrorHandler(app);
  const webmail = opts.webmail;

  /**
   * O bloco de cada mail.<domínio> muda (webmail ↔ página do servidor de
   * e-mail). Falha aqui não desfaz a ação: o Caddyfile é recalculado de
   * novo na próxima sincronização do proxy.
   */
  async function refreshProxy(): Promise<string | null> {
    try {
      await app.deployService.refreshProxy();
      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      app.log.warn(`Webmail: falha ao atualizar o proxy (${reason}).`);
      return reason;
    }
  }

  async function action(reply: FastifyReply, kind: "enable" | "disable"): Promise<FastifyReply> {
    try {
      const status = kind === "enable" ? await webmail.enable() : await webmail.disable();
      const proxyError = await refreshProxy();
      await app.auditService.record({
        action: `mail.webmail.${kind}`,
        target: "webmail",
        detail:
          kind === "enable"
            ? `Webmail ativado (${status.links.map((l) => l.host).join(", ")}).`
            : "Webmail desativado: mail.<domínio> volta a mostrar a página do servidor de e-mail.",
      });
      const response: WebmailActionResponse & { proxyError?: string } = {
        ok: true,
        status,
        ...(proxyError ? { proxyError } : {}),
      };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  }

  app.get("/api/mail/webmail", async (_request, reply) => {
    try {
      const status: WebmailStatus = await webmail.status();
      return reply.send(status);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/mail/webmail/enable", async (_request, reply) => action(reply, "enable"));
  app.post("/api/mail/webmail/disable", async (_request, reply) => action(reply, "disable"));

  // Bloqueio de quem erra a senha demais (no lugar do bloqueio do Stalwart,
  // que derrubaria o webmail inteiro — ver webmail-service.ts).
  const poll = setInterval(() => {
    webmail.pollFailedLogins().then(
      async (changed) => {
        if (changed) await refreshProxy();
      },
      (err: unknown) => {
        app.log.warn(`Webmail: falha ao ler as tentativas de login (${err instanceof Error ? err.message : String(err)}).`);
      },
    );
  }, FAILED_LOGIN_POLL_MS);
  poll.unref();
  app.addHook("onClose", async () => {
    clearInterval(poll);
  });
};

export default webmailRoutes;
