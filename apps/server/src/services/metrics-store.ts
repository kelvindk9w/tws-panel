/**
 * metrics-store.ts — a série temporal em arquivos, no mesmo padrão do histórico
 * de envios do e-mail (um arquivo por período, JSON por linha, poda dos antigos
 * pelo NOME do arquivo).
 *
 *   data/metrics-min/AAAA-MM-DD.jsonl   uma amostra por minuto            (FORA do backup do painel)
 *   data/metrics/hour/AAAA-MM-DD.jsonl  um agregado por hora do dia       (entra no backup)
 *   data/metrics/day/AAAA-MM.jsonl      um agregado por dia do mês        (entra no backup)
 *
 * Datas em UTC. Gravação: cada linha é acrescentada ao fim do arquivo do
 * período, numa fila por arquivo; se uma queda de energia deixou a última linha
 * pela metade, a próxima gravação começa em linha nova (a linha rasgada é
 * descartada na leitura, as demais ficam). Leitura: linha que não é JSON, ou
 * que não tem a forma esperada, é ignorada; arquivo grande demais não é lido.
 *
 * Hora e dia são DERIVADOS do minuto (hora) e da hora (dia): quando um período
 * termina, o rollup o calcula a partir do que está no disco. Refazer é seguro
 * (um período que já tem agregado não é gravado de novo) e uma queda no meio não
 * perde nada além do que o disco já tinha perdido.
 */
import { appendFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { METRICS_DIRNAME, METRICS_MINUTE_DIRNAME, type MetricsRetention } from "@paas/core";
import { withFileLock } from "./json-file.js";
import { DAY, HOUR, mergeAggregates, periodStart, rollupSamples, type AggRecord, type Cell, type Sample } from "./metrics-series.js";

/** Arquivo maior que isto não é lido (um dia de minuto fica em dezenas de MB só com centenas de containers). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Linhas lidas por arquivo (um dia tem 1440 de minuto, 24 de hora, 31 de dia). */
export const MAX_FILE_LINES = 20_000;
/** Chaves de container: tamanho máximo. */
const MAX_KEY_LENGTH = 160;
/** Métricas por container numa linha. */
const MAX_METRICS_PER_KEY = 64;
/** Containers (e projetos) por linha. */
const MAX_KEYS_PER_LINE = 600;

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const safeKey = (k: string) => k !== "__proto__" && k.length > 0 && k.length <= MAX_KEY_LENGTH;

function cleanNumbers(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!safeKey(k) || !num(v)) continue;
    if (++count > MAX_METRICS_PER_KEY) break;
    out[k] = v;
  }
  return out;
}

function cleanCells(raw: unknown): Record<string, Cell> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, Cell> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!safeKey(k) || !Array.isArray(v) || v.length < 1 || v.length > 4 || !v.every(num)) continue;
    if (++count > MAX_METRICS_PER_KEY) break;
    out[k] = v as number[];
  }
  return out;
}

/** Linha de minuto → amostra; null se não tem a forma esperada. */
export function parseSampleLine(line: string): Sample | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !num(raw.t) || !Number.isInteger(raw.t) || raw.t < 0) return null;
  const h = cleanNumbers(raw.h ?? {});
  if (h === null || (raw.c !== undefined && !isRecord(raw.c))) return null;
  const c: Record<string, Record<string, number>> = {};
  let keys = 0;
  for (const [key, values] of Object.entries(isRecord(raw.c) ? raw.c : {})) {
    if (!safeKey(key)) continue;
    if (++keys > MAX_KEYS_PER_LINE) break;
    const clean = cleanNumbers(values);
    if (clean !== null) c[key] = clean;
  }
  return { t: raw.t, h, c };
}

/** Linha de hora ou dia → agregado; null se não tem a forma esperada. */
export function parseAggLine(line: string): AggRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !num(raw.t) || !Number.isInteger(raw.t) || raw.t < 0 || !num(raw.n) || raw.n < 0) return null;
  const h = cleanCells(raw.h ?? {});
  if (h === null || (raw.c !== undefined && !isRecord(raw.c))) return null;
  const c: Record<string, Record<string, Cell>> = {};
  let keys = 0;
  for (const [key, cells] of Object.entries(isRecord(raw.c) ? raw.c : {})) {
    if (!safeKey(key)) continue;
    if (++keys > MAX_KEYS_PER_LINE) break;
    const clean = cleanCells(cells);
    if (clean !== null) c[key] = clean;
  }
  return { t: raw.t, n: raw.n, h, c };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const dayName = (sec: number): string => {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const monthName = (sec: number): string => dayName(sec).slice(0, 7);

/** Início (epoch s) do dia `AAAA-MM-DD` ou do mês `AAAA-MM`; NaN se a data não existe. */
function periodStartOf(name: string): number {
  const t = Date.parse(name.length === 7 ? `${name}-01T00:00:00Z` : `${name}T00:00:00Z`);
  return Math.floor(t / 1000);
}

/** Fim (exclusivo) do mês que começa em `start`. */
function monthEnd(start: number): number {
  const d = new Date(start * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

export interface MetricsStoreDeps {
  dataDir: string;
  retention: () => MetricsRetention;
  log?: (message: string) => void;
}

export class MetricsStore {
  readonly minuteDir: string;
  readonly hourDir: string;
  readonly dayDir: string;
  private readonly log: (m: string) => void;
  /** Arquivos já conferidos neste processo (a última linha termina em quebra?). */
  private readonly healed = new Set<string>();
  /** Próxima hora e próximo dia a fechar (undefined/null = ainda não sabe: sem dado nenhum). */
  private hourCursor: number | null | undefined;
  private dayCursor: number | null | undefined;

  constructor(private readonly deps: MetricsStoreDeps) {
    this.minuteDir = path.join(deps.dataDir, METRICS_MINUTE_DIRNAME);
    this.hourDir = path.join(deps.dataDir, METRICS_DIRNAME, "hour");
    this.dayDir = path.join(deps.dataDir, METRICS_DIRNAME, "day");
    this.log = deps.log ?? (() => undefined);
  }

  // -- gravação -------------------------------------------------------------

  private async appendLine(file: string, line: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(file, async () => {
      let prefix = "";
      if (!this.healed.has(file)) {
        prefix = (await endsWithoutNewline(file)) ? "\n" : "";
        this.healed.add(file);
      }
      await appendFile(file, `${prefix}${line}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  async appendSample(sample: Sample): Promise<void> {
    await this.appendLine(path.join(this.minuteDir, `${dayName(sample.t)}.jsonl`), JSON.stringify(sample));
  }

  // -- leitura --------------------------------------------------------------

  private async readLines(file: string): Promise<string[]> {
    try {
      const st = await stat(file);
      if (!st.isFile()) return [];
      if (st.size > MAX_FILE_BYTES) {
        this.log(`métricas: ${path.basename(file)} passa de ${MAX_FILE_BYTES / 1024 / 1024} MiB e não foi lido`);
        return [];
      }
      const text = await readFile(file, "utf8");
      const lines: string[] = [];
      let at = 0;
      while (at < text.length && lines.length < MAX_FILE_LINES) {
        let nl = text.indexOf("\n", at);
        if (nl === -1) nl = text.length;
        if (nl > at) lines.push(text.slice(at, nl));
        at = nl + 1;
      }
      return lines;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log(`métricas: não consegui ler ${path.basename(file)} (${(err as NodeJS.ErrnoException).code ?? "erro"})`);
      return [];
    }
  }

  /** Amostras por minuto em [from, to] (epoch s), em ordem, sem repetir o mesmo instante (vale a última gravada). */
  async readSamples(from: number, to: number): Promise<Sample[]> {
    const byT = new Map<number, Sample>();
    for (let day = periodStart(from, DAY); day <= to; day += DAY) {
      for (const line of await this.readLines(path.join(this.minuteDir, `${dayName(day)}.jsonl`))) {
        const s = parseSampleLine(line);
        if (s && s.t >= from && s.t <= to) byT.set(s.t, s);
      }
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  /** Agregados de hora ou dia em [from, to], em ordem, sem repetir. */
  async readAggregates(resolution: "hour" | "day", from: number, to: number): Promise<AggRecord[]> {
    const byT = new Map<number, AggRecord>();
    const read = async (file: string) => {
      for (const line of await this.readLines(file)) {
        const r = parseAggLine(line);
        if (r && r.t >= from && r.t <= to) byT.set(r.t, r);
      }
    };
    if (resolution === "hour") {
      for (let day = periodStart(from, DAY); day <= to; day += DAY) await read(path.join(this.hourDir, `${dayName(day)}.jsonl`));
    } else {
      for (let start = periodStartOf(monthName(from)); start <= to; start = monthEnd(start)) {
        await read(path.join(this.dayDir, `${monthName(start)}.jsonl`));
      }
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  // -- rollup ---------------------------------------------------------------

  private async lastAggregateT(dir: string, pattern: RegExp): Promise<number | null> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => pattern.test(n)).sort();
    } catch {
      return null;
    }
    for (const name of names.reverse()) {
      let max: number | null = null;
      for (const line of await this.readLines(path.join(dir, name))) {
        const r = parseAggLine(line);
        if (r && (max === null || r.t > max)) max = r.t;
      }
      if (max !== null) return max;
    }
    return null;
  }

  /**
   * Fecha as horas e os dias que terminaram até `nowSec` (com 1 minuto de
   * folga, para a última amostra do período já estar no disco). Chamado a cada
   * coleta; só trabalha quando um período virou. No máximo `maxPeriods` por
   * chamada (depois de uma parada longa, termina nas chamadas seguintes).
   * O cursor avança também sobre períodos sem amostra (lacuna), para não
   * reler a mesma lacuna a cada minuto.
   */
  async rollup(nowSec: number, maxPeriods = 200): Promise<void> {
    const settled = nowSec - 60;
    const retention = this.deps.retention();

    if (this.hourCursor === undefined || this.hourCursor === null) {
      const last = await this.lastAggregateT(this.hourDir, DAY_FILE);
      this.hourCursor = last === null ? await this.firstMinuteHour(periodStart(nowSec - retention.minuteHours * HOUR, HOUR), settled) : last + HOUR;
    }
    if (this.hourCursor !== null) {
      let hour = Math.max(this.hourCursor, periodStart(nowSec - retention.minuteHours * HOUR, HOUR));
      for (let done = 0; hour + HOUR <= settled && done < maxPeriods; done++) {
        const agg = rollupSamples(await this.readSamples(hour, hour + HOUR - 1), hour);
        if (agg) await this.appendLine(path.join(this.hourDir, `${dayName(hour)}.jsonl`), JSON.stringify(agg));
        hour += HOUR;
      }
      this.hourCursor = hour;
    }

    if (this.dayCursor === undefined || this.dayCursor === null) {
      const last = await this.lastAggregateT(this.dayDir, MONTH_FILE);
      this.dayCursor = last === null ? await this.firstHourDay(periodStart(nowSec - retention.hourDays * DAY, DAY), settled) : last + DAY;
    }
    if (this.dayCursor !== null) {
      const hoursDone = this.hourCursor ?? Infinity;
      let day = Math.max(this.dayCursor, periodStart(nowSec - retention.hourDays * DAY, DAY));
      // o dia só fecha com todas as horas dele já fechadas
      for (let done = 0; day + DAY <= settled && hoursDone >= day + DAY && done < maxPeriods; done++) {
        const agg = mergeAggregates(await this.readAggregates("hour", day, day + DAY - 1), day);
        if (agg) await this.appendLine(path.join(this.dayDir, `${monthName(day)}.jsonl`), JSON.stringify(agg));
        day += DAY;
      }
      this.dayCursor = day;
    }
  }

  /** Primeira hora com amostra no disco (a partir de `from`), para o primeiro rollup. */
  private async firstMinuteHour(from: number, until: number): Promise<number | null> {
    let names: string[];
    try {
      names = (await readdir(this.minuteDir)).filter((n) => DAY_FILE.test(n)).sort();
    } catch {
      return null;
    }
    for (const name of names) {
      const start = periodStartOf(name.slice(0, 10));
      if (start + DAY <= from) continue;
      let min: number | null = null;
      for (const line of await this.readLines(path.join(this.minuteDir, name))) {
        const s = parseSampleLine(line);
        if (s && s.t >= from && s.t < until && (min === null || s.t < min)) min = s.t;
      }
      if (min !== null) return periodStart(min, HOUR);
    }
    return null;
  }

  private async firstHourDay(from: number, until: number): Promise<number | null> {
    let names: string[];
    try {
      names = (await readdir(this.hourDir)).filter((n) => DAY_FILE.test(n)).sort();
    } catch {
      return null;
    }
    for (const name of names) {
      const start = periodStartOf(name.slice(0, 10));
      if (start < from || start >= until) continue;
      if ((await this.readAggregates("hour", start, start + DAY - 1)).length > 0) return start;
    }
    return null;
  }

  // -- poda e uso -----------------------------------------------------------

  /** Apaga, pelo nome, os arquivos inteiramente mais velhos que a retenção. Devolve quantos. */
  async prune(nowSec: number): Promise<number> {
    const r = this.deps.retention();
    let removed = 0;
    const sweep = async (dir: string, pattern: RegExp, keepSeconds: number, endOf: (start: number) => number) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const m = pattern.exec(name);
        if (!m) continue;
        const start = periodStartOf(name.slice(0, -".jsonl".length));
        if (Number.isNaN(start)) continue;
        if (endOf(start) <= nowSec - keepSeconds) {
          await rm(path.join(dir, name), { force: true });
          this.healed.delete(path.join(dir, name));
          removed++;
        }
      }
    };
    await sweep(this.minuteDir, DAY_FILE, r.minuteHours * HOUR, (s) => s + DAY);
    await sweep(this.hourDir, DAY_FILE, r.hourDays * DAY, (s) => s + DAY);
    await sweep(this.dayDir, MONTH_FILE, r.dayDays * DAY, monthEnd);
    return removed;
  }

  /** Espaço ocupado, por resolução (soma do tamanho dos arquivos de período). */
  async usage(): Promise<{ minuteBytes: number; hourBytes: number; dayBytes: number }> {
    const size = async (dir: string, pattern: RegExp): Promise<number> => {
      let total = 0;
      try {
        for (const name of await readdir(dir)) {
          if (!pattern.test(name)) continue;
          total += (await stat(path.join(dir, name)).catch(() => null))?.size ?? 0;
        }
      } catch {
        // pasta ainda não existe
      }
      return total;
    };
    return {
      minuteBytes: await size(this.minuteDir, DAY_FILE),
      hourBytes: await size(this.hourDir, DAY_FILE),
      dayBytes: await size(this.dayDir, MONTH_FILE),
    };
  }
}

/** O arquivo existe, tem conteúdo e a última linha não terminou (queda no meio da gravação)? */
async function endsWithoutNewline(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
