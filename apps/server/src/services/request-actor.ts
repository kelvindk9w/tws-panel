/**
 * request-actor.ts — quem está agindo na requisição atual, para a Auditoria.
 *
 * Várias rotas gravam na Auditoria sem dizer quem agiu (caem em "operador").
 * Para requisições feitas com token de API, o plugin de autenticação abre este
 * contexto com `token:<nome>`; o AuditService o usa quando o registro não traz
 * `actor`. Assim nenhuma ação feita por um token aparece como "operador", mesmo
 * nas rotas e tarefas em segundo plano que nunca olharam a sessão. Sessão humana
 * não abre contexto: nada muda para ela.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/** Roda `fn` (e tudo que ela dispara) com este ator. */
export function runWithActor<T>(actor: string, fn: () => T): T {
  return storage.run(actor, fn);
}

/**
 * Roda `fn` FORA do contexto de ator. Use ao criar algo de vida longa (timer,
 * agendador, fila) dentro de uma rota: sem isso o contexto da requisição de token
 * seguiria o timer e cada disparo futuro sairia na Auditoria como `token:<nome>`.
 */
export function runOutsideActor<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** O ator do contexto atual (undefined fora de requisição de token). */
export function currentActor(): string | undefined {
  return storage.getStore();
}
