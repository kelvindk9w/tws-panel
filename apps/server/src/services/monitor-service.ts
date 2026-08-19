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
  HostRunner,
  isDiffEmpty,
  MonitorScheduler,
  type TargetRunner,
} from "@paas/security";
import type { ServerConfig } from "../config.js";
import type { AlertsService } from "./alerts-service.js";

interface MonitorFile {
  intervalMs: number;
  lastRunAt: string | null;
  lastResult: MonitorScanResult | null;
}

/** Descrições de listagens em blacklist (vazio = tudo limpo / módulo inativo). */
export type MailBlacklistHook = () => Promise<string[]>;

export class MonitorService {
  private readonly runner: TargetRunner;
  private readonly alerts: AlertsService;
  private readonly securityDir: string;
  private readonly baselineFile: string;
  private readonly monitorFile: string;
  private readonly scheduler: MonitorScheduler;
  private mailHook: MailBlacklistHook | null = null;
  private state: MonitorFile;
  private stateLoaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(config: ServerConfig, alerts: AlertsService) {
    this.runner =
      config.securityTarget === "host"
        ? new HostRunner()
        : new ContainerRunner({ name: config.securityTargetContainer });
    this.alerts = alerts;
    this.securityDir = path.join(config.dataDir, "security");
    this.baselineFile = path.join(this.securityDir, "baseline.json");
    this.monitorFile = path.join(this.securityDir, "monitor.json");
    this.state = {
      intervalMs: config.monitorIntervalMs > 0 ? config.monitorIntervalMs : MONITOR_DEFAULT_INTERVAL_MS,
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

  async getBaseline(): Promise<SecurityBaseline | null> {
    try {
      const raw = await readFile(this.baselineFile, "utf8");
      return JSON.parse(raw) as SecurityBaseline;
    } catch {
      return null;
    }
  }

  /** Cria (ou substitui) o baseline a partir do estado atual do alvo. */
  async createBaseline(): Promise<SecurityBaseline> {
    const baseline = await collectBaseline(this.runner);
    await mkdir(this.securityDir, { recursive: true });
    await writeFile(this.baselineFile, JSON.stringify(baseline, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return baseline;
  }

  // -------------------------------------------------------------------------
  // Scan recorrente
  // -------------------------------------------------------------------------

  /** Executa um scan agora (endpoint "rodar agora"). */
  async runNow(): Promise<MonitorScanResult> {
    const result = await this.executeScan();
    this.state.lastRunAt = new Date().toISOString();
    await this.saveState();
    return result;
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
    this.state.intervalMs = intervalMs;
    this.scheduler.setIntervalMs(intervalMs);
    await this.saveState();
  }

  // -------------------------------------------------------------------------

  /** Scan completo: snapshot atual + diff vs baseline + blacklist de e-mail. */
  private async executeScan(): Promise<MonitorScanResult> {
    await this.ensureStateLoaded();
    const startedAt = Date.now();
    const baseline = await this.getBaseline();
    const current = await collectBaseline(this.runner);

    let diff: BaselineDiff | null = null;
    let alertsCreated = 0;
    let note: string | null = null;

    if (!baseline) {
      note = "Nenhum baseline salvo — crie um em POST /api/security/baseline para ativar a comparação.";
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
        intervalMs:
          typeof raw.intervalMs === "number" && raw.intervalMs > 0
            ? raw.intervalMs
            : this.state.intervalMs,
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
