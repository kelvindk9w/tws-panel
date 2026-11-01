/**
 * notification-sources.ts — de onde vêm os avisos fora do painel.
 *
 * Forma de menor acoplamento escolhida: os módulos NÃO conhecem o serviço de
 * notificações. app.ts liga as pontas:
 *  - alertas: o AlertsService (escopo raiz) avisa quem escuta quando grava um
 *    alerta NOVO — segurança (monitoramento, guardrails), blacklist do e-mail
 *    e vencimento de certificado manual chegam todos por aí, sem mexer em
 *    quem cria o alerta (certificado automático que não renovou tem vigia
 *    próprio, certificate-alerts.ts, que agrupa os avisos de uma rodada);
 *  - deploy: o DeployService chama um gancho ao terminar um deploy;
 *  - disco: vigia periódico que só LÊ o espaço livre do disco de dados;
 *  - painel iniciado: no boot (desligado por padrão).
 *
 * Aqui só se monta o aviso (tipo, assunto para agrupar, título curto). O
 * detalhe de um alerta (portas, pacotes, IP listado…) NÃO vai na mensagem:
 * fica no painel, em Alertas. Exceção: o alerta de certificado, cujo texto o
 * próprio painel escreve (nome, causa traduzida e o que fazer) e não leva IP.
 */
import type { Alert, AlertSeverity, NotificationKind } from "@paas/core";
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
  login: "security",
  resources: "resources",
};

/** Alerta novo gravado → aviso (sem o detalhe, salvo o de certificado: nome, causa e o que fazer). */
export function alertNotification(alert: Alert): NotificationEvent {
  return {
    kind: KIND_BY_SOURCE[alert.source],
    key: `alert:${alert.source}:${alert.title}`,
    title: alert.title,
    body: [
      `Gravidade: ${SEVERITY_LABEL[alert.severity]}.`,
      alert.source === "certificate" ? alert.detail : "Os detalhes estão em Alertas, no painel.",
    ],
    path: alert.source === "certificate" ? "/certificates" : alert.projectSlug ? `/alerts?project=${encodeURIComponent(alert.projectSlug)}` : "/alerts",
  };
}

export interface DeployFinished {
  projectId: string;
  projectName: string;
  status: "success" | "failed";
  /** Resultado do deploy anterior (null = primeiro deploy). */
  previousStatus?: "success" | "failed" | null;
  /** Tipo detectado do projeto (node-server = Next.js gerado pelo painel). */
  projectType?: string | null;
  /** O projeto já tinha uma versão publicada antes deste deploy. */
  hadPublished?: boolean;
}

/**
 * O que acontece com o site depois de um deploy que falhou, dito pelo que o painel de fato faz:
 * só o servidor Next.js guarda o container anterior e o religa se o novo não responde; nos demais
 * tipos (Dockerfile, compose, estático) o container antigo sai antes de o novo subir, então o site
 * pode estar fora do ar até um deploy bem-sucedido.
 */
export function failedDeployOutcome(e: Pick<DeployFinished, "projectType" | "hadPublished">): string {
  if (e.hadPublished === false) return "O site ainda não foi publicado: ele só entra no ar depois de um deploy bem-sucedido.";
  if (e.projectType === "node-server") return "A versão anterior foi mantida (ou religada) e o site segue com ela.";
  return "O site pode estar fora do ar até um deploy bem-sucedido: confira o endereço. Se a falha foi antes de o container novo subir, a versão anterior segue no ar.";
}

/** Deploy que falhou, ou que voltou a dar certo depois de falhar. */
export function deployNotification(e: DeployFinished): NotificationEvent | null {
  if (e.status === "failed") {
    return {
      kind: "deploy",
      key: `deploy-failed:${e.projectId}`,
      title: `Deploy de ${e.projectName} falhou`,
      body: [failedDeployOutcome(e), "O motivo está no log do deploy."],
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
