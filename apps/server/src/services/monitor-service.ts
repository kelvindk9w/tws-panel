/**
 * monitor-service.ts — baseline de segurança + scans recorrentes com diff
 * (Fase 4). Roda contra o mesmo alvo do hardening (host ou container,
 * conforme PAAS_TARGET) e gera alertas por diferença.
 *
 * O agendador roda dentro do processo do servidor (setInterval) — sem tocar
 * em cron/systemd do host. Config e última execução persistidos em
 * data/security/monitor.json; baseline em data/security/baseline.json.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MONITOR_DEFAULT_INTERVAL_MS,
  type BaselineDiff,
  type MonitorScanResult,
  type MonitorStateResponse,
  type SecurityBaseline,
} from "@paas/core";
import {
  collectBaseline,
  ContainerRunner,
  diffBaseline,
  isDiffEmpty,
  MonitorScheduler,
  NsenterHostRunner,
  type TargetRunner,
} from "@paas/security";
import type { ServerConfig } from "../config.js";
import type { AlertsService } from "./alerts-service.js";

interface MonitorFile {
  intervalMs: number;
  lastRunAt: string | null;
  lastResult: MonitorScanResult | null;
}

/** Gancho de auditoria (mesmo formato do SecurityAuditHook). */
export type MonitorAuditHook = (action: string, detail: string) => void;

/**
 * Marca de origem gravada no baseline.json. Necessária porque o mecanismo
 * antigo do perfil host (HostRunner, que rodava `bash -c` DENTRO do container
 * do painel) e o host bridge usam o mesmo rótulo "host" — só pelo `target`
 * não dá para saber se a linha de base descreve a VPS ou o container.
 * Linhas de base anteriores a esta correção não têm o campo.
 */
type BaselineCollector = "host-bridge" | "container";

type StoredBaseline = SecurityBaseline & { collector?: BaselineCollector };

/** Descrições de listagens em blacklist (vazio = tudo limpo / módulo inativo). */
export type MailBlacklistHook = () => Promise<string[]>;

/**
 * Piso efetivo para o intervalo do scan recorrente. `MONITOR_MIN_INTERVAL_MS`
 * (10s), em @paas/core, é menor que a duração real observada de um scan
 * completo (baseline + diff, possivelmente Lynis — de dezenas de segundos a
 * ~133s em VPS real): com um intervalo tão baixo o agendador ficava pulando
 * ciclos em sequência (o scan anterior nunca termina a tempo do próximo
 * tick). A constante em @paas/core está fora do escopo desta correção
 * (arquivo de outro pacote); este serviço aplica aqui um piso mais realista,
 * elevando qualquer intervalo configurado/persistido abaixo dele.
 */
const EFFECTIVE_MIN_INTERVAL_MS = 60_000;

function clampInterval(intervalMs: number): number {
  return Math.max(intervalMs, EFFECTIVE_MIN_INTERVAL_MS);
}

export class MonitorService {
  private readonly runner: TargetRunner;
  private readonly alerts: AlertsService;
  private readonly securityDir: string;
  private readonly baselineFile: string;
  private readonly monitorFile: string;
  private readonly scheduler: MonitorScheduler;
  private readonly log: (msg: string) => void;
  private readonly audit: MonitorAuditHook | undefined;
  private readonly collector: BaselineCollector;
  private mailHook: MailBlacklistHook | null = null;
  private state: MonitorFile;
  private stateLoaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    config: ServerConfig,
    alerts: AlertsService,
    log?: (msg: string) => void,
    opts?: { audit?: MonitorAuditHook },
  ) {
    this.alerts = alerts;
    this.log = log ?? ((msg) => console.warn(msg));
    this.audit = opts?.audit;
    // Alvo "host": host bridge (nsenter via helper privilegiado descartável),
    // o mesmo mecanismo da SecurityService — os comandos da linha de base
    // rodam na VPS real, NÃO no container do painel (o HostRunner local
    // descrevia o container e a VPS ficava sem vigilância). Não passa pelo
    // terminal ao vivo: o scan é agendado e roda sem ninguém olhando.
    if (config.securityTarget === "host") {
      this.collector = "host-bridge";
      this.runner = new NsenterHostRunner({
        image: config.hostHelperImage,
        onAudit: (detail) => this.audit?.("monitor.host-exec", detail),
      });
      if (!this.audit) {
        this.log(
          "Monitoramento: nenhum gancho de auditoria injetado — os comandos executados no host não serão registrados em auditoria.",
        );
      }
    } else {
      this.collector = "container";
      this.runner = new ContainerRunner({ name: config.securityTargetContainer });
    }
    this.securityDir = path.join(config.dataDir, "security");
    this.baselineFile = path.join(this.securityDir, "baseline.json");
    this.monitorFile = path.join(this.securityDir, "monitor.json");
    this.state = {
      intervalMs: clampInterval(
        config.monitorIntervalMs > 0 ? config.monitorIntervalMs : MONITOR_DEFAULT_INTERVAL_MS,
      ),
      lastRunAt: null,
      lastResult: null,
    };
    this.scheduler = new MonitorScheduler({
      intervalMs: this.state.intervalMs,
      task: async () => {
        await this.executeScan();
      },
      onTick: ({ ranAt }) => {
        this.state.lastRunAt = ranAt;
        void this.saveState();
      },
      onSkip: () => {
        // Antes desta correção um ciclo pulado por scan ainda em andamento
        // era silencioso — nem log, nem qualquer sinal para o operador.
        this.log(
          "Monitoramento: ciclo agendado pulado — o scan anterior (automático ou manual) ainda está em andamento.",
        );
      },
    });
  }

  /** Hook de blacklist de e-mail (registrado pelas rotas de monitoramento). */
  setMailBlacklistHook(hook: MailBlacklistHook): void {
    this.mailHook = hook;
  }

  async start(): Promise<void> {
    await this.ensureStateLoaded();
    this.scheduler.setIntervalMs(this.state.intervalMs);
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  // -------------------------------------------------------------------------
  // Baseline
  // -------------------------------------------------------------------------

  async getBaseline(): Promise<StoredBaseline | null> {
    try {
      const raw = await readFile(this.baselineFile, "utf8");
      return JSON.parse(raw) as StoredBaseline;
    } catch {
      return null;
    }
  }

  /** Cria (ou substitui) o baseline a partir do estado atual do alvo. */
  async createBaseline(): Promise<SecurityBaseline> {
    const baseline = await collectBaseline(this.runner);
    await this.saveBaseline(baseline);
    return baseline;
  }

  private async saveBaseline(baseline: SecurityBaseline): Promise<void> {
    const stored: StoredBaseline = { ...baseline, collector: this.collector };
    await mkdir(this.securityDir, { recursive: true });
    await writeFile(this.baselineFile, JSON.stringify(stored, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /**
   * true se a linha de base gravada NÃO descreve a VPS real e precisa ser
   * recoletada no perfil host: sem a marca `collector: "host-bridge"` ela foi
   * coletada pelo HostRunner antigo (dentro do container do painel) ou num
   * perfil container. Compará-la com a VPS acusaria diferença em tudo.
   * No perfil container nada muda (linhas de base sem marca seguem válidas).
   */
  private needsRecollection(baseline: StoredBaseline): boolean {
    return this.collector === "host-bridge" && baseline.collector !== "host-bridge";
  }

  // -------------------------------------------------------------------------
  // Scan recorrente
  // -------------------------------------------------------------------------

  /**
   * Executa um scan agora (endpoint "rodar agora").
   *
   * Passa pelo MESMO MonitorScheduler usado pelo tick automático (em vez de
   * chamar executeScan() direto) para herdar o lock `inFlight` — antes desta
   * correção um POST manual podia rodar em paralelo com um tick automático,
   * dois scans concorrentes disputando os mesmos recursos do alvo. Se já
   * houver um scan em andamento, scheduler.runNow() lança (ver monitor.ts
   * para a justificativa de recusar em vez de esperar).
   */
  async runNow(): Promise<MonitorScanResult> {
    await this.ensureStateLoaded();
    await this.scheduler.runNow();
    if (!this.state.lastResult) {
      // não deveria acontecer: executeScan() sempre popula lastResult antes
      // de scheduler.runNow() resolver com sucesso.
      throw new Error("scan concluído mas nenhum resultado ficou disponível");
    }
    return this.state.lastResult;
  }

  async getState(): Promise<MonitorStateResponse> {
    await this.ensureStateLoaded();
    const baseline = await this.getBaseline();
    return {
      config: { intervalMs: this.state.intervalMs },
      schedulerRunning: this.scheduler.running,
      lastRunAt: this.state.lastRunAt,
      lastResult: this.state.lastResult,
      baseline: baseline
        ? { id: baseline.id, createdAt: baseline.createdAt, target: baseline.target }
        : null,
    };
  }

  async setIntervalMs(intervalMs: number): Promise<void> {
    await this.ensureStateLoaded();
    const clamped = clampInterval(intervalMs);
    this.state.intervalMs = clamped;
    this.scheduler.setIntervalMs(clamped);
    await this.saveState();
  }

  // -------------------------------------------------------------------------

  /** Scan completo: snapshot atual + diff vs baseline + blacklist de e-mail. */
  private async executeScan(): Promise<MonitorScanResult> {
    await this.ensureStateLoaded();
    const startedAt = Date.now();
    let baseline = await this.getBaseline();
    const current = await collectBaseline(this.runner);

    let diff: BaselineDiff | null = null;
    let alertsCreated = 0;
    let note: string | null = null;

    if (!baseline) {
      note = "Nenhum baseline salvo — crie um em POST /api/security/baseline para ativar a comparação.";
    } else if (this.needsRecollection(baseline)) {
      // Migração: substitui a linha de base antiga pelo snapshot da VPS real,
      // SEM comparar — senão o primeiro scan geraria uma enxurrada de alertas
      // falsos (tudo difere entre o container do painel e a VPS).
      const old = baseline;
      await this.saveBaseline(current);
      baseline = current;
      const detail =
        `linha de base ${old.id} (target=${old.target}, coletada em ${old.createdAt}, ` +
        `origem=${old.collector ?? "mecanismo antigo"}) substituída por ${current.id} coletada pelo host bridge`;
      this.audit?.("monitor.baseline-recollected", detail);
      this.log(`Monitoramento: ${detail} — nenhuma comparação feita neste ciclo.`);
      note =
        "A linha de base anterior não foi coletada na VPS real (mecanismo antigo); uma nova linha de base foi coletada pelo host bridge. A comparação volta no próximo scan.";
    } else {
      diff = diffBaseline(baseline, current);
      alertsCreated += await this.alertDiff(diff);
    }

    // Blacklist de e-mail (somente quando o módulo está ativo — hook decide).
    if (this.mailHook) {
      try {
        const listed = await this.mailHook();
        if (listed.length > 0) {
          const { created } = await this.alerts.create({
            severity: "critical",
            source: "blacklist",
            title: "E-mail: IP ou domínio listado em blacklist",
            detail: listed.join("\n"),
          });
          if (created) alertsCreated += 1;
        }
      } catch {
        // blacklist é best-effort dentro do scan
      }
    }

    const result: MonitorScanResult = {
      id: randomUUID(),
      ranAt: new Date().toISOString(),
      target: current.target,
      durationMs: Date.now() - startedAt,
      baselineId: baseline?.id ?? null,
      baselineAt: baseline?.createdAt ?? null,
      diff,
      alertsCreated,
      note,
    };
    this.state.lastResult = result;
    await this.saveState();
    return result;
  }

  /** Gera um alerta por categoria de diferença encontrada. */
  private async alertDiff(diff: BaselineDiff): Promise<number> {
    if (isDiffEmpty(diff)) return 0;
    let created = 0;
    const push = async (severity: "critical" | "warning", title: string, lines: string[]) => {
      const { created: wasCreated } = await this.alerts.create({
        severity,
        source: "scan",
        title,
        detail: lines.join("\n"),
      });
      if (wasCreated) created += 1;
    };

    if (diff.newPorts.length > 0) {
      await push(
        "critical",
        "Monitoramento: novas portas abertas no servidor",
        diff.newPorts.map((p) => `+ ${p.proto}/${p.port}${p.process ? ` (${p.process})` : ""}`),
      );
    }
    if (diff.closedPorts.length > 0) {
      await push(
        "warning",
        "Monitoramento: portas que deixaram de escutar",
        diff.closedPorts.map((p) => `- ${p.proto}/${p.port}${p.process ? ` (${p.process})` : ""}`),
      );
    }
    if (diff.newPackages.length > 0 || diff.removedPackages.length > 0) {
      await push("warning", "Monitoramento: pacotes instalados/removidos", [
        ...diff.newPackages.map((p) => `+ ${p}`),
        ...diff.removedPackages.map((p) => `- ${p}`),
      ]);
    }
    const fileChanges = [
      ...diff.changedFiles.map((f) => `~ ${f} (conteúdo alterado)`),
      ...diff.removedFiles.map((f) => `- ${f} (removido)`),
      ...diff.addedFiles.map((f) => `+ ${f} (novo)`),
    ];
    if (fileChanges.length > 0) {
      await push("critical", "Monitoramento: arquivos críticos alterados", fileChanges);
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // Persistência do estado do monitor
  // -------------------------------------------------------------------------

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.monitorFile, "utf8")) as Partial<MonitorFile>;
      this.state = {
        intervalMs: clampInterval(
          typeof raw.intervalMs === "number" && raw.intervalMs > 0 ? raw.intervalMs : this.state.intervalMs,
        ),
        lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
        lastResult: raw.lastResult ?? null,
      };
    } catch {
      // primeira execução — mantém defaults
    }
  }

  private async saveState(): Promise<void> {
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.securityDir, { recursive: true });
        await writeFile(this.monitorFile, JSON.stringify(this.state, null, 2) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
      })
      .catch(() => undefined);
    await this.writing;
  }
}
