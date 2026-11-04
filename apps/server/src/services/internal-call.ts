/**
 * internal-call.ts — marca as chamadas que o próprio painel faz a si mesmo (as ferramentas do MCP chamam as rotas
 * da API com `app.inject`, no nome do token de quem pediu).
 *
 * Por quê: o limite global de taxa conta por IP. Essas chamadas internas levam o IP real de quem usa o MCP, e sem
 * distinção gastariam o mesmo limite da pessoa que usa a tela do painel pelo mesmo IP (ou pelo mesmo NAT): uma IA
 * ocupada deixaria a tela com 429. Marcadas, elas contam num balde próprio POR TOKEN.
 *
 * A marca é um segredo sorteado a cada subida do painel e nunca sai dele: quem de fora mandar o cabeçalho com outro
 * valor continua no limite do seu IP (não ganha balde novo para esquivar o limite).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const INTERNAL_CALL_HEADER = "x-paas-internal-call";
const SECRET = randomBytes(32).toString("hex");

/** Cabeçalho que marca uma chamada interna. */
export function internalCallHeaders(): Record<string, string> {
  return { [INTERNAL_CALL_HEADER]: SECRET };
}

/** Chave do balde de uma chamada interna (por credencial), ou null se a requisição não é interna. */
export function internalCallBucket(request: Pick<FastifyRequest, "headers">): string | null {
  const mark = request.headers[INTERNAL_CALL_HEADER];
  if (typeof mark !== "string" || mark.length !== SECRET.length) return null;
  if (!timingSafeEqual(Buffer.from(mark), Buffer.from(SECRET))) return null;
  const credential = request.headers.authorization ?? request.headers["x-setup-token"] ?? "";
  return `internal:${createHash("sha256").update(String(credential)).digest("hex").slice(0, 24)}`;
}
