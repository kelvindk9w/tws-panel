/**
 * audit-service.ts — log de auditoria de ações sensíveis (Fase 4, plano §7).
 * Persistência JSON em data/audit.json (append, cap de entradas).
 * NUNCA registrar segredos no detalhe.
 *
 * Ao estourar o teto, as entradas mais antigas são movidas para audit.1.json
 * em vez de descartadas: a trilha existe para investigação pós-incidente, e a
 * pergunta que se faz depois ("quando isso foi configurado?") costuma ser
 * justamente sobre o começo do histórico.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AuditEntry } from "@paas/core";
import { JsonFile } from "./json-file.js";
import { currentActor } from "./request-actor.js";

const MAX_ENTRIES = 2_000;
/**
 * Teto do audit.1.json (o arquivo morto). São dois arquivos no total, nunca mais: ao passar disto as entradas MAIS
 * ANTIGAS do arquivo morto saem. Sem teto, um fluxo constante de eventos (uma IA ocupada, por exemplo) o faria
 * crescer sem limite e ser regravado inteiro a cada rotação.
 */
const MAX_ARCHIVED_ENTRIES = 20_000;

interface AuditFile {
  entries: AuditEntry[];
}

export interface AuditServiceOptions {
  /** Teto de entradas no arquivo ativo. Acima disso, rotaciona. */
  maxEntries?: number;
  /** Teto de entradas no arquivo morto (audit.1.json). Acima disso, as mais antigas saem. */
  maxArchivedEntries?: number;
}

function auditFile(file: string): JsonFile<AuditFile> {
  return new JsonFile<AuditFile>(file, {
    empty: () => ({ entries: [] }),
    parse: (raw) => {
      const entries = (raw as Partial<AuditFile> | null)?.entries;
      return Array.isArray(entries) ? { entries } : null;
    },
  });
}

/**
 * Cada registro é UMA transação na fila do audit.json (services/json-file.ts):
 * lê o arquivo, acrescenta, rotaciona (o audit.1.json é alterado dentro da
 * mesma vez) e grava. Nada fica em memória entre um registro e outro — por
 * isso não há "carga inicial" para disputar com os primeiros registros.
 */
export class AuditService {
  private readonly active: JsonFile<AuditFile>;
  private readonly archived: JsonFile<AuditFile>;
  private readonly maxEntries: number;
  private readonly maxArchivedEntries: number;
  /**
   * Registros em andamento. Existe porque as rotas de terminal e de segurança
   * chamam `record()` sem await de propósito (auditar não pode atrasar o
   * caminho quente). Sem isso não há como esperar por essas gravações no
   * desligamento — elas aterrissariam depois de o processo achar que terminou.
   */
  private readonly pending = new Set<Promise<unknown>>();
  /**
   * Registros cuja gravação falhou (disco cheio, permissão). Ficam aqui e
   * entram na próxima gravação que der certo — como antes, quando a lista
   * inteira vivia em memória.
   */
  private unsaved: AuditEntry[] = [];

  constructor(dataDir: string, opts: AuditServiceOptions = {}) {
    this.active = auditFile(path.join(dataDir, "audit.json"));
    this.archived = auditFile(path.join(dataDir, "audit.1.json"));
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.maxArchivedEntries = opts.maxArchivedEntries ?? MAX_ARCHIVED_ENTRIES;
  }

  /** Registra uma ação sensível. Best-effort: falha de disco não derruba a ação. */
  async record(input: {
    actor?: string;
    action: string;
    target?: string | null;
    detail: string;
  }): Promise<AuditEntry> {
    // O registro entra em `pending` de forma síncrona, antes do primeiro await,
    // para que um `void record(...)` já esteja visível a um flush() imediato.
    const op = this.doRecord(input);
    this.pending.add(op);
    try {
      return await op;
    } finally {
      this.pending.delete(op);
    }
  }

  /**
   * Espera terminarem os registros já disparados, inclusive os que ninguém
   * aguardou. Use antes de desligar o processo ou de descartar o diretório de
   * dados; sem isso, uma gravação atrasada pode recriar o diretório ao salvar.
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async doRecord(input: {
    actor?: string;
    action: string;
    target?: string | null;
    detail: string;
  }): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: randomBytes(8).toString("hex"),
      at: new Date().toISOString(),
      actor: input.actor ?? currentActor() ?? "operador",
      action: input.action,
      target: input.target ?? null,
      detail: input.detail,
    };
    let carried: AuditEntry[] = [];
    await this.active
      .update(async (current) => {
        carried = this.unsaved;
        this.unsaved = [];
        const entries = [...current.entries, ...carried, entry];
        if (entries.length <= this.maxEntries) return { entries };
        const excedente = entries.slice(0, entries.length - this.maxEntries);
        try {
          // Ao estourar o teto, as antigas vão para o audit.1.json ANTES de
          // saírem do ativo. Se o arquivamento falhar, elas ficam no ativo
          // (passa do teto por um tempo, mas nada se perde).
          await this.archived.update((old) => ({ entries: [...old.entries, ...excedente].slice(-this.maxArchivedEntries) }));
        } catch {
          return { entries };
        }
        return { entries: entries.slice(-this.maxEntries) };
      })
      // best-effort, como sempre foi: falha de disco não derruba a ação auditada
      .catch(() => {
        this.unsaved = [...carried, entry, ...this.unsaved];
      });
    return entry;
  }

  async list(page = 1, perPage = 50): Promise<{ entries: AuditEntry[]; total: number; page: number; perPage: number }> {
    const saved = (await this.active.read().catch(() => ({ entries: [] as AuditEntry[] }))).entries;
    const all = [...saved, ...this.unsaved];
    const total = all.length;
    const safePerPage = Math.min(Math.max(perPage, 1), 200);
    const safePage = Math.max(page, 1);
    // mais recentes primeiro
    const sorted = [...all].reverse();
    const start = (safePage - 1) * safePerPage;
    return {
      entries: sorted.slice(start, start + safePerPage),
      total,
      page: safePage,
      perPage: safePerPage,
    };
  }
}
