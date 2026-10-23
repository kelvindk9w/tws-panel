/**
 * request-reach.ts — o que a requisição atual alcança, para as rotas que
 * filtram ou conferem por conta própria (alcance "scoped" da tabela de
 * token-policy-table.ts). Sessão humana e token de painel inteiro alcançam
 * tudo (null); token limitado a projetos alcança só a lista dele.
 */
import type { FastifyRequest } from "fastify";

/** Ids dos projetos que o token limitado alcança; null = sem limite de projeto. */
export function limitedProjectIds(request: Pick<FastifyRequest, "session">): ReadonlySet<string> | null {
  const reach = request.session?.token?.reach;
  return reach?.kind === "projects" ? new Set(reach.ids) : null;
}

/** O projeto está ao alcance desta requisição? (sem limite = sempre) */
export function projectInReach(request: Pick<FastifyRequest, "session">, projectId: string): boolean {
  const ids = limitedProjectIds(request);
  return ids === null || ids.has(projectId);
}
