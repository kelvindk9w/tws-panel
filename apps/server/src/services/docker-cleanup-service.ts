/**
 * docker-cleanup-service.ts — verificador e limpeza do Docker (cache de build e imagens sem uso antigas).
 *
 * - Verificador: só lê. Roda quando a pessoa pede e sozinho a cada 6 h (para o aviso). Guarda a última verificação.
 * - Limpeza: manual ("Limpar agora") ou automática (DESLIGADA por padrão: por frequência e/ou por uso do disco).
 *   Remove o cache de build parado há mais que a idade mínima e, imagem a imagem pela lista calculada
 *   (docker-cleanup-plan.ts), as imagens sem container que não são do painel. Nunca toca em volumes nem containers.
 * - Não roda com deploy em andamento, com backup/restauração em andamento nem com outra limpeza no ar; um deploy
 *   ou backup que começa no meio interrompe o resto (conferido antes do cache e antes de cada imagem).
 * - "Limpar agora" só remove o que a pessoa viu e confirmou: a lista é recalculada na hora e cruzada com a
 *   confirmada (o que apareceu depois fica para a próxima; o que passou a ser usado sai da lista sozinho).
 * - Imagem é removida pelo id (que não muda); um nome a mais só é retirado se ainda aponta para ela.
 * - Cada limpeza vira um registro (quando, quem, quanto liberou, o que saiu), guardado em data/docker-cleanup.json.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  DOCKER_CLEANUP_DEFAULTS,
  DOCKER_CLEANUP_FREQUENCY_DAYS,
  DOCKER_CLEANUP_LIMITS,
  dockerCleanupWarns,
  validateDockerCleanupSettings,
  type DockerCleanupBlock,
  type DockerCleanupDisk,
  type DockerCleanupImage,
  type DockerCleanupRecord,
  type DockerCleanupResult,
  type DockerCleanupScan,
  type DockerCleanupSettings,
  type DockerCleanupState,
  type DockerCleanupTrigger,
} from "@paas/core";
import { JsonFile } from "./json-file.js";
import { buildScan } from "./docker-cleanup-plan.js";
import type { DockerCleanupApi } from "./docker-cleanup-docker.js";
import type { NotificationEvent } from "./notification-service.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** O que a pessoa vê de histórico. */
export const HISTORY_LIMIT = 30;
const REMOVED_NAMES_LIMIT = 200;
const SCAN_EVERY_MS = 6 * HOUR_MS;
/** Depois de uma tentativa por uso do disco, só tenta de novo daqui a tanto (evita laço se a limpeza não adianta). */
const DISK_COOLDOWN_MS = 6 * HOUR_MS;
const WARN_EVERY_MS = DAY_MS;

interface Stored {
  settings: DockerCleanupSettings;
  lastScan: DockerCleanupScan | null;
  history: DockerCleanupRecord[];
  /** De quando a agenda conta (ligar a limpeza ou a última automática). */
  scheduleBase: number | null;
  lastDiskAttemptAt: number | null;
  lastWarnedAt: number | null;
}

const emptyStored = (): Stored => ({ settings: { ...DOCKER_CLEANUP_DEFAULTS }, lastScan: null, history: [], scheduleBase: null, lastDiskAttemptAt: null, lastWarnedAt: null });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Última verificação com a forma que a tela usa; qualquer coisa estranha = sem verificação (a próxima refaz). */
function parseScan(v: unknown): DockerCleanupScan | null {
  if (!isObj(v) || typeof v.scannedAt !== "string" || !Number.isFinite(Date.parse(v.scannedAt))) return null;
  if (typeof v.totalBytes !== "number" || typeof v.minAgeDays !== "number" || !isObj(v.buildCache) || !isObj(v.images)) return null;
  if (!Array.isArray(v.images.candidates) || !Array.isArray(v.images.protected)) return null;
  return v as unknown as DockerCleanupScan;
}

const isRecord = (v: unknown): v is DockerCleanupRecord =>
  isObj(v) && typeof v.id === "string" && typeof v.at === "string" && typeof v.freedBytes === "number" && Array.isArray(v.removedImages) && Array.isArray(v.errors);

function parseStored(raw: unknown): Stored | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Partial<Stored>;
  const s = validateDockerCleanupSettings(r.settings ?? {});
  return {
    settings: s.ok ? s.value : { ...DOCKER_CLEANUP_DEFAULTS },
    lastScan: parseScan(r.lastScan),
    history: Array.isArray(r.history) ? r.history.filter(isRecord).slice(0, HISTORY_LIMIT) : [],
    scheduleBase: typeof r.scheduleBase === "number" ? r.scheduleBase : null,
    lastDiskAttemptAt: typeof r.lastDiskAttemptAt === "number" ? r.lastDiskAttemptAt : null,
    lastWarnedAt: typeof r.lastWarnedAt === "number" ? r.lastWarnedAt : null,
  };
}

/** O que a pessoa viu e confirmou em "Limpar agora". */
export interface DockerCleanupConfirmed {
  /** Ids das imagens da lista mostrada. */
  imageIds: ReadonlySet<string>;
  /** A lista mostrava cache de build para limpar. */
  buildCache: boolean;
  /** Idade mínima da verificação mostrada. */
  minAgeDays: number;
}

/** A limpeza não pode rodar agora (o motivo vai em `reason`). */
export class DockerCleanupBlockedError extends Error {
  constructor(readonly reason: DockerCleanupBlock) {
    super(reason);
    this.name = "DockerCleanupBlockedError";
  }
}

export interface DockerCleanupDeps {
  dataDir: string;
  api: DockerCleanupApi;
  /** Espaço do disco de dados. */
  statfs: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
  /** Há deploy rodando ou na fila? */
  deployBusy: () => boolean;
  /** Há backup/restauração rodando ou na fila? */
  backupBusy: () => boolean;
  notify?: (event: NotificationEvent) => Promise<void> | void;
  /** Registra na Auditoria as limpezas automáticas (a manual é auditada pela rota, com o nome da pessoa). */
  audit?: (detail: string) => Promise<void> | void;
  log?: (message: string) => void;
  now?: () => number;
}

export class DockerCleanupService {
  private readonly file: JsonFile<Stored>;
  private data: Stored = emptyStored();
  private working = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DockerCleanupDeps) {
    this.now = deps.now ?? Date.now;
    this.file = new JsonFile<Stored>(path.join(deps.dataDir, "docker-cleanup.json"), { empty: emptyStored, parse: parseStored });
  }

  async load(): Promise<void> {
    try {
      this.data = await this.file.read();
    } catch (err) {
      this.deps.log?.(`limpeza do Docker: configuração ilegível, seguindo com o padrão (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Começa a conferência periódica (a cada 15 min; o primeiro giro espera o painel assentar). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 15 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  settings(): DockerCleanupSettings {
    return { ...this.data.settings };
  }

  private blockReason(): DockerCleanupBlock | null {
    if (this.working) return "cleaning";
    if (this.deps.deployBusy()) return "deploy";
    if (this.deps.backupBusy()) return "backup";
    return null;
  }

  private nextRunAt(): string | null {
    const s = this.data.settings;
    if (!s.enabled || this.data.scheduleBase === null) return null;
    return new Date(this.data.scheduleBase + DOCKER_CLEANUP_FREQUENCY_DAYS[s.frequency] * DAY_MS).toISOString();
  }

  state(): DockerCleanupState {
    return {
      settings: this.settings(),
      defaults: { ...DOCKER_CLEANUP_DEFAULTS },
      limits: DOCKER_CLEANUP_LIMITS,
      lastScan: this.data.lastScan,
      working: this.working,
      blocked: this.blockReason(),
      warning: dockerCleanupWarns(this.data.lastScan, this.data.settings),
      nextRunAt: this.nextRunAt(),
      history: this.data.history,
    };
  }

  /** Grava as configurações (já validadas). Ligar a limpeza começa a contar a agenda a partir de agora. */
  async updateSettings(next: DockerCleanupSettings): Promise<DockerCleanupState> {
    const turnedOn = next.enabled && !this.data.settings.enabled;
    const updated = await this.file.update((cur) => ({ ...cur, settings: { ...next }, scheduleBase: turnedOn ? this.now() : next.enabled ? cur.scheduleBase : null }));
    this.data = updated;
    return this.state();
  }

  private async persist(change: (cur: Stored) => Stored): Promise<void> {
    this.data = await this.file.update(change);
  }

  private async diskNow(): Promise<DockerCleanupDisk | null> {
    try {
      const st = await this.deps.statfs(this.deps.dataDir);
      const total = st.blocks * st.bsize;
      if (total <= 0) return null;
      const used = total - st.bavail * st.bsize;
      return { totalBytes: total, usedBytes: used, usedPercent: Math.round((used / total) * 1000) / 10 };
    } catch {
      return null;
    }
  }

  private async compute(minAgeDays = this.data.settings.minAgeDays): Promise<DockerCleanupScan | null> {
    const [df, used] = await Promise.all([this.deps.api.df(), this.deps.api.usedImageIds()]);
    if (!df || !used) return null;
    return buildScan({ now: this.now(), minAgeDays, images: df.images, cache: df.cache, usedImageIds: used, disk: await this.diskNow() });
  }

  /**
   * Remove uma imagem da lista. Pelo id, que não muda: um nome (`paas-x:latest`) pode ter sido regravado para uma
   * imagem nova entre a verificação e agora, e apagar pelo nome levaria a nova. Com vários nomes o Docker recusa
   * apagar pelo id sem force; então cada nome a mais é retirado antes, só se ainda aponta para esta imagem.
   */
  private async removeOne(img: DockerCleanupImage): Promise<string | null> {
    const api = this.deps.api;
    const label = img.tags[0] ?? img.id;
    for (const tag of img.tags.slice(0, -1)) {
      if ((await api.imageIdOf(tag)) !== img.id) continue; // o nome já não é desta imagem: fica com quem tem
      const r = await api.removeImage(tag);
      if (!r.ok) return `${tag}: ${r.message}`;
    }
    const r = await api.removeImage(img.id);
    return r.ok ? null : `${label}: ${r.message}`;
  }

  /** Verificador (só leitura). Devolve null se o Docker não respondeu. */
  async scan(): Promise<DockerCleanupScan | null> {
    if (this.working) throw new DockerCleanupBlockedError("cleaning");
    this.working = true;
    try {
      const scan = await this.compute();
      if (!scan) return null;
      await this.persist((cur) => ({ ...cur, lastScan: scan }));
      await this.maybeWarn(scan);
      return scan;
    } finally {
      this.working = false;
    }
  }

  private async maybeWarn(scan: DockerCleanupScan): Promise<void> {
    if (!this.deps.notify || !dockerCleanupWarns(scan, this.data.settings)) return;
    const now = this.now();
    if (this.data.lastWarnedAt !== null && now - this.data.lastWarnedAt < WARN_EVERY_MS) return;
    await this.persist((cur) => ({ ...cur, lastWarnedAt: now }));
    const gb = Math.round((scan.totalBytes / 1024 ** 3) * 10) / 10;
    const lines = [`Cache de build e imagens sem uso há mais de ${scan.minAgeDays} dias somam ${gb} GB que podem ser liberados.`];
    if (scan.disk) lines.push(`O disco está com ${scan.disk.usedPercent}% de uso.`);
    lines.push("Veja a lista e limpe em Configurações → Limpeza do Docker.");
    try {
      await this.deps.notify({ kind: "disk", key: "docker-cleanup", title: `Dá para liberar ${gb} GB no disco da VPS`, body: lines, path: "/settings/docker-cleanup" });
    } catch {
      // aviso é best-effort
    }
  }

  /**
   * Limpa agora. `trigger` manual vem da tela; os outros, da agenda. Lança DockerCleanupBlockedError se travada
   * e devolve null se o Docker não respondeu. Registra a limpeza no histórico.
   */
  async run(trigger: DockerCleanupTrigger, actor: string, confirmed?: DockerCleanupConfirmed): Promise<DockerCleanupRecord | null> {
    const blocked = this.blockReason();
    if (blocked) throw new DockerCleanupBlockedError(blocked);
    this.working = true;
    try {
      // Confirmada pela pessoa: vale a idade mínima mais exigente entre a que ela viu e a configurada agora.
      const minAgeDays = confirmed ? Math.max(confirmed.minAgeDays, this.data.settings.minAgeDays) : this.data.settings.minAgeDays;
      const scan = await this.compute(minAgeDays);
      if (!scan) return null;
      // Só o que estava na lista confirmada e continua candidato agora (a interseção das duas).
      const candidates = confirmed ? scan.images.candidates.filter((c) => confirmed.imageIds.has(c.id)) : scan.images.candidates;
      const pruneCache = scan.buildCache.entries > 0 && (!confirmed || confirmed.buildCache);
      const errors: string[] = [];
      const removed: string[] = [];
      let cacheBytes = 0;
      let imagesBytes = 0;
      let stoppedEarly = false;
      // Um deploy ou backup que começou no meio da limpeza: para por aqui, o resto fica para a próxima.
      const interrupted = (): boolean => {
        if (!this.deps.deployBusy() && !this.deps.backupBusy()) return false;
        stoppedEarly = true;
        errors.push("Interrompida: um deploy, backup ou restauração começou durante a limpeza.");
        return true;
      };

      if (pruneCache && !interrupted()) {
        try {
          cacheBytes = await this.deps.api.pruneBuildCache(scan.minAgeDays * 24);
        } catch (err) {
          errors.push(`Cache de build: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const img of stoppedEarly ? [] : candidates) {
        if (interrupted()) break;
        const failed = await this.removeOne(img);
        if (failed) {
          errors.push(failed);
          continue;
        }
        imagesBytes += img.bytes;
        if (removed.length < REMOVED_NAMES_LIMIT) removed.push(img.tags[0] ?? img.id.replace(/^sha256:/, "").slice(0, 12));
      }
      const nothing = !pruneCache && candidates.length === 0;
      const result: DockerCleanupResult = errors.length === 0 ? "success" : removed.length > 0 || cacheBytes > 0 ? "partial" : "failed";
      const record: DockerCleanupRecord = {
        id: randomBytes(6).toString("hex"),
        at: new Date(this.now()).toISOString(),
        trigger,
        actor,
        result,
        minAgeDays: scan.minAgeDays,
        buildCacheBytes: cacheBytes,
        imagesBytes,
        freedBytes: cacheBytes + imagesBytes,
        removedImages: removed,
        errors: errors.slice(0, 20),
      };
      const after = await this.compute().catch(() => null);
      const base = this.now();
      const skipHistory = nothing && trigger === "disk" && !stoppedEarly;
      await this.persist((cur) => ({
        ...cur,
        history: skipHistory ? cur.history : [record, ...cur.history].slice(0, HISTORY_LIMIT),
        lastScan: after ?? cur.lastScan,
        scheduleBase: trigger === "schedule" ? base : cur.scheduleBase,
      }));
      if (trigger !== "manual" && !skipHistory && this.deps.audit) {
        const gb = Math.round((record.freedBytes / 1024 ** 3) * 10) / 10;
        try {
          await this.deps.audit(
            `Limpeza do Docker (automática, ${trigger === "schedule" ? "agenda" : "disco cheio"}): ${gb} GB liberados, ${removed.length} imagem(ns) removida(s)${errors.length > 0 ? `, ${errors.length} falha(s)` : ""}.`,
          );
        } catch {
          // auditoria fora não desfaz a limpeza nem derruba o giro
        }
      }
      return record;
    } finally {
      this.working = false;
    }
  }

  /** Um giro da conferência periódica: limpeza automática (se ligada e na hora) ou verificação de rotina. */
  async tick(): Promise<void> {
    if (this.working) return;
    const s = this.data.settings;
    const now = this.now();
    try {
      if (s.enabled && !this.blockReason()) {
        const base = this.data.scheduleBase ?? now;
        if (this.data.scheduleBase === null) await this.persist((cur) => ({ ...cur, scheduleBase: now }));
        if (now - base >= DOCKER_CLEANUP_FREQUENCY_DAYS[s.frequency] * DAY_MS) {
          await this.run("schedule", "automática");
          return;
        }
        if (s.diskTriggerPercent !== null && (this.data.lastDiskAttemptAt === null || now - this.data.lastDiskAttemptAt >= DISK_COOLDOWN_MS)) {
          const disk = await this.diskNow();
          if (disk && disk.usedPercent >= s.diskTriggerPercent) {
            await this.persist((cur) => ({ ...cur, lastDiskAttemptAt: now }));
            await this.run("disk", "automática");
            return;
          }
        }
      }
      const last = this.data.lastScan ? Date.parse(this.data.lastScan.scannedAt) : 0;
      if (now - last >= SCAN_EVERY_MS) await this.scan();
    } catch (err) {
      if (err instanceof DockerCleanupBlockedError) return;
      this.deps.log?.(`limpeza do Docker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
