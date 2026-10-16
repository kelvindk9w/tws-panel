/**
 * host-timezone.ts — o fuso horário da VPS dentro do container do painel.
 *
 * Por quê: os backups agendados rodam às 03:00 NO HORÁRIO DA VPS. O
 * container nasce em UTC e montar /etc/localtime por cima não basta: o Node
 * (ICU) só reconhece o fuso pelo nome (TZ) ou por um link simbólico, e a
 * montagem do Docker entrega um arquivo comum.
 *
 * Como: o docker-compose.yml monta o /etc/localtime do host em
 * /host/etc/localtime (somente leitura). Na subida, se ninguém definiu TZ,
 * procuramos em /usr/share/zoneinfo do container o arquivo de conteúdo igual
 * (o nome dele é o fuso, ex.: America/Sao_Paulo). Se as versões do tzdata do
 * host e do container forem diferentes, usamos o rodapé do arquivo (regra
 * POSIX): deslocamento fixo vira Etc/GMT±N; com horário de verão não dá para
 * adivinhar o nome e ficamos em UTC (a tela mostra o fuso usado).
 *
 * Limite da montagem (visto na VPS do dono, 15/10/2026): `timedatectl
 * set-timezone` troca o LINK /etc/localtime, e a montagem de arquivo do
 * Docker continua presa ao arquivo antigo até recriar o container (restart
 * não basta). Por isso, desde Configurações → Fuso horário, o fuso também é
 * lido da VPS pelo host bridge (timezone-service.ts) e guardado em
 * data/timezone.json, que vale na subida seguinte antes desta montagem.
 */
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeTimezoneName, type TimezoneSource } from "@paas/core";

export const HOST_LOCALTIME = "/host/etc/localtime";
export const ZONEINFO_DIR = "/usr/share/zoneinfo";

/** Pastas do zoneinfo que repetem os fusos com outro formato. */
const SKIP_DIRS = new Set(["posix", "right", "Etc", "SystemV"]);
/** Nomes antigos (aliases) que só valem se não houver um canônico. */
const LEGACY_PREFIXES = ["Brazil/", "US/", "Canada/", "Mexico/", "Chile/"];

async function listZoneFiles(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && SKIP_DIRS.has(e.name)) continue;
      out.push(...(await listZoneFiles(dir, name)));
    } else if (e.isFile() && /^[A-Z]/.test(e.name)) {
      out.push(name);
    }
  }
  return out;
}

function rank(name: string): number {
  if (LEGACY_PREFIXES.some((p) => name.startsWith(p))) return 2;
  return name.includes("/") ? 0 : 1;
}

/** Rodapé POSIX de deslocamento fixo ("<-03>3", "UTC0") → nome do fuso. */
function fromFooter(content: Buffer): string | null {
  const lines = content.toString("latin1").split("\n");
  const footer = lines.at(-2) ?? "";
  if (/^UTC0$|^GMT0$/.test(footer)) return "UTC";
  const m = /^(?:<[^>]+>|[A-Za-z]{3,})(-?\d{1,2})$/.exec(footer);
  if (!m) return null;
  const hours = Number(m[1]);
  if (hours === 0) return "UTC";
  // POSIX conta para o oeste (+3 = UTC−3) — mesmo sinal do Etc/GMT+3.
  return `Etc/GMT${hours > 0 ? "+" : "-"}${Math.abs(hours)}`;
}

export async function detectHostTimezone(localtime = HOST_LOCALTIME, zoneinfo = ZONEINFO_DIR): Promise<string | null> {
  let host: Buffer;
  try {
    host = await readFile(localtime);
  } catch {
    return null;
  }
  if (!host.subarray(0, 4).equals(Buffer.from("TZif"))) return null;
  const candidates = (await listZoneFiles(zoneinfo)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of candidates) {
    const content = await readFile(path.join(zoneinfo, name)).catch(() => null);
    if (content && content.equals(host)) return name;
  }
  return fromFooter(host);
}

// ---------------------------------------------------------------------------
// Fuso na subida do painel (Configurações → Fuso horário)
// ---------------------------------------------------------------------------

/** Último fuso lido da VPS pelo host bridge (data/timezone.json). */
export const TIMEZONE_STATE_FILE = "timezone.json";

export interface SavedTimezone {
  zone: string;
  readAt: string;
}

export async function readSavedTimezone(dataDir: string): Promise<SavedTimezone | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir, TIMEZONE_STATE_FILE), "utf8")) as Partial<SavedTimezone>;
    if (typeof raw.zone !== "string" || !isSafeTimezoneName(raw.zone)) return null;
    return { zone: raw.zone, readAt: typeof raw.readAt === "string" ? raw.readAt : new Date(0).toISOString() };
  } catch {
    return null;
  }
}

export async function writeSavedTimezone(dataDir: string, saved: SavedTimezone): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, TIMEZONE_STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(saved, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export interface StartupTimezone {
  /** Fuso em uso depois da subida (null = nenhum: o Node fica em UTC). */
  zone: string | null;
  source: TimezoneSource;
  /** TZ que já vinha no ambiente (o .env do painel). */
  envOverride: string | null;
}

/**
 * Escolhe o fuso na subida, antes de qualquer serviço ler a hora:
 *  1. TZ no ambiente (.env do painel) — o operador mandou;
 *  2. o último lido da VPS pelo host bridge (data/timezone.json);
 *  3. o /host/etc/localtime montado — pode estar congelado (a montagem fica
 *     presa ao arquivo antigo quando o timedatectl troca o link), por isso
 *     o painel lê de novo pelo host bridge logo depois de subir.
 */
export async function resolveStartupTimezone(opts: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  localtime?: string;
  zoneinfo?: string;
}): Promise<StartupTimezone> {
  const env = opts.env ?? process.env;
  if (env.TZ) return { zone: env.TZ, source: "env", envOverride: env.TZ };
  const saved = await readSavedTimezone(opts.dataDir);
  if (saved) {
    env.TZ = saved.zone;
    return { zone: saved.zone, source: "saved", envOverride: null };
  }
  const detected = await detectHostTimezone(opts.localtime ?? HOST_LOCALTIME, opts.zoneinfo ?? ZONEINFO_DIR);
  if (detected) {
    env.TZ = detected;
    return { zone: detected, source: "localtime", envOverride: null };
  }
  return { zone: null, source: "default", envOverride: null };
}

let startup: StartupTimezone | null = null;

/** index.ts guarda o que decidiu na subida; o TimezoneService lê. */
export function rememberStartupTimezone(value: StartupTimezone): void {
  startup = value;
}

export function startupTimezone(env: NodeJS.ProcessEnv = process.env): StartupTimezone {
  if (startup) return startup;
  // Sem index.ts (testes, buildApp direto): o TZ do ambiente, se houver.
  return env.TZ ? { zone: env.TZ, source: "env", envOverride: env.TZ } : { zone: null, source: "default", envOverride: null };
}

/** Define TZ com o fuso da VPS, se ninguém definiu antes. Devolve o fuso em uso. */
export async function applyHostTimezone(
  env: NodeJS.ProcessEnv = process.env,
  localtime = HOST_LOCALTIME,
  zoneinfo = ZONEINFO_DIR,
): Promise<string | null> {
  if (env.TZ) return env.TZ;
  const tz = await detectHostTimezone(localtime, zoneinfo);
  if (tz) env.TZ = tz;
  return tz;
}
