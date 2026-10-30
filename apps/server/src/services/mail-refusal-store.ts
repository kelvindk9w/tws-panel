/**
 * mail-refusal-store.ts — guarda as tentativas de envio RECUSADAS antes da fila (senha errada, falha de TLS,
 * remetente não permitido...), lidas do registro do Stalwart (packages/mailer/src/refusal-log.ts).
 *
 * Limites (internet inteira tenta senha nas portas de e-mail; o disco e a memória não podem crescer com isso):
 *  - retenção em dias (padrão 30), um arquivo por dia (`p-AAAA-MM-DD.jsonl` = de projeto, `x-…` = de fora);
 *  - tetos DIFERENTES por dia: de projeto (login é a caixa de um projeto) 1000; de fora 300. Assim uma onda de
 *    força bruta contra logins aleatórios não apaga o aviso de um projeto de verdade;
 *  - um mesmo tipo + login no mesmo minuto vale uma linha só;
 *  - a leitura devolve no máximo `limit` (≤ 200) itens e conta o total.
 * Só tipo, hora, login e projeto: nunca IP, senha ou texto do cliente.
 */
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { MailRefusal } from "@paas/core";

const DAY = 86_400_000;
const FILE = /^([px])-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface MailRefusalStoreOptions {
  dir: string;
  now?: () => number;
  retentionDays?: number;
  maxProjectPerDay?: number;
  maxExternalPerDay?: number;
}

export interface RefusalQuery {
  /** Só deste projeto; ausente = tudo (de projeto e de fora). */
  projectId?: string;
  limit?: number;
}

export class MailRefusalStore {
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly caps: { p: number; x: number };

  constructor(private readonly opts: MailRefusalStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.retentionDays = opts.retentionDays ?? 30;
    this.caps = { p: opts.maxProjectPerDay ?? 1000, x: opts.maxExternalPerDay ?? 300 };
  }

  get retention(): number {
    return this.retentionDays;
  }

  /** Grava as recusas novas respeitando os tetos do dia. Nunca grava duas iguais no mesmo minuto. */
  async append(items: MailRefusal[]): Promise<void> {
    if (items.length === 0) return;
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    const oldest = this.now() - this.retentionDays * DAY;
    const groups = new Map<string, MailRefusal[]>();
    for (const item of items) {
      if (Date.parse(item.at) < oldest) continue;
      const key = `${item.projectId ? "p" : "x"}-${item.at.slice(0, 10)}.jsonl`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [name, group] of groups) {
      const file = path.join(this.opts.dir, name);
      const existing = await this.readFileItems(file);
      const seen = new Set(existing.map(minuteKey));
      const room = this.caps[name[0] as "p" | "x"] - existing.length;
      const fresh: MailRefusal[] = [];
      for (const item of group) {
        const k = minuteKey(item);
        if (seen.has(k) || fresh.length >= room) continue;
        seen.add(k);
        fresh.push(item);
      }
      if (fresh.length > 0) {
        await appendFile(file, fresh.map((i) => JSON.stringify(i)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      }
    }
    await this.prune();
  }

  private async readFileItems(file: string): Promise<MailRefusal[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const out: MailRefusal[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      try {
        const item = JSON.parse(line) as MailRefusal;
        if (typeof item.at === "string" && typeof item.kind === "string") out.push(item);
      } catch {
        // linha corrompida: ignora
      }
    }
    return out;
  }

  /** Recusas da retenção, mais recentes primeiro. */
  async list(query: RefusalQuery = {}): Promise<{ items: MailRefusal[]; total: number }> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return { items: [], total: 0 };
    }
    const sinceDay = new Date(this.now() - this.retentionDays * DAY).toISOString().slice(0, 10);
    const all: MailRefusal[] = [];
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m || m[2]! < sinceDay) continue;
      if (query.projectId !== undefined && m[1] !== "p") continue;
      for (const item of await this.readFileItems(path.join(this.opts.dir, name))) {
        if (query.projectId === undefined || item.projectId === query.projectId) all.push(item);
      }
    }
    all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return { items: all.slice(0, limit), total: all.length };
  }

  /** Apaga os dias além da retenção. */
  async prune(): Promise<void> {
    const cutoff = new Date(this.now() - this.retentionDays * DAY).toISOString().slice(0, 10);
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = FILE.exec(name);
      if (m && m[2]! < cutoff) await rm(path.join(this.opts.dir, name), { force: true });
    }
  }
}

function minuteKey(item: MailRefusal): string {
  return `${item.kind}|${item.login ?? ""}|${item.projectId ?? ""}|${item.at.slice(0, 16)}`;
}
