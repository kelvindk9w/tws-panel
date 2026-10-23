/**
 * reach-masks.ts — o que uma resposta deixa de contar a um token limitado a
 * projetos. Recusa de conflito (domínio, porta, nome) e listas de portas/pares
 * de domínio vêm do servidor inteiro; para quem só enxerga alguns projetos elas
 * não podem revelar que algo existe, ou quem usa, FORA do alcance dele.
 * Sessão humana e token de painel inteiro recebem tudo como sempre.
 */
import type { FastifyRequest } from "fastify";
import type { DomainPairOccupant, PortsResponse, ProjectDomainPair, RestoreCheckView } from "@paas/core";
import { httpError, type HttpError } from "./http-error.js";
import { limitedProjectIds } from "./request-reach.js";

type WithSession = Pick<FastifyRequest, "session">;

/** Textos genéricos: dizem "indisponível", nunca quem usa nem onde. */
export const DOMAIN_UNAVAILABLE = "Este domínio não está disponível. Escolha outro.";
export const PORT_UNAVAILABLE = "Esta porta do servidor não está disponível. Escolha outra.";
export const NAME_UNAVAILABLE = "Este nome não está disponível. Escolha outro nome para o projeto.";

const PORT_CONFLICT = /já é usada por|reservada ao painel|também está na linha/;

/** Troca a recusa de conflito por uma genérica quando o pedido é de token limitado. */
export function maskedForLimitedToken(request: WithSession, err: unknown): unknown {
  if (limitedProjectIds(request) === null) return err;
  const e = err as Partial<HttpError> | null;
  switch (e?.code) {
    case "domain_in_use":
      return httpError(409, "domain_unavailable", DOMAIN_UNAVAILABLE);
    case "port_in_use":
      return httpError(409, "port_unavailable", PORT_UNAVAILABLE);
    case "slug_folder_exists":
      return httpError(409, "name_unavailable", NAME_UNAVAILABLE);
    case "invalid_ports": {
      const errors = (e.details?.errors ?? []) as Array<{ index: number; message: string }>;
      const masked = errors.map((row) => (PORT_CONFLICT.test(row.message) ? { index: row.index, message: PORT_UNAVAILABLE } : row));
      if (masked.every((row, i) => row === errors[i])) return err;
      const out = httpError(
        400,
        "invalid_ports",
        `${masked.length} ${masked.length === 1 ? "porta" : "portas"} com problema. A primeira: ${masked[0]!.message}`,
      );
      out.details = { ...e.details, errors: masked };
      return out;
    }
    default:
      return err;
  }
}

/** Par de domínio ocupado por painel, e-mail ou outro projeto: "indisponível" (só o do próprio projeto aparece). */
export function maskOccupant(request: WithSession, occupant: DomainPairOccupant | null | undefined): DomainPairOccupant | null | undefined {
  if (limitedProjectIds(request) === null || !occupant || occupant === "same_project") return occupant;
  return "unavailable";
}

export function maskPairOccupants(request: WithSession, rows: ProjectDomainPair[]): ProjectDomainPair[] {
  if (limitedProjectIds(request) === null) return rows;
  return rows.map((row) => {
    if (!row.occupiedBy || row.occupiedBy === "same_project") return row;
    return { ...row, occupiedBy: "unavailable" as const };
  });
}

/**
 * Visão de portas do projeto para token limitado: só as linhas dos projetos do alcance dele,
 * sem dizer com quem uma porta conflita e sem as portas reservadas do painel.
 */
export function maskPortsResponse<T extends PortsResponse>(request: WithSession, response: T): T {
  const ids = limitedProjectIds(request);
  if (ids === null) return response;
  return {
    ...response,
    rows: response.rows
      .filter((row) => row.owner === "project" && row.projectId !== null && ids.has(row.projectId))
      .map((row) => (row.conflict ? { ...row, conflictWith: PORT_UNAVAILABLE } : row)),
    reserved: [],
  };
}

/**
 * Aba Backups do projeto para token limitado: o teste de restauração mostra outros projetos
 * (candidatos a destino, destino escolhido). Fora do alcance, nada disso aparece.
 */
export function maskProjectBackupView<T extends { restoreCheck: RestoreCheckView }>(request: WithSession, view: T): T {
  const ids = limitedProjectIds(request);
  if (ids === null) return view;
  const rc = view.restoreCheck;
  const destinationOut = rc.settings !== null && !ids.has(rc.settings.destinationId);
  return {
    ...view,
    restoreCheck: {
      ...rc,
      candidates: rc.candidates.filter((c) => ids.has(c.id)),
      ...(destinationOut ? { settings: null, last: null, notice: null } : {}),
    },
  };
}
