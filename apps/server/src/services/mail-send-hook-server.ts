/**
 * mail-send-hook-server.ts — o ouvido do painel para o aviso de envio do
 * Stalwart (MTA hook). É um servidor HTTP PRÓPRIO, separado do painel:
 *
 *  - porta só da rede interna do Docker (nunca publicada no host, nunca no
 *    Caddy): o painel de verdade (porta 9000) não tem essa rota;
 *  - sem cookie, sem sessão, sem CSRF: quem fala aqui é o Stalwart, e prova
 *    com o segredo compartilhado (Authorization: Bearer, comparação em tempo
 *    constante, conferido ANTES de ler o corpo);
 *  - corpo limitado (o Stalwart manda a mensagem inteira; acima do limite o
 *    envio continua normal, só não é registrado), limite de pedidos por
 *    minuto e de tentativas com segredo errado;
 *  - responde na hora e registra depois (MailSendLogService.submit): o envio
 *    nunca espera o disco;
 *  - nenhum log com o corpo do pedido.
 */
import Fastify, { type FastifyInstance } from "fastify";

export interface MailHookServerDeps {
  verify(secret: string): Promise<boolean>;
  submit(payload: unknown): "queued" | "invalid" | "dropped";
  /** Teto do corpo do pedido em bytes (padrão 16 MiB). */
  bodyLimit?: number;
  /** Pedidos aceitos por minuto (padrão 1200). */
  maxPerMinute?: number;
  /** Tentativas com segredo errado por minuto antes de recusar tudo (padrão 30). */
  maxBadAuthPerMinute?: number;
  now?: () => number;
}

export const MAIL_HOOK_PATH = "/mail-hook/send";

class Window {
  private stamps: number[] = [];
  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}
  /** Registra e diz se ainda cabe. */
  hit(): boolean {
    const cutoff = this.now() - 60_000;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(this.now());
    return true;
  }
  full(): boolean {
    const cutoff = this.now() - 60_000;
    return this.stamps.filter((t) => t > cutoff).length >= this.max;
  }
  record(): void {
    this.stamps.push(this.now());
  }
}

export function buildMailHookServer(deps: MailHookServerDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: false,
    bodyLimit: deps.bodyLimit ?? 16 * 1024 * 1024,
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
    trustProxy: false,
  });
  // Só JSON (o Stalwart manda application/json).
  app.removeContentTypeParser("text/plain");
  const all = new Window(deps.maxPerMinute ?? 1200, now);
  const bad = new Window(deps.maxBadAuthPerMinute ?? 30, now);

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || request.url !== MAIL_HOOK_PATH) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (bad.full() || !all.hit()) return reply.code(429).send({ error: "rate_limited" });
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || provided.length > 256 || !(await deps.verify(provided))) {
      bad.record();
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post(MAIL_HOOK_PATH, async (request, reply) => {
    const result = deps.submit(request.body);
    if (result === "invalid") return reply.code(400).send({ error: "invalid_payload" });
    if (result === "dropped") return reply.code(429).send({ error: "queue_full" });
    // O Stalwart espera esta resposta: aceitar, sem mudar nada na mensagem.
    return reply.send({ action: "accept" });
  });

  return app;
}
