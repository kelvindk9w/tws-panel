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
 * Uma sessão por vez, DESTACÁVEL do WebSocket: o PTY (e qualquer comando em
 * andamento) vive no servidor independente da conexão do navegador — cair o
 * WS nunca interrompe uma fase; ao reconectar, o cliente reanexa e recebe o
 * scrollback + stream em curso.
 *
 * Anti-ping-pong (duas abas com o painel aberto): o cliente envia um
 * `clientId` estável (sessionStorage) na query do WS.
 *  - mesmo clientId do dono → REANEXA (a conexão antiga sai de cena, 4000);
 *  - clientId diferente enquanto o dono está conectado → a NOVA conexão é
 *    recusada com 4009 ("terminal em uso") SEM derrubar o dono — o cliente
 *    recusado não tenta reconectar, então não há disputa infinita;
 *  - dono desconectado (sessão órfã) → qualquer clientId pode assumir: a
 *    sessão continua viva no servidor até o idle timeout.
 * Clientes antigos (sem clientId) seguem o comportamento de substituição
 * entre si, mas nunca derrubam um dono identificado.
 *
 * PROTOCOLO SERVIDOR → NAVEGADOR (frames de texto):
 *  - frame comum = bytes do terminal (saída do PTY, replay do scrollback e o
 *    espelho do modo segundo-plano). Todo byte NUL (U+0000) é REMOVIDO antes
 *    do envio — terminais ignoram NUL, e é isso que torna o controle abaixo
 *    impossível de forjar por um programa rodando no shell;
 *  - frame de controle = TERMINAL_CONTROL_PREFIX ("\u0000paas-control:")
 *    seguido de JSON (TerminalControlMessage, @paas/core). Decodifique com
 *    parseTerminalControl(frame): devolve a mensagem ou null (frame comum).
 *    Nunca escreva um frame de controle no xterm. Mensagens:
 *    · {"type":"sudo-password-requested","user":"kelvin"|null}
 *      O sudo está pedindo senha no terminal (detectado na SAÍDA). Também é
 *      enviada logo após o replay a quem conecta com o prompt já aberto.
 *    · {"type":"sudo-password-prompt-closed","outcome":...}
 *      O prompt terminou. outcome: "answered" (seguiu sem erro), "rejected"
 *      ("Sorry, try again." — um novo requested costuma vir em seguida),
 *      "exhausted" (3 tentativas erradas), "not-permitted" (usuário sem
 *      sudo), "timeout" (o painel cansou de esperar e mandou Ctrl-C) ou
 *      "session-ended" (a sessão acabou com o prompt aberto).
 *    · {"type":"background-exec","state":"start","command":"<cmd>"} e
 *      {"type":"background-exec","state":"end","command":"<cmd>","code":n|null}
 *      Modo segundo-plano: um comando começou/terminou como root pelo host
 *      bridge; a saída chega como frames comuns (espelho), nunca digitada no
 *      shell do usuário. code null = falhou antes de ter código.
 *  A senha que o operador digita continua sendo input comum (relay puro):
 *  nenhum destes eventos contém, deriva ou inspeciona o que foi digitado.
 *
 * GET /api/terminal/info: usuário com que o terminal abre e o modo de root
 * (TerminalInfoResponse), com a mesma autenticação do WS.
 */
import type { FastifyPluginAsync } from "fastify";
import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import { encodeTerminalControl, type TerminalInfoResponse } from "@paas/core";
import { resolveTerminalAccess } from "../config.js";
import type { TerminalService } from "../services/terminal-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

// Querystring do handshake do WS (não um body — upgrade não tem corpo):
//  - clientId: gerado no browser (crypto.randomUUID() ou fallback base36),
//    usado só para a lógica de reattach/anti-ping-pong acima. Nunca chega a
//    um comando de shell — a faixa é só para rejeitar lixo cedo.
//  - token: setup token (SETUP_TOKEN_QUERY) já validado bit a bit por
//    tokenMatches (plugins/auth.ts) antes de qualquer coisa aqui; o schema
//    só limita o tamanho, sem restringir caracteres (o admin pode definir
//    SETUP_TOKEN livremente via variável de ambiente).
const terminalWsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      clientId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
      token: { type: "string", maxLength: 512 },
    },
  },
} as const;

declare module "fastify" {
  interface FastifyInstance {
    terminalService: TerminalService;
  }
}

/** Código de fechamento quando o MESMO cliente reanexa por outra conexão. */
export const WS_CLOSE_REPLACED = 4000;
/** Código de fechamento quando a sessão já tem dono (outro clientId) — o
 * cliente que recebe 4009 NÃO deve tentar reconectar (fim do ping-pong). */
export const WS_CLOSE_BUSY = 4009;

const terminalRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  // Mesma guarda global de /api/* que protege o WS (setup token durante o
  // wizard, sessão admin depois). Sem entrada do cliente.
  app.get("/api/terminal/info", async (_request, reply) => {
    const response: TerminalInfoResponse = resolveTerminalAccess(app.config);
    return reply.send(response);
  });

  /** Dono atual da sessão de terminal (uma conexão por vez). */
  let owner: { clientId: string | null; socket: WebSocket } | null = null;

  app.get("/api/terminal/ws", { websocket: true, schema: terminalWsSchema }, (socket, request) => {
    const term = app.terminalService;
    const clientId = (request.query as { clientId?: string }).clientId ?? null;

    if (owner && owner.socket.readyState === owner.socket.OPEN) {
      if (owner.clientId !== null && owner.clientId !== clientId) {
        // Sessão em uso por OUTRO cliente: recusa a NOVA conexão sem tocar no
        // dono. Sem auditoria aqui de propósito: um cliente teimoso geraria
        // spam de eventos (a recusa em si já é o sinal para ele parar).
        socket.close(WS_CLOSE_BUSY, "terminal em uso em outra aba/janela");
        return;
      }
      // Mesmo cliente reconectando (reload/queda de rede) ou cliente legado
      // sem clientId: a conexão antiga sai de cena, a sessão permanece.
      owner.socket.close(WS_CLOSE_REPLACED, "reattach do mesmo cliente");
    }
    owner = { clientId, socket };

    void app.auditService.record({
      action: "terminal.connect",
      actor: request.session?.username ?? "setup",
      detail: `Cliente conectado ao terminal web (ip ${request.ip}).`,
    });

    let unsubscribe: (() => void) | null = null;
    // Bytes do terminal sem NUL: nenhum frame comum começa como controle.
    const sendOutput = (chunk: string) => {
      const clean = chunk.includes("\u0000") ? chunk.replace(/\u0000/g, "") : chunk;
      if (clean.length > 0 && socket.readyState === socket.OPEN) socket.send(clean);
    };

    term
      .connect()
      .then(({ replay }) => {
        if (socket.readyState !== socket.OPEN) return;
        sendOutput(replay);
        if (term.sudoPromptOpen) {
          socket.send(encodeTerminalControl({ type: "sudo-password-requested", user: term.sudoPromptUser }));
        }
        const offOutput = term.onOutput(sendOutput);
        const offControl = term.onControl((msg) => {
          if (socket.readyState === socket.OPEN) socket.send(encodeTerminalControl(msg));
        });
        unsubscribe = () => {
          offOutput();
          offControl();
        };
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
      // Sessão órfã: o PTY segue vivo no servidor (idle timeout) e qualquer
      // cliente pode assumir na próxima conexão.
      if (owner?.socket === socket) owner = null;
      void app.auditService.record({
        action: "terminal.disconnect",
        actor: request.session?.username ?? "setup",
        detail: "Cliente desconectado do terminal web.",
      });
    });
  });
};

export default terminalRoutes;
