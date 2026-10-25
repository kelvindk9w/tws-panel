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
  /** Alertas vivos (abertos ou reconhecidos) da origem: acha o que sobrou de antes de um reinício. */
  listActive(source: "certificate"): Promise<Alert[]>;
  resolveActive(source: "certificate", title: string): Promise<number>;
}

export interface CertificateAlertWatcherOptions {
  items: () => Promise<CertificateItem[]>;
  alerts: CertificateAlertsPort;
  notify: (event: NotificationEvent) => Promise<void>;
  log?: (message: string) => void;
}

/** Alertas dos domínios dos clientes (SaaS): UM por projeto, com a contagem e alguns nomes. */
const GROUP_TITLE_PREFIX = "Domínios dos clientes de ";
const GROUP_TITLE_SUFFIX = ": certificados com problema";

export function dynamicGroupTitle(projectLabel: string): string {
  return `${GROUP_TITLE_PREFIX}${projectLabel}${GROUP_TITLE_SUFFIX}`;
}

const TITLE_PREFIX = "Certificado de ";
/** O que vem depois do nome em cada título (mesma ordem de certificateAlertTitles). */
const TITLE_SUFFIXES = [
  " venceu",
  " está prestes a vencer",
  " não renovou e vence em breve",
  ": emissão falhando repetidamente",
  " segue sem emissão há mais de 24 horas",
] as const;

/** Os títulos possíveis de um nome (um alerta vivo por vez). */
export function certificateAlertTitles(host: string): string[] {
  return TITLE_SUFFIXES.map((suffix) => `${TITLE_PREFIX}${host}${suffix}`);
}

/** O nome (host) de um título de alerta automático; null se o título não é de um deles (ex.: certificado manual). */
export function hostOfAlertTitle(title: string): string | null {
  if (!title.startsWith(TITLE_PREFIX)) return null;
  for (const suffix of TITLE_SUFFIXES) {
    if (title.endsWith(suffix) && title.length > TITLE_PREFIX.length + suffix.length) {
      return title.slice(TITLE_PREFIX.length, title.length - suffix.length);
    }
  }
  return null;
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
  /** Nomes com problema já visto por este processo. Só acelera: o que sobrou de antes do reinício vem dos alertas abertos. */
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
    const groups = new Map<string, { label: string; problems: CertificateProblem[] }>();
    let groupsUnsure = false;
    try {
      for (const item of items) {
        if (item.mode !== "automatic") continue;
        if (item.dynamic) {
          // Domínio de cliente: nunca um alerta por nome (centenas de clientes = centenas de alertas). Agrupa por projeto.
          if (item.state === "unknown" || item.failureKnown === false) groupsUnsure = true;
          const problem = item.state === "unknown" ? null : certificateProblem(item);
          if (problem) {
            const key = item.owner.projectId ?? "";
            const group = groups.get(key) ?? { label: item.owner.projectName ?? key, problems: [] };
            group.problems.push(problem);
            groups.set(key, group);
          }
          continue;
        }
        seen.add(item.host);
        // Proxy parado = não deu para conferir, e não "está tudo bem": não mexe em nada.
        if (item.state === "unknown") continue;
        const problem = certificateProblem(item);
        // Log do Caddy ilegível ou vazio (container recriado): "sem falha" é desconhecido, não recuperação.
        // Sem problema agora, mantém o estado anterior: não resolve, não conta como conferência limpa.
        if (!problem && item.failureKnown === false) continue;
        await this.apply(item.host, problem, raised);
      }
      // Alerta aberto de nome que saiu da lista (projeto removido, virou manual): vale mesmo após reinício.
      const gone = new Set(this.tracked);
      for (const alert of await this.opts.alerts.listActive("certificate")) {
        const host = hostOfAlertTitle(alert.title);
        if (host) gone.add(host);
      }
      for (const host of gone) {
        if (!seen.has(host)) await this.apply(host, null, raised);
      }
      await this.applyGroups(groups, groupsUnsure, raised);
    } catch (err) {
      this.log(`Alertas de certificado: falha ao gravar (${err instanceof Error ? err.message : String(err)}).`);
    }
    await this.announce(raised);
  }

  /** Conferências limpas seguidas dos alertas agrupados (por título). */
  private readonly cleanGroups = new Map<string, number>();

  private async applyGroups(
    groups: Map<string, { label: string; problems: CertificateProblem[] }>,
    unsure: boolean,
    raised: CertificateProblem[],
  ): Promise<void> {
    const alerts = this.opts.alerts;
    const current = new Set<string>();
    for (const { label, problems } of groups.values()) {
      const title = dynamicGroupTitle(label);
      current.add(title);
      this.cleanGroups.delete(title);
      const worst: "critical" | "warning" = problems.some((p) => p.severity === "critical") ? "critical" : "warning";
      const sample = problems.slice(0, GROUP_LIST_MAX).map((p) => `${p.host}: ${p.short}`);
      const rest = problems.length - sample.length;
      if (rest > 0) sample.push(`e mais ${rest}`);
      const detail = `${problems.length} domínio(s) de clientes do projeto ${label} com problema de certificado. ${sample.join("; ")}. Abra Certificados para ver a causa de cada um; é comum o cliente ainda não ter apontado o DNS.`;
      const active = await alerts.findActive("certificate", title);
      const input = { severity: worst, source: "certificate" as const, title, detail };
      if (!active) {
        await alerts.create(input, { silent: true });
        raised.push({ host: label, title, severity: worst, short: `${problems.length} domínios de clientes com problema`, detail });
      } else if (active.status === "open" && (active.detail !== detail || active.severity !== worst)) {
        await alerts.create(input, { silent: true });
      }
    }
    if (unsure) return; // proxy parado ou log ilegível: não dá para dizer que melhorou
    for (const alert of await alerts.listActive("certificate")) {
      if (!alert.title.startsWith(GROUP_TITLE_PREFIX) || !alert.title.endsWith(GROUP_TITLE_SUFFIX) || current.has(alert.title)) continue;
      const count = (this.cleanGroups.get(alert.title) ?? 0) + 1;
      if (count < CLEAR_AFTER_CHECKS) {
        this.cleanGroups.set(alert.title, count);
        continue;
      }
      await alerts.resolveActive("certificate", alert.title);
      this.cleanGroups.delete(alert.title);
    }
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
