/**
 * terminal.ts — WebSocket do terminal web embutido (/api/terminal/ws).
 *
 * Autenticação: a guarda global de /api/* (plugins/auth.ts) já cobre o
 * handshake do WS — setup token (header ou ?token=) durante o wizard e
 * sessão admin (cookie) depois do setup. Sem auth válida: 401 no upgrade.
 *
 * REGRA DE OURO: relay puro. Mensagens do cliente vão direto ao PTY (exceto
 * o frame de controle JSON {"type":"resize"}). O conteúdo digitado NUNCA é
 * logado, persistido ou auditado — apenas conexão/desconexão são auditadas.
 *
 * Uma sessão por vez: um novo cliente substitui o anterior (close 4000) —
 * o PTY em si permanece vivo (com scrollback) entre reconexões.
 */
import type { FastifyPluginAsync } from "fastify";
import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import type { TerminalService } from "../services/terminal-service.js";

declare module "fastify" {
  interface FastifyInstance {
    terminalService: TerminalService;
  }
}

/** Código de fechamento quando outro cliente assume a sessão. */
export const WS_CLOSE_REPLACED = 4000;

const terminalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  let current: WebSocket | null = null;

  app.get("/api/terminal/ws", { websocket: true }, (socket, request) => {
    const term = app.terminalService;

    // Sessão única: o novo cliente assume; o anterior é desconectado.
    if (current && current.readyState === current.OPEN) {
      current.close(WS_CLOSE_REPLACED, "outro cliente assumiu o terminal");
    }
    current = socket;

    void app.auditService.record({
      action: "terminal.connect",
      actor: request.session?.username ?? "setup",
      detail: `Cliente conectado ao terminal web (ip ${request.ip}).`,
    });

    let unsubscribe: (() => void) | null = null;

    term
      .connect()
      .then(({ replay }) => {
        if (socket.readyState !== socket.OPEN) return;
        if (replay.length > 0) socket.send(replay);
        unsubscribe = term.onOutput((chunk) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "terminal indisponível";
        if (socket.readyState === socket.OPEN) {
          socket.send(`\r\n\x1b[31m[terminal] ${message}\x1b[0m\r\n`);
          socket.close(1011, "terminal unavailable");
        }
      });

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      // Frame de controle (JSON) — único desvio do relay puro.
      if (!isBinary) {
        const text = raw.toString("utf8");
        if (text.startsWith("{")) {
          try {
            const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
            if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              term.resize(msg.cols, msg.rows);
              return;
            }
          } catch {
            // não é controle válido: cai no relay como input comum
          }
        }
      }
      // RELAY PURO: input do usuário vai ao PTY sem ser lido/logado/auditado.
      term.write(raw);
    });

    socket.on("close", () => {
      unsubscribe?.();
      if (current === socket) current = null;
      void app.auditService.record({
        action: "terminal.disconnect",
        actor: request.session?.username ?? "setup",
        detail: "Cliente desconectado do terminal web.",
      });
    });
  });
};

export default terminalRoutes;
