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
  /** Pedidos sendo lidos ao mesmo tempo (padrão 2): cada aviso pode ter vários MiB em memória. */
  maxConcurrent?: number;
  /** Teto do corpo do pedido em bytes (padrão 8 MiB). */
  bodyLimit?: number;
  /** Pedidos aceitos por minuto (padrão 1200). */
  maxPerMinute?: number;
  /** Tentativas com segredo errado por minuto antes de recusar tudo (padrão 30). */
  maxBadAuthPerMinute?: number;
  /**
   * Endereços de onde o aviso pode vir (o IP do container do Stalwart). Fora da
   * lista: 403 antes de qualquer conferência. Sem a função, qualquer origem.
   */
  allowFrom?: (ip: string) => Promise<readonly string[]>;
  now?: () => number;
}

/**
 * Endereços do container do Stalwart, por nome na rede do Docker. Guardados por
 * 30 s; um pedido de IP desconhecido (o container foi recriado e mudou de
 * endereço) refaz a consulta, no máximo uma vez a cada 5 s, para não perder
 * capturas por até 30 s nem deixar quem não é o Stalwart forçar consultas.
 */
export function stalwartAddressResolver(opts: {
  lookup: () => Promise<string[]>;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
}): (ip: string) => Promise<string[]> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 30_000;
  const retry = opts.retryMs ?? 5_000;
  let cache: { at: number; ips: string[] } | null = null;
  let inflight: Promise<string[]> | null = null;
  return async (ip) => {
    if (cache) {
      const age = now() - cache.at;
      if (cache.ips.includes(ip) ? age < ttl : age < retry) return cache.ips;
    }
    inflight ??= opts
      .lookup()
      .catch(() => [] as string[])
      .then((ips) => {
        cache = { at: now(), ips };
        return ips;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** "::ffff:172.18.0.2" → "172.18.0.2". */
function plainIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Tentativas ruins por origem: uma origem barulhenta não bloqueia as outras. */
class PerIp {
  private readonly windows = new Map<string, Window>();
  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}
  private get(ip: string): Window {
    let w = this.windows.get(ip);
    if (!w) {
      if (this.windows.size >= 1000) this.windows.delete(this.windows.keys().next().value as string);
      w = new Window(this.max, this.now);
      this.windows.set(ip, w);
    }
    return w;
  }
  full(ip: string): boolean {
    return this.get(ip).full();
  }
  record(ip: string): void {
    this.get(ip).record();
  }
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
    bodyLimit: deps.bodyLimit ?? 8 * 1024 * 1024,
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
    trustProxy: false,
  });
  // Só JSON (o Stalwart manda application/json).
  app.removeContentTypeParser("text/plain");
  const all = new Window(deps.maxPerMinute ?? 1200, now);
  let inflight = 0;
  const bad = new PerIp(deps.maxBadAuthPerMinute ?? 30, now);

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || request.url !== MAIL_HOOK_PATH) {
      return reply.code(404).send({ error: "not_found" });
    }
    const ip = plainIp(request.ip);
    if (deps.allowFrom) {
      const allowed = await deps.allowFrom(ip).catch(() => [] as string[]);
      if (!allowed.includes(ip)) return reply.code(403).send({ error: "forbidden" });
    }
    // Só a origem que errou o segredo é barrada; o segredo certo nunca é bloqueado por terceiros.
    if (bad.full(ip)) return reply.code(429).send({ error: "rate_limited" });
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || provided.length > 256 || !(await deps.verify(provided))) {
      bad.record(ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!all.hit() || inflight >= (deps.maxConcurrent ?? 2)) return reply.code(429).send({ error: "rate_limited" });
    inflight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inflight--;
      }
    };
    reply.raw.once("close", release);
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
