/**
 * timezone-service.ts — fuso horário da VPS pelo painel (Configurações →
 * Fuso horário e o assistente de instalação).
 *
 * Criado em app.ts no escopo RAIZ: as rotas de fuso, as de projetos (fuso
 * "Igual ao da VPS") e os backups (agenda das 03:00) usam o mesmo objeto.
 *
 * O que faz:
 *  - lê o fuso da VPS pelo host bridge (`timedatectl show`) logo depois da
 *    subida e de tempos em tempos quando a tela abre. Não depende da
 *    montagem /host/etc/localtime, que congela quando o link muda;
 *  - "Aplicar na VPS": troca o fuso do host pelo host bridge (`timedatectl
 *    set-timezone`, nome da lista IANA), confere lendo de novo e passa a
 *    usar o fuso novo NA HORA (process.env.TZ: o Node relê o fuso quando a
 *    variável muda). Sem recriar o container e sem SSH;
 *  - guarda o último fuso lido em data/timezone.json (vale na subida
 *    seguinte, antes da montagem);
 *  - avisa quem depende do fuso (onChange): a agenda dos backups recalcula;
 *  - "Aplicar também nestes projetos": os marcados passam a "Igual ao da VPS"
 *    e são recriados com o TZ novo.
 *
 * TZ no .env do painel continua tendo prioridade na subida: a tela avisa
 * quando ele existe, porque ao reiniciar o painel volta para ele.
 */
import {
  effectiveProjectZone,
  formatUtcOffset,
  isKnownTimezone,
  timezoneOffsetMinutes,
  timezoneOptions,
  type Project,
  type ProjectTimezoneSetting,
  type SetTimezoneResponse,
  type TimezoneProjectResult,
  type TimezoneSource,
  type TimezoneStatus,
} from "@paas/core";
import { httpError } from "./http-error.js";
import { readSavedTimezone, writeSavedTimezone, type StartupTimezone } from "./host-timezone.js";

/** Leitura e troca do fuso no host (host bridge). */
export interface HostTimezoneBridge {
  /** Nome do fuso da VPS; null = saída que não deu para entender. */
  read(): Promise<string | null>;
  set(zone: string): Promise<void>;
}

export interface TimezoneProjects {
  list(): Promise<Project[]>;
  setTimezone(id: string, setting: ProjectTimezoneSetting, actor: string): Promise<Project>;
  /** Recria os containers com o TZ novo (job de reinício). */
  recreate(id: string, actor: string): Promise<{ id: string }>;
}

export interface TimezoneAuditSink {
  record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown>;
}

export interface TimezoneServiceOptions {
  dataDir: string;
  /** null = sem host bridge (PAAS_TARGET não é host): não dá para trocar o fuso da VPS. */
  bridge: HostTimezoneBridge | null;
  startup: StartupTimezone;
  projects: TimezoneProjects;
  env?: NodeJS.ProcessEnv;
  audit?: TimezoneAuditSink;
  log?: (message: string) => void;
  now?: () => number;
  /** O fuso em uso mudou (a agenda dos backups recalcula). */
  onChange?: (zone: string, previous: string) => void;
  /** Ao abrir a tela, relê a VPS se a última leitura passou disto (padrão 5 min). */
  refreshAfterMs?: number;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** O mínimo do runner do host bridge (NsenterHostRunner de @paas/security). */
export interface TimezoneRunner {
  ensureReady(): Promise<void>;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Leitura e troca pelo host bridge: os comandos vêm prontos de
 * packages/security (HOST_TIMEZONE_READ_CMD e buildSetTimezoneCommand, que só
 * aceita nomes da lista IANA) e passam pela allowlist do runner, que audita
 * cada um (timezone.host-exec).
 */
export function createHostTimezoneBridge(
  runner: TimezoneRunner,
  commands: { read: string; set: (zone: string) => string; parse: (output: string) => string | null },
): HostTimezoneBridge {
  return {
    async read() {
      await runner.ensureReady();
      const r = await runner.exec(commands.read, { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200) || `código ${r.code}`);
      return commands.parse(r.stdout);
    },
    async set(zone) {
      await runner.ensureReady();
      const r = await runner.exec(commands.set(zone), { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200) || `código ${r.code}`);
    },
  };
}

export class TimezoneService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly refreshAfterMs: number;
  private source: TimezoneSource;
  private readonly envOverride: string | null;
  private hostZone: string | null = null;
  private hostReadAt: number | null = null;
  private hostError: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly opts: TimezoneServiceOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.refreshAfterMs = opts.refreshAfterMs ?? 5 * 60_000;
    this.source = opts.startup.source;
    this.envOverride = opts.startup.envOverride;
  }

  /** Fuso que o painel usa agora. */
  current(): string {
    return this.env.TZ || "UTC";
  }

  /** Fuso da VPS ("Igual ao da VPS" nos projetos): o último lido, ou o que o painel usa. */
  vpsZone(): string {
    return this.hostZone ?? this.current();
  }

  private audit(action: string, detail: string, actor?: string, target: string | null = "fuso"): void {
    void this.opts.audit?.record({ action, detail, ...(actor ? { actor } : {}), target })?.catch(() => undefined);
  }

  /** Passa a usar `zone` agora (sem reiniciar) e avisa quem depende. */
  private use(zone: string): void {
    const previous = this.current();
    if (previous === zone) return;
    this.env.TZ = zone;
    try {
      this.opts.onChange?.(zone, previous);
    } catch (err) {
      this.log(`Fuso: aviso da troca falhou (${reasonOf(err)}).`);
    }
  }

  /**
   * Lê o fuso da VPS pelo host bridge e passa a usá-lo (menos com TZ no
   * .env, que manda). Falha aqui nunca derruba nada: fica o fuso de antes.
   */
  refresh(): Promise<void> {
    const bridge = this.opts.bridge;
    if (!bridge) return Promise.resolve();
    this.refreshing ??= (async () => {
      try {
        const zone = await bridge.read();
        this.hostReadAt = this.now();
        if (!zone) {
          this.hostError = "A VPS respondeu, mas não deu para entender o fuso dela.";
          return;
        }
        this.hostError = null;
        this.hostZone = zone;
        const saved = await readSavedTimezone(this.opts.dataDir);
        if (saved?.zone !== zone) {
          await writeSavedTimezone(this.opts.dataDir, { zone, readAt: new Date(this.hostReadAt).toISOString() }).catch((err: unknown) =>
            this.log(`Fuso: não foi possível gravar data/timezone.json (${reasonOf(err)}).`),
          );
        }
        if (!this.envOverride) {
          this.source = "host";
          this.use(zone);
        }
      } catch (err) {
        this.hostReadAt = this.now();
        this.hostError = `Não foi possível ler o fuso da VPS: ${reasonOf(err)}`;
        this.log(`Fuso: ${this.hostError}`);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async status(): Promise<TimezoneStatus> {
    if (this.opts.bridge && (this.hostReadAt === null || this.now() - this.hostReadAt > this.refreshAfterMs)) {
      await this.refresh();
    }
    const zone = this.current();
    const at = new Date(this.now());
    const offset = timezoneOffsetMinutes(zone, at);
    const projects = await this.opts.projects.list();
    return {
      zone,
      offset: offset === null ? zone : formatUtcOffset(offset),
      source: this.source,
      envOverride: this.envOverride,
      hostZone: this.hostZone,
      hostReadAt: this.hostReadAt === null ? null : new Date(this.hostReadAt).toISOString(),
      hostError: this.hostError,
      canApply: this.opts.bridge !== null,
      cannotApplyReason:
        this.opts.bridge === null
          ? "O painel não está ligado à VPS (PAAS_TARGET não é host). Troque o fuso pelo SSH: sudo timedatectl set-timezone <fuso>."
          : null,
      now: at.toISOString(),
      options: timezoneOptions(at),
      projects: projects.map((p) => {
        const setting = p.timezone ?? { mode: "image" as const };
        return { id: p.id, name: p.name, setting, effectiveZone: effectiveProjectZone(setting, this.vpsZone()) };
      }),
    };
  }

  /** "Aplicar na VPS" (e nos projetos marcados). */
  async apply(zone: string, projectIds: string[], actor: string): Promise<SetTimezoneResponse> {
    if (!isKnownTimezone(zone)) throw httpError(400, "invalid_timezone", "Escolha um fuso da lista.");
    const bridge = this.opts.bridge;
    if (!bridge) {
      throw httpError(
        409,
        "host_bridge_unavailable",
        "O painel não está ligado à VPS (PAAS_TARGET não é host). Troque o fuso pelo SSH: sudo timedatectl set-timezone " + zone,
      );
    }
    const previous = this.hostZone ?? this.current();
    try {
      await bridge.set(zone);
    } catch (err) {
      this.audit("timezone.apply_failed", `Troca do fuso da VPS para ${zone} falhou: ${reasonOf(err).slice(0, 200)}`, actor);
      throw httpError(502, "timezone_apply_failed", `A VPS não aceitou o fuso novo: ${reasonOf(err).slice(0, 200)}`);
    }
    // Confere lendo de novo: o comando pode ter saído com 0 sem trocar nada.
    let confirmed: string | null = null;
    try {
      confirmed = await bridge.read();
    } catch (err) {
      this.log(`Fuso: conferência depois da troca falhou (${reasonOf(err)}).`);
    }
    if (confirmed !== null && confirmed !== zone) {
      this.audit("timezone.apply_failed", `Troca do fuso da VPS para ${zone}: a VPS continua em ${confirmed}.`, actor);
      throw httpError(502, "timezone_apply_failed", `A VPS continua em ${confirmed}. Tente de novo ou troque pelo SSH: sudo timedatectl set-timezone ${zone}`);
    }
    this.hostZone = zone;
    this.hostReadAt = this.now();
    this.hostError = null;
    await writeSavedTimezone(this.opts.dataDir, { zone, readAt: new Date(this.hostReadAt).toISOString() }).catch((err: unknown) =>
      this.log(`Fuso: não foi possível gravar data/timezone.json (${reasonOf(err)}).`),
    );
    // Com TZ no .env, o painel usa o fuso novo até reiniciar (a tela avisa).
    if (!this.envOverride) this.source = "host";
    this.use(zone);
    this.audit("timezone.applied", `Fuso da VPS: ${previous} → ${zone}.`, actor);

    const results: TimezoneProjectResult[] = [];
    const all = await this.opts.projects.list();
    for (const id of [...new Set(projectIds)]) {
      const project = all.find((p) => p.id === id);
      if (!project) {
        results.push({ id, name: id, jobId: null, error: "Projeto não encontrado." });
        continue;
      }
      try {
        await this.opts.projects.setTimezone(id, { mode: "host" }, actor);
        const job = await this.opts.projects.recreate(id, actor);
        results.push({ id, name: project.name, jobId: job.id, error: null });
      } catch (err) {
        results.push({ id, name: project.name, jobId: null, error: reasonOf(err) });
      }
    }
    return { status: await this.status(), projects: results };
  }
}
