/**
 * certificate-alerts.ts — alerta de certificado AUTOMÁTICO que não renovou.
 *
 * O Let's Encrypt parou de mandar e-mail de vencimento (04/06/2025): se a
 * renovação do Caddy falhar, ninguém é avisado. Este vigia lê a lista da
 * página Certificados (CertificateService.list: estado servido + log do Caddy)
 * e cria alertas (origem "certificate") para:
 *  - renewal_late: o Caddy devia ter renovado (falta ≤ 1/4 da validade) e não renovou;
 *  - vencimento próximo (crítico) e certificado vencido;
 *  - issuance_failing: o log mostra 3+ rodadas de falha durante 1 h ou mais.
 * As janelas são proporcionais à validade (90, 64, 45 ou 6 dias): ver
 * certificateThresholds e assessCertificateAlert em @paas/core. O certificado
 * MANUAL tem alertas próprios (CertificateService.checkExpiryAlerts).
 *
 * Contra spam:
 *  - histerese: entra pela avaliação (que já exige tempo e repetição para
 *    falhas) e só sai depois de 2 conferências seguidas sem problema;
 *  - o alerta que a pessoa já reconheceu não é recriado enquanto o problema
 *    durar (AlertsService.create só atualiza alerta ABERTO);
 *  - agrupamento: vários nomes que passam a ter problema na mesma rodada
 *    viram UM aviso fora do painel (Telegram/e-mail); cada nome tem o seu
 *    alerta no painel. Repetidos ainda passam pelo agrupamento de 10 min e
 *    pelo limite por hora do NotificationService.
 *
 * Extensível: o vigia só conhece CertificateItem (nome, modo, datas, alerta,
 * falha). Nomes que não estão no Caddyfile (emissão sob demanda) entram assim
 * que a lista os trouxer; nada aqui consulta projeto ou Caddyfile.
 */
import type { Alert, CertificateItem } from "@paas/core";
import type { NotificationEvent } from "./notification-service.js";

/** Conferências seguidas sem problema antes de resolver o alerta (histerese de saída). */
export const CLEAR_AFTER_CHECKS = 2;
/** Quantos nomes aparecem na linha do aviso agrupado. */
export const GROUP_LIST_MAX = 5;
/** Mais que isto numa rodada vira UM aviso agrupado (1 = sempre agrupa 2 ou mais). */
export const GROUP_FROM = 2;

export interface CertificateAlertsPort {
  create(
    input: { severity: Alert["severity"]; source: "certificate"; title: string; detail: string },
    opts?: { silent?: boolean },
  ): Promise<{ alert: Alert; created: boolean }>;
  findActive(source: "certificate", title: string): Promise<Alert | null>;
  resolveActive(source: "certificate", title: string): Promise<number>;
}

export interface CertificateAlertWatcherOptions {
  items: () => Promise<CertificateItem[]>;
  alerts: CertificateAlertsPort;
  notify: (event: NotificationEvent) => Promise<void>;
  log?: (message: string) => void;
}

/** Os títulos possíveis de um nome (um alerta vivo por vez). */
export function certificateAlertTitles(host: string): string[] {
  return [
    `Certificado de ${host} venceu`,
    `Certificado de ${host} está prestes a vencer`,
    `Certificado de ${host} não renovou e vence em breve`,
    `Certificado de ${host}: emissão falhando repetidamente`,
    `Certificado de ${host} segue sem emissão há mais de 24 horas`,
  ];
}

export interface CertificateProblem {
  host: string;
  title: string;
  severity: "warning" | "critical";
  /** Frase curta para a lista do aviso agrupado. */
  short: string;
  /** Texto completo: o que houve, a causa traduzida e o que fazer. */
  detail: string;
}

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "data desconhecida";
}

const GENERIC_ACTION =
  'Confira se as portas 80 e 443 estão abertas no firewall e se o DNS do nome aponta para esta VPS; depois use "Tentar emitir agora" em Certificados.';

/** Causa traduzida (e o que fazer) quando o log do Caddy a conhece; senão o roteiro genérico. */
function causeOf(item: CertificateItem): string {
  const message = item.failure?.error?.message ?? item.lastError?.message ?? null;
  return message ?? GENERIC_ACTION;
}

/** O problema do item (null = sem problema). Só certificado automático. */
export function certificateProblem(item: CertificateItem): CertificateProblem | null {
  if (item.mode !== "automatic" || item.alert.level === "none") return null;
  const { host } = item;
  const [expired, soon, late, failing, failingLong] = certificateAlertTitles(host) as [string, string, string, string, string];
  const critical = item.alert.level === "critical";
  switch (item.alert.reason) {
    case "expired":
      return {
        host,
        title: expired,
        severity: "critical",
        short: "venceu",
        detail:
          `O certificado HTTPS de ${host} venceu${item.validTo ? ` em ${day(item.validTo)}` : ""}: o navegador mostra o site como inseguro. ` +
          causeOf(item),
      };
    case "renewal_late":
      return {
        host,
        title: critical ? soon : late,
        severity: critical ? "critical" : "warning",
        short: critical ? "prestes a vencer" : "não renovou",
        detail:
          `O certificado de ${host} vence em ${day(item.validTo)}. O Caddy devia ter renovado por volta de ${day(item.renewsAround)} e não renovou. ` +
          causeOf(item),
      };
    case "issuance_failing": {
      const f = item.failure;
      const what = item.validTo ? `renovar o certificado de ${host} (o atual vence em ${day(item.validTo)})` : `emitir o certificado de ${host}`;
      return {
        host,
        title: critical ? failingLong : failing,
        severity: critical ? "critical" : "warning",
        short: critical ? "sem certificado há mais de 24 h" : "emissão falhando",
        detail: `O Caddy tentou ${what} ${f?.rounds ?? "várias"} vezes desde ${day(f?.firstAt ?? null)} e todas falharam. ${causeOf(item)}`,
      };
    }
    default:
      return null;
  }
}

const SEVERITY_LABEL = { critical: "crítico", warning: "atenção" } as const;

/** Aviso fora do painel de UM nome: título, gravidade e o texto completo (causa e o que fazer). */
export function singleNotification(p: CertificateProblem): NotificationEvent {
  return {
    kind: "certificate",
    key: `alert:certificate:${p.title}`,
    title: p.title,
    body: [`Gravidade: ${SEVERITY_LABEL[p.severity]}.`, p.detail],
    path: "/certificates",
  };
}

/** Aviso agrupado: vários nomes na mesma rodada, uma linha por nome (até GROUP_LIST_MAX). */
export function groupNotification(problems: CertificateProblem[]): NotificationEvent {
  const lines = problems.slice(0, GROUP_LIST_MAX).map((p) => `${p.host}: ${p.short}`);
  const rest = problems.length - lines.length;
  if (rest > 0) lines.push(`e mais ${rest}`);
  const worst = problems.some((p) => p.severity === "critical") ? "critical" : "warning";
  return {
    kind: "certificate",
    key: "cert-alerts-group",
    title: `${problems.length} certificados com problema`,
    body: [`Gravidade: ${SEVERITY_LABEL[worst]}.`, ...lines, 'Veja a causa de cada um em Certificados, no painel.'],
    path: "/certificates",
  };
}

export class CertificateAlertWatcher {
  /** Conferências seguidas sem problema, por nome em recuperação. */
  private readonly clean = new Map<string, number>();
  /** Nomes com problema já visto por este processo (para resolver o que sumiu da lista). */
  private readonly tracked = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(private readonly opts: CertificateAlertWatcherOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  async check(): Promise<void> {
    let items: CertificateItem[];
    try {
      items = await this.opts.items();
    } catch (err) {
      this.log(`Alertas de certificado: lista indisponível (${err instanceof Error ? err.message : String(err)}).`);
      return;
    }
    const raised: CertificateProblem[] = [];
    const seen = new Set<string>();
    try {
      for (const item of items) {
        if (item.mode !== "automatic") continue;
        seen.add(item.host);
        await this.apply(item.host, certificateProblem(item), raised);
      }
      for (const host of [...this.tracked]) {
        if (!seen.has(host)) await this.apply(host, null, raised);
      }
    } catch (err) {
      this.log(`Alertas de certificado: falha ao gravar (${err instanceof Error ? err.message : String(err)}).`);
    }
    await this.announce(raised);
  }

  private async apply(host: string, problem: CertificateProblem | null, raised: CertificateProblem[]): Promise<void> {
    const alerts = this.opts.alerts;
    if (problem) {
      this.tracked.add(host);
      this.clean.delete(host);
      // Um alerta vivo por nome: o que não vale mais (piorou ou melhorou de faixa) sai na hora.
      for (const title of certificateAlertTitles(host)) {
        if (title !== problem.title) await alerts.resolveActive("certificate", title);
      }
      const active = await alerts.findActive("certificate", problem.title);
      const input = { severity: problem.severity, source: "certificate" as const, title: problem.title, detail: problem.detail };
      if (!active) {
        await alerts.create(input, { silent: true });
        raised.push(problem);
      } else if (active.status === "open" && (active.detail !== problem.detail || active.severity !== problem.severity)) {
        await alerts.create(input, { silent: true });
      }
      return;
    }
    let alive = this.tracked.has(host);
    for (const title of certificateAlertTitles(host)) {
      if (!alive && (await alerts.findActive("certificate", title))) alive = true;
    }
    if (!alive) return;
    const count = (this.clean.get(host) ?? 0) + 1;
    if (count < CLEAR_AFTER_CHECKS) {
      this.clean.set(host, count);
      return;
    }
    for (const title of certificateAlertTitles(host)) await alerts.resolveActive("certificate", title);
    this.clean.delete(host);
    this.tracked.delete(host);
  }

  private async announce(raised: CertificateProblem[]): Promise<void> {
    if (raised.length === 0) return;
    const event = raised.length >= GROUP_FROM ? groupNotification(raised) : singleNotification(raised[0]!);
    try {
      await this.opts.notify(event);
    } catch (err) {
      this.log(`Alertas de certificado: aviso não enviado (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
}
