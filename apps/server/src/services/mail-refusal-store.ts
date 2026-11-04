/**
 * mail-refusal-store.ts — guarda as tentativas de envio RECUSADAS antes da fila (senha errada, falha de TLS,
 * remetente não permitido...), lidas do registro do Stalwart (packages/mailer/src/refusal-log.ts).
 *
 * Limites (internet inteira tenta senha nas portas de e-mail; o disco e a memória não podem crescer com isso):
 *  - retenção em dias (padrão 30), um arquivo por dia e por classe: `p-AAAA-MM-DD-<projeto>` = tentativa DO APP de um
 *    projeto (veio da rede interna, login é a caixa dele), `i-…` = interna sem projeto, `x-…` = de fora/desconhecida;
 *  - tetos por dia e por classe: 300 por PROJETO, 300 internas sem projeto, 300 de fora. Assim uma onda de força bruta
 *    pela internet (ou contra um só projeto) não apaga o aviso dos outros projetos;
 *  - um mesmo tipo + login no mesmo minuto vale uma linha só;
 *  - a leitura devolve no máximo `limit` (≤ 200) itens e conta o total.
 * Só tipo, hora, login e projeto: nunca IP, senha ou texto do cliente.
 */
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { MailRefusal } from "@paas/core";

const DAY = 86_400_000;
const FILE = /^([pix])-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9_-]{1,64}))?\.jsonl$/;

export interface MailRefusalStoreOptions {
  dir: string;
  now?: () => number;
  retentionDays?: number;
  /** Teto por dia e por projeto. */
  maxProjectPerDay?: number;
  /** Teto por dia das internas sem projeto e das de fora (cada classe). */
  maxOtherPerDay?: number;
}

export interface RefusalQuery {
  /** Só tentativas DO APP deste projeto; ausente = tudo (de projeto, internas e de fora). */
  projectId?: string;
  /** "app" = vindas da rede interna (apps e painel); "external" = da internet ou sem endereço. Ausente = tudo. */
  scope?: "app" | "external";
  limit?: number;
}

export class MailRefusalStore {
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly caps: { p: number; other: number };

  constructor(private readonly opts: MailRefusalStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.retentionDays = opts.retentionDays ?? 30;
    this.caps = { p: opts.maxProjectPerDay ?? 300, other: opts.maxOtherPerDay ?? 300 };
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
      const key = fileName(item);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [name, group] of groups) {
      const file = path.join(this.opts.dir, name);
      const existing = await this.readFileItems(file);
      const seen = new Set(existing.map(minuteKey));
      const room = (name[0] === "p" ? this.caps.p : this.caps.other) - existing.length;
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
        if (typeof item.at === "string" && typeof item.kind === "string") out.push({ ...item, origin: item.origin ?? "unknown" });
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
      if (query.scope === "app" && m[1] === "x") continue;
      if (query.scope === "external" && m[1] !== "x") continue;
      if (query.projectId !== undefined && (m[1] !== "p" || m[3] !== safeId(query.projectId))) continue;
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

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Classe da tentativa: do app de um projeto (interna + caixa de projeto), interna sem projeto, ou de fora. */
function fileName(item: MailRefusal): string {
  const day = item.at.slice(0, 10);
  if (item.origin === "internal" && item.projectId) return `p-${day}-${safeId(item.projectId)}.jsonl`;
  return `${item.origin === "internal" ? "i" : "x"}-${day}.jsonl`;
}

function minuteKey(item: MailRefusal): string {
  return `${item.kind}|${item.login ?? ""}|${item.projectId ?? ""}|${item.at.slice(0, 16)}`;
}
