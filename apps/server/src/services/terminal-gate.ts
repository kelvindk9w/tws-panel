/**
 * terminal-gate.ts — o terminal web só abre HABILITADO, depois do setup.
 *
 * Por quê: o terminal roda como o usuário de administração da VPS, dono do próprio
 * ~/.ssh/authorized_keys. Quem roubasse uma sessão do painel abriria o terminal, poria uma chave
 * SSH e contornaria a reautenticação (senha + 2FA + código por e-mail) das ações de acesso.
 *
 * Regras (tudo em memória: reiniciar o servidor desliga tudo, que é o lado seguro):
 *  - a habilitação é de UMA sessão de login (a que se reautenticou), nunca da conta;
 *  - vale por uma janela máxima (`windowMs`) e desliga antes se ficar `idleMs` sem ENTRADA no
 *    terminal (`touch`, chamado a cada tecla/colagem; saída do shell, resize e reconexão não contam);
 *  - desliga na hora: pelo botão, ao revogar a sessão (saída, troca de senha, recomeço), ao trocar a
 *    senha do painel e ao desligar o 2FA (`disableAll`);
 *  - quem ouve (`onEnded`) fecha as conexões abertas dessa sessão com a mensagem do motivo.
 *
 * A auditoria registra habilitar, desligar e expirar — nunca o que foi digitado.
 */
import type { TerminalAccessStatus, TerminalGateEndReason } from "@paas/core";
import type { SessionStore } from "./session-store.js";

export interface TerminalGateOptions {
  windowMs: number;
  idleMs: number;
  now?: () => number;
  audit?: (action: string, detail: string, actor: string) => void;
}

interface Entry {
  sessionId: string;
  username: string;
  expiresAt: number;
  lastInputAt: number;
  timer: NodeJS.Timeout | null;
}

export type TerminalGateEndListener = (sessionId: string, reason: TerminalGateEndReason) => void;

/** Teto do setTimeout no Node (acima disso ele dispara em 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;
/** Quantos "último motivo" guardar (para a tela explicar por que desligou). */
const MAX_REMEMBERED_ENDS = 64;

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

const DISABLED_DETAIL: Record<"manual" | "session" | "credentials", string> = {
  manual: "pelo botão",
  session: "a sessão terminou",
  credentials: "senha ou 2FA do painel mudou",
};

/** Mensagem para quem estava com o terminal aberto (vai ao terminal e ao fechamento do WS). */
export function terminalGateEndMessage(reason: TerminalGateEndReason, opts: { windowMs: number; idleMs: number }): string {
  switch (reason) {
    case "window":
      return `O tempo de ${minutes(opts.windowMs)} do terminal acabou e ele foi desligado. Habilite de novo com a senha e o código do app.`;
    case "idle":
      return `O terminal foi desligado por ${minutes(opts.idleMs)} sem uso. Habilite de novo com a senha e o código do app.`;
    case "credentials":
      return "O terminal foi desligado porque a senha ou a verificação em duas etapas do painel mudou. Habilite de novo.";
    case "session":
      return "O terminal foi desligado porque a sessão no painel terminou.";
    case "manual":
      return "O terminal foi desligado. Habilite de novo com a senha e o código do app para voltar a usá-lo.";
  }
}

export class TerminalGate {
  readonly windowMs: number;
  readonly idleMs: number;
  private readonly now: () => number;
  private readonly audit: (action: string, detail: string, actor: string) => void;
  private readonly entries = new Map<string, Entry>();
  private readonly lastEnds = new Map<string, TerminalGateEndReason>();
  private readonly listeners = new Set<TerminalGateEndListener>();

  constructor(opts: TerminalGateOptions) {
    this.windowMs = opts.windowMs;
    this.idleMs = opts.idleMs;
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit ?? (() => undefined);
  }

  /** Quem quer saber quando uma habilitação termina. Devolve o cancelamento. */
  onEnded(listener: TerminalGateEndListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Desliga as habilitações das sessões que o SessionStore revogar (logout, troca de senha, recomeço). */
  watch(store: Pick<SessionStore, "onRevoked">): () => void {
    return store.onRevoked((ids) => {
      for (const id of ids) this.disable(id, "session");
    });
  }

  /** Habilita (ou renova a janela de) uma sessão. A reautenticação já foi conferida por quem chama. */
  enable(sessionId: string, username: string): void {
    this.drop(sessionId);
    this.lastEnds.delete(sessionId);
    const now = this.now();
    const entry: Entry = { sessionId, username, expiresAt: now + this.windowMs, lastInputAt: now, timer: null };
    this.entries.set(sessionId, entry);
    this.arm(entry);
    this.audit(
      "terminal.enabled",
      `Terminal web habilitado por até ${minutes(this.windowMs)} (desliga após ${minutes(this.idleMs)} sem uso).`,
      username,
    );
  }

  /** Esta sessão está habilitada agora? Confere os prazos na hora (não depende só do timer). */
  isEnabled(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return !this.expireIfDue(entry);
  }

  /** Houve ENTRADA no terminal: adia o desligamento por ociosidade (nunca a janela). */
  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry && !this.expireIfDue(entry)) entry.lastInputAt = this.now();
  }

  /** Desliga uma sessão. Devolve se havia algo habilitado. */
  disable(sessionId: string, reason: TerminalGateEndReason): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.end(entry, reason);
    return true;
  }

  /** Desliga todas as habilitações (troca de senha, 2FA desligado). */
  disableAll(reason: TerminalGateEndReason): number {
    const all = [...this.entries.values()];
    for (const entry of all) this.end(entry, reason);
    return all.length;
  }

  status(
    sessionId: string,
  ): Pick<TerminalAccessStatus, "enabled" | "expiresAt" | "idleExpiresAt" | "remainingMs" | "idleRemainingMs" | "windowMs" | "idleMs" | "lastEnd"> {
    const entry = this.entries.get(sessionId);
    const live = entry && !this.expireIfDue(entry) ? entry : null;
    const now = this.now();
    const idleAt = live ? Math.min(live.lastInputAt + this.idleMs, live.expiresAt) : 0;
    return {
      enabled: live !== null,
      expiresAt: live ? new Date(live.expiresAt).toISOString() : null,
      idleExpiresAt: live ? new Date(idleAt).toISOString() : null,
      remainingMs: live ? Math.max(0, live.expiresAt - now) : 0,
      idleRemainingMs: live ? Math.max(0, idleAt - now) : 0,
      windowMs: this.windowMs,
      idleMs: this.idleMs,
      lastEnd: live ? null : (this.lastEnds.get(sessionId) ?? null),
    };
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------

  private deadline(entry: Entry): { at: number; reason: "window" | "idle" } {
    const idleAt = entry.lastInputAt + this.idleMs;
    return idleAt < entry.expiresAt ? { at: idleAt, reason: "idle" } : { at: entry.expiresAt, reason: "window" };
  }

  /** Encerra se algum prazo já passou. Devolve true se encerrou. */
  private expireIfDue(entry: Entry): boolean {
    const { at, reason } = this.deadline(entry);
    if (this.now() < at) return false;
    this.end(entry, reason);
    return true;
  }

  private arm(entry: Entry): void {
    const { at } = this.deadline(entry);
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        if (this.entries.get(entry.sessionId) !== entry) return;
        if (!this.expireIfDue(entry)) this.arm(entry); // houve entrada no meio: espera mais
      },
      Math.min(Math.max(at - this.now(), 0), MAX_TIMER_MS),
    );
    entry.timer.unref();
  }

  private drop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
  }

  private end(entry: Entry, reason: TerminalGateEndReason): void {
    if (this.entries.get(entry.sessionId) !== entry) return;
    this.drop(entry.sessionId);
    this.lastEnds.delete(entry.sessionId);
    this.lastEnds.set(entry.sessionId, reason);
    if (this.lastEnds.size > MAX_REMEMBERED_ENDS) this.lastEnds.delete(this.lastEnds.keys().next().value as string);
    if (reason === "window") {
      this.audit("terminal.expired", `Terminal web desligado: a janela de ${minutes(this.windowMs)} acabou.`, entry.username);
    } else if (reason === "idle") {
      this.audit("terminal.expired", `Terminal web desligado: ${minutes(this.idleMs)} sem entrada.`, entry.username);
    } else {
      this.audit("terminal.disabled", `Terminal web desligado (${DISABLED_DETAIL[reason]}).`, entry.username);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(entry.sessionId, reason);
      } catch {
        // um ouvinte com defeito não impede o desligamento
      }
    }
  }
}
