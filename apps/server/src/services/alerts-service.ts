/**
 * alerts-service.ts — central de alertas (Fase 4).
 * Persistência JSON em data/alerts.json. Alertas abertos com a mesma
 * origem+título são atualizados (bump) em vez de duplicados — o scan
 * recorrente rodando a cada intervalo não geraria pilha de repetidos.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Alert, AlertSeverity, AlertSource, AlertStatus } from "@paas/core";

const MAX_ALERTS = 500;

interface AlertsFile {
  alerts: Alert[];
}

export interface AlertFilters {
  status?: AlertStatus;
  severity?: AlertSeverity;
  source?: AlertSource;
  page?: number;
  perPage?: number;
}

export interface AlertsServiceOptions {
  /** Teto de retenção (default MAX_ALERTS = 500). Configurável para testes. */
  maxAlerts?: number;
  /** Log de avisos (ex.: teto atingido só com alertas abertos). Default: console.warn. */
  log?: (msg: string) => void;
}

export class AlertsService {
  private readonly file: string;
  private readonly maxAlerts: number;
  private readonly log: (msg: string) => void;
  private alerts: Alert[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, opts: AlertsServiceOptions = {}) {
    this.file = path.join(dataDir, "alerts.json");
    this.maxAlerts = opts.maxAlerts ?? MAX_ALERTS;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<AlertsFile>;
      this.alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
    } catch {
      this.alerts = [];
    }
  }

  /**
   * Cria um alerta (ou atualiza um aberto idêntico — mesma origem+título).
   * Retorna o alerta e se foi criado de fato.
   */
  async create(input: {
    severity: AlertSeverity;
    source: AlertSource;
    title: string;
    detail: string;
  }): Promise<{ alert: Alert; created: boolean }> {
    await this.ensureLoaded();
    const existing = this.alerts.find(
      (a) => a.status === "open" && a.source === input.source && a.title === input.title,
    );
    if (existing) {
      existing.detail = input.detail;
      existing.severity = input.severity;
      existing.createdAt = new Date().toISOString();
      await this.persist();
      return { alert: existing, created: false };
    }
    const alert: Alert = {
      id: randomBytes(8).toString("hex"),
      severity: input.severity,
      source: input.source,
      title: input.title,
      detail: input.detail,
      status: "open",
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
    };
    this.alerts.push(alert);
    this.enforceCap();
    await this.persist();
    return { alert, created: true };
  }

  /**
   * Aplica o teto de retenção preservando alertas abertos: descarta primeiro
   * os resolvidos/reconhecidos mais antigos (por createdAt). Se o teto for
   * atingido só com alertas abertos, mantém todos e apenas loga um aviso —
   * um alerta `open` nunca reconhecido é exatamente o que mais importa não
   * perder silenciosamente.
   */
  private enforceCap(): void {
    const overflow = this.alerts.length - this.maxAlerts;
    if (overflow <= 0) return;

    const closedByAge = this.alerts
      .map((alert, index) => ({ alert, index }))
      .filter(({ alert }) => alert.status !== "open")
      .sort((a, b) => a.alert.createdAt.localeCompare(b.alert.createdAt));

    const indexesToDrop = new Set(closedByAge.slice(0, overflow).map(({ index }) => index));
    if (indexesToDrop.size > 0) {
      this.alerts = this.alerts.filter((_, index) => !indexesToDrop.has(index));
    }

    const stillOver = overflow - indexesToDrop.size;
    if (stillOver > 0) {
      this.log(
        `alerts: teto de ${this.maxAlerts} atingido só com alertas ainda abertos — ` +
          `mantendo todos os ${this.alerts.length} (nenhum alerta aberto foi descartado).`,
      );
    }
  }

  async list(filters: AlertFilters = {}): Promise<{
    alerts: Alert[];
    total: number;
    openCount: number;
    page: number;
    perPage: number;
  }> {
    await this.ensureLoaded();
    const openCount = this.alerts.filter((a) => a.status === "open").length;
    let filtered = [...this.alerts].reverse(); // mais recentes primeiro
    if (filters.status) filtered = filtered.filter((a) => a.status === filters.status);
    if (filters.severity) filtered = filtered.filter((a) => a.severity === filters.severity);
    if (filters.source) filtered = filtered.filter((a) => a.source === filters.source);
    const total = filtered.length;
    const perPage = Math.min(Math.max(filters.perPage ?? 50, 1), 200);
    const page = Math.max(filters.page ?? 1, 1);
    const start = (page - 1) * perPage;
    return { alerts: filtered.slice(start, start + perPage), total, openCount, page, perPage };
  }

  async setStatus(id: string, status: "acknowledged" | "resolved"): Promise<Alert | null> {
    await this.ensureLoaded();
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return null;
    const now = new Date().toISOString();
    if (status === "acknowledged") {
      if (alert.status === "open") {
        alert.status = "acknowledged";
        alert.acknowledgedAt = now;
      }
    } else {
      alert.status = "resolved";
      alert.resolvedAt = now;
      if (!alert.acknowledgedAt) alert.acknowledgedAt = now;
    }
    await this.persist();
    return alert;
  }

  private async persist(): Promise<void> {
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const data: AlertsFile = { alerts: this.alerts };
    await writeFile(this.file, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
