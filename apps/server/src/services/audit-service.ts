/**
 * audit-service.ts — log de auditoria de ações sensíveis (Fase 4, plano §7).
 * Persistência JSON em data/audit.json (append, cap de entradas).
 * NUNCA registrar segredos no detalhe.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "@paas/core";

const MAX_ENTRIES = 2_000;

interface AuditFile {
  entries: AuditEntry[];
}

export class AuditService {
  private readonly file: string;
  private entries: AuditEntry[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "audit.json");
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
    this.entries = this.entries.slice(-MAX_ENTRIES);
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
