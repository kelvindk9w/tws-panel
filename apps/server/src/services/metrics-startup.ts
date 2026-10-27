/**
 * metrics-startup.ts — tempo de subida: do início do container até ele estar pronto.
 *
 * "Pronto" é, na ordem do que existir:
 *  1. container com verificação de saúde (HEALTHCHECK): a primeira verificação que passou. O Docker guarda
 *     as últimas verificações no inspect; se a primeira bem-sucedida ainda está lá, o horário é exato.
 *     Se já saiu do registro, vale a volta em que o painel notou (aproximado, até 1 minuto a mais);
 *  2. sem verificação de saúde: a primeira volta em que o processo principal tem uma porta aberta (LISTEN),
 *     lida do /proc do host. Sempre aproximado (precisão de uma volta);
 *  3. nenhuma das duas (worker sem porta, sem /proc montado): não se mede. Nada é inventado.
 *
 * Só se acompanha container que começou há pouco (15 min): ao subir, o painel não "mede" o que já rodava.
 * O que ficou doente (unhealthy) ou nunca ficou pronto dentro da janela é abandonado, sem registro.
 * Os registros ficam em data/metrics-startups.json (os mais novos de cada projeto, com teto geral).
 */
import path from "node:path";
import type { StartupRecord } from "@paas/core";
import { JsonFile } from "./json-file.js";

/** Janela em que um container recém-iniciado ainda é acompanhado até ficar pronto. */
export const STARTUP_TRACK_SECONDS = 15 * 60;
export const STARTUP_PER_PROJECT = 40;
export const STARTUP_TOTAL = 400;

export interface StartupObservation {
  id: string;
  slug: string;
  service: string;
  state: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  startedAt: string | null;
  /** Fim da primeira verificação de saúde que passou (inspect); null = não consta. */
  healthyAt: string | null;
  /** Há porta aberta? Só é chamada quando não há verificação de saúde. null = não deu para ler. */
  listening: () => Promise<boolean | null>;
}

export interface StartupSink {
  observe(o: StartupObservation, nowMs: number): Promise<void>;
  retain(ids: ReadonlySet<string>): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function validRecord(v: unknown): v is StartupRecord {
  return (
    isRecord(v) &&
    typeof v.slug === "string" &&
    typeof v.service === "string" &&
    typeof v.startedAt === "string" &&
    typeof v.readyAt === "string" &&
    typeof v.seconds === "number" &&
    Number.isFinite(v.seconds) &&
    (v.via === "health" || v.via === "port") &&
    typeof v.approx === "boolean"
  );
}

export class StartupTracker implements StartupSink {
  private records: StartupRecord[] = [];
  /** id → início já resolvido (medido ou abandonado): não se mede duas vezes o mesmo início. */
  private readonly settled = new Map<string, string>();
  private readonly file: JsonFile<StartupRecord[]>;

  constructor(
    dataDir: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.file = new JsonFile<StartupRecord[]>(path.join(dataDir, "metrics-startups.json"), {
      empty: () => [],
      parse: (raw) => {
        const list = isRecord(raw) ? raw.records : null;
        return Array.isArray(list) ? list.filter(validRecord) : null;
      },
      serialize: (value) => JSON.stringify({ records: value }, null, 2) + "\n",
    });
  }

  async load(): Promise<void> {
    try {
      this.records = await this.file.read();
    } catch {
      this.records = [];
    }
  }

  /** Registros de um projeto, do mais novo para o mais velho. */
  list(slug: string, limit = 20): StartupRecord[] {
    return this.records
      .filter((r) => r.slug === slug)
      .sort((a, b) => b.readyAt.localeCompare(a.readyAt))
      .slice(0, limit);
  }

  /** Esquece containers que não existem mais. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.settled.keys()) if (!ids.has(id)) this.settled.delete(id);
  }

  async observe(o: StartupObservation, nowMs: number): Promise<void> {
    if (o.state !== "running" || o.startedAt === null) return;
    if (this.settled.get(o.id) === o.startedAt) return;
    const startedMs = Date.parse(o.startedAt);
    if (!Number.isFinite(startedMs)) return;
    // já rodava há muito tempo (o painel acabou de subir, ou o container é antigo): não há o que medir
    if (nowMs - startedMs > STARTUP_TRACK_SECONDS * 1000) {
      this.settled.set(o.id, o.startedAt);
      return;
    }
    let readyMs: number | null = null;
    let via: StartupRecord["via"] = "health";
    let approx = true;
    if (o.health === "unhealthy") {
      this.settled.set(o.id, o.startedAt);
      return;
    }
    if (o.health === "healthy") {
      const exact = o.healthyAt !== null ? Date.parse(o.healthyAt) : Number.NaN;
      if (Number.isFinite(exact) && exact >= startedMs && exact <= nowMs) {
        readyMs = exact;
        approx = false;
      } else {
        readyMs = nowMs;
      }
    } else if (o.health === null) {
      via = "port";
      const open = await o.listening();
      if (open === null) {
        this.settled.set(o.id, o.startedAt); // sem como medir este container
        return;
      }
      if (open) readyMs = nowMs;
    }
    // health "starting" (ou porta ainda fechada): continua acompanhando até a janela acabar
    if (readyMs === null) return;
    this.settled.set(o.id, o.startedAt);
    await this.add({
      slug: o.slug,
      service: o.service,
      startedAt: o.startedAt,
      readyAt: new Date(readyMs).toISOString(),
      seconds: Math.round(Math.max(0, (readyMs - startedMs) / 1000) * 10) / 10,
      via,
      approx,
    });
  }

  private async add(r: StartupRecord): Promise<void> {
    const next = [...this.records, r];
    const perProject = new Map<string, number>();
    const kept: StartupRecord[] = [];
    // do mais novo para o mais velho, respeitando o teto de cada projeto e o geral
    for (const x of next.sort((a, b) => b.readyAt.localeCompare(a.readyAt))) {
      const n = perProject.get(x.slug) ?? 0;
      if (n >= STARTUP_PER_PROJECT || kept.length >= STARTUP_TOTAL) continue;
      perProject.set(x.slug, n + 1);
      kept.push(x);
    }
    this.records = kept;
    try {
      await this.file.update(() => kept);
    } catch (err) {
      this.log(`métricas: tempos de subida não gravados (${(err as NodeJS.ErrnoException).code ?? "erro"})`);
    }
  }
}
