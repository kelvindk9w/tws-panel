/**
 * database-unlock.ts — "Liberar edição do banco": a pessoa se reautentica UMA vez (senha + 2FA [+ e-mail]) e, por
 * um tempo, roda comandos de escrita no banco do projeto sem ser perguntada de novo.
 *
 * Regras (tudo em memória: reiniciar o painel encerra tudo, que é o lado seguro):
 *  - a liberação é de UMA sessão de login em UM projeto (chave sessão + projeto): outra sessão, ou outro projeto,
 *    não herda; sair do painel ou a sessão expirar encerra (`watch` + conferência em cada uso);
 *  - a duração e a renovação vêm da configuração (Configurações → Banco de dados) lida NA HORA: encurtar a duração
 *    corta as liberações em curso para o novo prazo; alongar não estica o que já existe (só a renovação com o uso);
 *  - "renovar com o uso": cada comando aceito estende a liberação até o prazo cheio de novo;
 *  - os prazos correm num relógio MONOTÔNICO (performance.now): acertar o relógio da VPS não estica nem encurta;
 *  - token de API nunca usa nem cria liberação (a rota o recusa; aqui a chave é a sessão de cookie).
 *
 * A Auditoria registra liberar e encerrar (com a duração e o motivo); nunca o que foi executado depois.
 */
import { databaseUnlockMs, type DatabaseSettings, type DatabaseUnlockDuration, type DatabaseUnlockStatus } from "@paas/core";
import type { SessionStore } from "./session-store.js";

export type UnlockEndReason = "expired" | "manual" | "session";

export interface DatabaseUnlockOptions {
  settings: { current(): DatabaseSettings };
  /** Relógio monotônico em ms (padrão performance.now). Só os testes trocam. */
  now?: () => number;
  /** A sessão ainda vale? (SessionStore.isActive). Sem isto, só a revogação explícita encerra. */
  isSessionActive?: (sessionId: string) => boolean;
  audit?: (input: { actor: string; action: string; target: string; detail: string }) => void;
}

interface Entry {
  sessionId: string;
  projectId: string;
  username: string;
  slug: string;
  name: string;
  /** Instante (monotônico) em que acaba; null = até a sessão acabar. */
  expiresAt: number | null;
  timer: NodeJS.Timeout | null;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_REMEMBERED_ENDS = 64;
const keyOf = (sessionId: string, projectId: string): string => `${sessionId}\u0000${projectId}`;

export const DURATION_LABELS: Record<DatabaseUnlockDuration, string> = {
  "15m": "15 min",
  "30m": "30 min",
  "1h": "1 h",
  "2h": "2 h",
  "4h": "4 h",
  session: "até a sessão acabar",
};

const END_DETAIL: Record<UnlockEndReason, string> = {
  expired: "o prazo acabou",
  manual: "bloqueada pelo botão",
  session: "a sessão terminou",
};

export class DatabaseUnlock {
  private readonly entries = new Map<string, Entry>();
  private readonly lastEnds = new Map<string, UnlockEndReason>();
  /**
   * Geração de bloqueio por sessão + projeto. "Bloquear agora" (ou o fim da sessão) sobe o número, mesmo sem
   * liberação ainda: quem começou a liberar (e espera o backup) leva o número de antes (`ticket`) e `grant` só vale
   * se ele continua igual.
   */
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: DatabaseUnlockOptions) {
    this.now = opts.now ?? (() => performance.now());
  }

  /** Encerra as liberações das sessões que o SessionStore revogar (sair, troca de senha, recomeço). */
  watch(store: Pick<SessionStore, "onRevoked">): () => void {
    return store.onRevoked((ids) => {
      const gone = new Set(ids);
      for (const entry of [...this.entries.values()]) if (gone.has(entry.sessionId)) this.end(entry, "session");
      for (const key of [...this.generations.keys()]) if (gone.has(key.split("\u0000")[0]!)) this.generations.delete(key);
    });
  }

  /** Marca o momento em que a pessoa pediu para liberar; entregue a `grant` depois do backup. */
  ticket(sessionId: string, projectId: string): number {
    this.prune();
    const key = keyOf(sessionId, projectId);
    const n = this.generations.get(key) ?? 0;
    this.generations.set(key, n);
    return n;
  }

  /** Os contadores de sessões que já não valem (expiraram sem ser revogadas) saem; o mapa não cresce sem fim. */
  private prune(): void {
    const active = this.opts.isSessionActive;
    if (!active || this.generations.size < 256) return;
    for (const key of [...this.generations.keys()]) if (!active(key.split("\u0000")[0]!)) this.generations.delete(key);
  }

  /** O projeto foi apagado: nenhuma liberação (nem pedido em andamento) sobrevive a ele. */
  forgetProject(projectId: string): void {
    for (const entry of [...this.entries.values()]) if (entry.projectId === projectId) this.end(entry, "manual");
    for (const key of [...this.generations.keys()]) if (key.endsWith(`\u0000${projectId}`)) this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    for (const key of [...this.lastEnds.keys()]) if (key.endsWith(`\u0000${projectId}`)) this.lastEnds.delete(key);
  }

  /** Libera (ou renova do zero) a edição deste projeto nesta sessão. A reautenticação já foi conferida por quem chama. */
  grant(sessionId: string, project: { id: string; slug: string; name: string }, username: string): DatabaseUnlockStatus;
  grant(sessionId: string, project: { id: string; slug: string; name: string }, username: string, ticket: number): DatabaseUnlockStatus | null;
  grant(sessionId: string, project: { id: string; slug: string; name: string }, username: string, ticket?: number): DatabaseUnlockStatus | null {
    const key = keyOf(sessionId, project.id);
    // Bloqueada (ou sessão encerrada) enquanto o backup rodava: não concede
    if (ticket !== undefined && ticket !== (this.generations.get(key) ?? 0)) return null;
    if (ticket !== undefined && this.opts.isSessionActive && !this.opts.isSessionActive(sessionId)) return null;
    const previous = this.entries.get(key);
    if (previous) this.drop(previous);
    this.lastEnds.delete(key);
    const { unlockDuration, renewOnUse } = this.opts.settings.current();
    const ms = databaseUnlockMs(unlockDuration);
    const entry: Entry = {
      sessionId,
      projectId: project.id,
      username,
      slug: project.slug,
      name: project.name,
      expiresAt: ms === null ? null : this.now() + ms,
      timer: null,
    };
    this.entries.set(key, entry);
    this.arm(entry);
    this.audit(entry, "database.unlock_granted", `Edição do banco de "${project.name}" liberada por ${DURATION_LABELS[unlockDuration]}${renewOnUse && ms !== null ? " (renova com o uso)" : ""}.`);
    return this.status(sessionId, project.id);
  }

  /** Esta sessão pode alterar o banco deste projeto agora? Confere prazo e sessão na hora (não depende do timer). */
  isUnlocked(sessionId: string, projectId: string): boolean {
    return this.live(sessionId, projectId) !== null;
  }

  /** Um comando de escrita foi aceito: renova a liberação (se a configuração manda). Devolve se ainda vale. */
  use(sessionId: string, projectId: string): boolean {
    const entry = this.live(sessionId, projectId);
    if (!entry) return false;
    const { unlockDuration, renewOnUse } = this.opts.settings.current();
    const ms = databaseUnlockMs(unlockDuration);
    if (renewOnUse && ms !== null) {
      entry.expiresAt = this.now() + ms;
      this.arm(entry);
    }
    return true;
  }

  /** Bloqueia de volta. Devolve se havia liberação. */
  lock(sessionId: string, projectId: string): boolean {
    this.prune();
    const key = keyOf(sessionId, projectId);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.end(entry, "manual");
    return true;
  }

  status(sessionId: string, projectId: string): DatabaseUnlockStatus {
    const live = this.live(sessionId, projectId);
    const { unlockDuration, renewOnUse } = this.opts.settings.current();
    const remaining = live && live.expiresAt !== null ? Math.max(0, live.expiresAt - this.now()) : null;
    return {
      unlocked: live !== null,
      // o relógio de parede só entra aqui, para mostrar o instante; a decisão de expirar nunca usa ele
      expiresAt: remaining === null ? null : new Date(Date.now() + remaining).toISOString(),
      remainingMs: remaining,
      duration: unlockDuration,
      renewOnUse,
      lastEnd: live ? null : (this.lastEnds.get(keyOf(sessionId, projectId)) ?? null),
    };
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry);
    this.generations.clear();
  }

  // ---------------------------------------------------------------------------

  /** A liberação vigente (já conferida) ou null; encerra o que venceu. */
  private live(sessionId: string, projectId: string): Entry | null {
    const entry = this.entries.get(keyOf(sessionId, projectId));
    if (!entry) return null;
    if (this.opts.isSessionActive && !this.opts.isSessionActive(sessionId)) {
      this.end(entry, "session");
      return null;
    }
    // Duração encurtada na configuração: o que resta nunca passa do prazo atual.
    const ms = databaseUnlockMs(this.opts.settings.current().unlockDuration);
    if (ms !== null && (entry.expiresAt === null || entry.expiresAt - this.now() > ms)) {
      entry.expiresAt = this.now() + ms;
      this.arm(entry);
    }
    if (entry.expiresAt !== null && this.now() >= entry.expiresAt) {
      this.end(entry, "expired");
      return null;
    }
    return entry;
  }

  private arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.expiresAt === null) return;
    // Renovar ou encurtar chama `arm` de novo (o timer antigo é cancelado), então ao disparar o prazo é este.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.live(entry.sessionId, entry.projectId);
    }, Math.min(Math.max(entry.expiresAt - this.now(), 0), MAX_TIMER_MS));
    entry.timer.unref();
  }

  private drop(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.entries.delete(keyOf(entry.sessionId, entry.projectId));
  }

  private end(entry: Entry, reason: UnlockEndReason): void {
    const key = keyOf(entry.sessionId, entry.projectId);
    this.drop(entry);
    this.lastEnds.delete(key);
    this.lastEnds.set(key, reason);
    if (this.lastEnds.size > MAX_REMEMBERED_ENDS) this.lastEnds.delete(this.lastEnds.keys().next().value as string);
    this.audit(entry, "database.unlock_ended", `Liberação da edição do banco de "${entry.name}" encerrada: ${END_DETAIL[reason]}.`);
  }

  private audit(entry: Entry, action: string, detail: string): void {
    try {
      this.opts.audit?.({ actor: entry.username, action, target: entry.slug, detail });
    } catch {
      // auditoria com defeito não impede liberar nem bloquear
    }
  }
}
