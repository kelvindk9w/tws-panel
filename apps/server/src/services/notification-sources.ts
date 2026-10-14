/**
 * notification-sources.ts — de onde vêm os avisos fora do painel.
 *
 * Forma de menor acoplamento escolhida: os módulos NÃO conhecem o serviço de
 * notificações. app.ts liga as pontas:
 *  - alertas: o AlertsService (escopo raiz) avisa quem escuta quando grava um
 *    alerta NOVO — segurança (monitoramento, guardrails), blacklist do e-mail
 *    e vencimento de certificado manual chegam todos por aí, sem mexer em
 *    quem cria o alerta;
 *  - deploy: o DeployService chama um gancho ao terminar um deploy;
 *  - certificados automáticos e disco: vigias periódicos que só LEEM o
 *    estado (lista da página Certificados; espaço livre do disco de dados);
 *  - painel iniciado: no boot (desligado por padrão).
 *
 * Aqui só se monta o aviso (tipo, assunto para agrupar, título curto). O
 * detalhe de um alerta (portas, pacotes, IP listado…) NÃO vai na mensagem:
 * fica no painel, em Alertas.
 */
import type { Alert, AlertSeverity, CertificateItem, NotificationKind } from "@paas/core";
import type { NotificationEvent } from "./notification-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "crítico",
  warning: "atenção",
  info: "informação",
};

const KIND_BY_SOURCE: Record<Alert["source"], NotificationKind> = {
  scan: "security",
  guardrail: "security",
  blacklist: "blacklist",
  certificate: "certificate",
};

/** Alerta novo gravado → aviso (sem o detalhe). */
export function alertNotification(alert: Alert): NotificationEvent {
  return {
    kind: KIND_BY_SOURCE[alert.source],
    key: `alert:${alert.source}:${alert.title}`,
    title: alert.title,
    body: [`Gravidade: ${SEVERITY_LABEL[alert.severity]}.`, "Os detalhes estão em Alertas, no painel."],
    path: alert.source === "certificate" ? "/certificates" : "/alerts",
  };
}

export interface DeployFinished {
  projectId: string;
  projectName: string;
  status: "success" | "failed";
  /** Resultado do deploy anterior (null = primeiro deploy). */
  previousStatus?: "success" | "failed" | null;
}

/** Deploy que falhou, ou que voltou a dar certo depois de falhar. */
export function deployNotification(e: DeployFinished): NotificationEvent | null {
  if (e.status === "failed") {
    return {
      kind: "deploy",
      key: `deploy-failed:${e.projectId}`,
      title: `Deploy de ${e.projectName} falhou`,
      body: ["O site continua com a versão anterior, se havia uma. O motivo está no log do deploy."],
      path: `/projects/${e.projectId}`,
    };
  }
  if (e.previousStatus === "failed") {
    return {
      kind: "deploy",
      key: `deploy-ok:${e.projectId}`,
      title: `${e.projectName} voltou a publicar sem erro`,
      body: ["O último deploy terminou bem depois de uma falha."],
      path: `/projects/${e.projectId}`,
    };
  }
  return null;
}

export function panelStartedNotification(at: Date): NotificationEvent {
  const when = at.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  return {
    kind: "panel",
    key: "panel-started",
    title: "O painel foi iniciado",
    body: [`Ligou às ${when} (horário de Brasília), depois de uma atualização ou de a VPS reiniciar.`],
  };
}

type Notify = (event: NotificationEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// Disco
// ---------------------------------------------------------------------------

export interface DiskWatcherOptions {
  /** Pasta cujo disco é conferido (a de dados do painel, montada da VPS). */
  path: string;
  statfs: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
  notify: Notify;
  now?: () => number;
  /** Uso que dispara o aviso (padrão 90%). */
  fullRatio?: number;
  /** Uso abaixo do qual o disco volta a contar como normal (padrão 85%). */
  clearRatio?: number;
}

/** Disco quase cheio: avisa ao passar do limite e repete a cada 24 h enquanto durar. */
export class DiskWatcher {
  private full = false;
  private lastAt = 0;

  constructor(private readonly opts: DiskWatcherOptions) {}

  async check(): Promise<void> {
    let stat: { blocks: number; bsize: number; bavail: number };
    try {
      stat = await this.opts.statfs(this.opts.path);
    } catch {
      return;
    }
    const total = stat.blocks * stat.bsize;
    if (total <= 0) return;
    const free = stat.bavail * stat.bsize;
    const used = 1 - free / total;
    const now = (this.opts.now ?? Date.now)();
    if (used < (this.opts.clearRatio ?? 0.85)) {
      this.full = false;
      return;
    }
    if (used < (this.opts.fullRatio ?? 0.9) && !this.full) return;
    if (this.full && now - this.lastAt < DAY_MS) return;
    this.full = true;
    this.lastAt = now;
    const percent = Math.round(used * 100);
    const freeGb = Math.round((free / 1024 ** 3) * 10) / 10;
    await this.opts.notify({
      kind: "disk",
      key: "disk",
      title: `Disco da VPS com ${percent}% de uso`,
      body: [
        `Restam ${freeGb} GB livres. Com o disco cheio, deploys, e-mail e o próprio painel param de gravar.`,
        "Apague imagens e builds antigos do Docker ou aumente o disco no provedor.",
      ],
      path: "/health",
    });
  }
}

// ---------------------------------------------------------------------------
// Certificados
// ---------------------------------------------------------------------------

export interface CertificateWatcherOptions {
  list: () => Promise<CertificateItem[]>;
  notify: Notify;
  now?: () => number;
}

/**
 * Certificado que não foi emitido, que venceu ou que é automático e está
 * perto de vencer (o Caddy renova com folga: perto de vencer quer dizer que a
 * renovação está falhando). O manual perto de vencer já vira alerta (30/7
 * dias, CertificateService) e chega pelos alertas — não repete aqui.
 */
export class CertificateWatcher {
  /** host:estado → último aviso (ms). */
  private readonly last = new Map<string, number>();

  constructor(private readonly opts: CertificateWatcherOptions) {}

  async check(): Promise<void> {
    let items: CertificateItem[];
    try {
      items = await this.opts.list();
    } catch {
      return;
    }
    const now = (this.opts.now ?? Date.now)();
    const current = new Set<string>();
    for (const item of items) {
      const title = this.titleFor(item);
      if (!title) continue;
      const key = `${item.host}:${item.state}`;
      current.add(key);
      const last = this.last.get(key);
      if (last !== undefined && now - last < DAY_MS) continue;
      this.last.set(key, now);
      await this.opts.notify({
        kind: "certificate",
        key: `cert:${key}`,
        title,
        body: ["Sem certificado válido, o navegador mostra o site como inseguro. O motivo está na página Certificados."],
        path: "/certificates",
      });
    }
    // Problema resolvido: esquece, para avisar na hora se voltar.
    for (const key of [...this.last.keys()]) {
      if (!current.has(key)) this.last.delete(key);
    }
  }

  private titleFor(item: CertificateItem): string | null {
    if (item.state === "failed") return `Certificado de ${item.host} não foi emitido`;
    if (item.state === "expired") return `Certificado de ${item.host} venceu`;
    if (item.state === "expiring" && item.mode === "automatic") {
      return `Certificado de ${item.host} não renovou e vence em breve`;
    }
    return null;
  }
}
