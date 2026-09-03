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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "@paas/core";

const MAX_ENTRIES = 2_000;

interface AuditFile {
  entries: AuditEntry[];
}

export interface AuditServiceOptions {
  /** Teto de entradas no arquivo ativo. Acima disso, rotaciona. */
  maxEntries?: number;
}

export class AuditService {
  private readonly file: string;
  private readonly archiveFile: string;
  private readonly maxEntries: number;
  private entries: AuditEntry[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  /**
   * Registros em andamento. Existe porque as rotas de terminal e de segurança
   * chamam `record()` sem await de propósito (auditar não pode atrasar o
   * caminho quente). Sem isso não há como esperar por essas gravações no
   * desligamento — elas aterrissariam depois de o processo achar que terminou.
   */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(dataDir: string, opts: AuditServiceOptions = {}) {
    this.file = path.join(dataDir, "audit.json");
    this.archiveFile = path.join(dataDir, "audit.1.json");
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  }

  /** Move as entradas excedentes para o arquivo de arquivo, preservando-as. */
  private async archive(excedente: AuditEntry[]): Promise<void> {
    if (excedente.length === 0) return;
    let anteriores: AuditEntry[] = [];
    try {
      const raw = JSON.parse(await readFile(this.archiveFile, "utf8")) as Partial<AuditFile>;
      if (Array.isArray(raw.entries)) anteriores = raw.entries;
    } catch {
      // sem arquivo de arquivo ainda, ou ilegível — recomeça deste ponto
    }
    await mkdir(path.dirname(this.archiveFile), { recursive: true });
    await writeFile(
      this.archiveFile,
      JSON.stringify({ entries: [...anteriores, ...excedente] }, null, 2),
      { mode: 0o600 },
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<AuditFile>;
      this.entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      this.entries = [];
    }
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
    await this.writing.catch(() => undefined);
  }

  private async doRecord(input: {
    actor?: string;
    action: string;
    target?: string | null;
    detail: string;
  }): Promise<AuditEntry> {
    await this.ensureLoaded();
    const entry: AuditEntry = {
      id: randomBytes(8).toString("hex"),
      at: new Date().toISOString(),
      actor: input.actor ?? "operador",
      action: input.action,
      target: input.target ?? null,
      detail: input.detail,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      const excedente = this.entries.slice(0, this.entries.length - this.maxEntries);
      this.entries = this.entries.slice(-this.maxEntries);
      // best-effort, como o resto da auditoria: falha de disco no arquivamento
      // não pode derrubar a ação que estava sendo registrada.
      await this.archive(excedente).catch(() => undefined);
    }
    // serializa escritas para não intercalar JSON
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
    return entry;
  }

  async list(page = 1, perPage = 50): Promise<{ entries: AuditEntry[]; total: number; page: number; perPage: number }> {
    await this.ensureLoaded();
    const total = this.entries.length;
    const safePerPage = Math.min(Math.max(perPage, 1), 200);
    const safePage = Math.max(page, 1);
    // mais recentes primeiro
    const sorted = [...this.entries].reverse();
    const start = (safePage - 1) * safePerPage;
    return {
      entries: sorted.slice(start, start + safePerPage),
      total,
      page: safePage,
      perPage: safePerPage,
    };
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const data: AuditFile = { entries: this.entries };
    await writeFile(this.file, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
