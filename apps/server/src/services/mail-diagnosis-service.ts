/**
 * mail-diagnosis-service.ts — diagnóstico de e-mail do projeto: "Última tentativa de conexão do app", "Por que nada
 * chegou" (só quando não houve envio na janela) e os avisos do Laravel (fila sem worker, LOG_CHANNEL).
 *
 * Reúne fatos de vários serviços e deixa as regras em funções puras (mail-hints.ts e, no pacote deploy,
 * laravel-queue.ts). Nada aqui devolve valor de variável: só nomes e códigos. As senhas são comparadas em memória
 * (para saber se uma variável do app tem o valor certo) e nunca saem.
 */
import type {
  MailLastAttempt,
  MailRefusalKind,
  MailRefusalsResponse,
  MailSendListResponse,
  Project,
  ProjectEmailConfig,
  ProjectMailDiagnosis,
  ProjectNotice,
} from "@paas/core";
import { laravelNotices, queueWithoutWorker, silentMailer, type LaravelDefaults, type LaravelFacts } from "@paas/deploy";
import { buildMailHints } from "./mail-hints.js";

/** Janela olhada para dizer que "não houve envio". */
export const DIAGNOSIS_WINDOW_HOURS = 24;

/** Variáveis do Laravel que o painel precisa fornecer e o valor do e-mail que cada uma deve receber. */
export const LARAVEL_MAIL_LINKS = { MAIL_HOST: "SMTP_HOST", MAIL_USERNAME: "SMTP_USER", MAIL_PASSWORD: "SMTP_PASS" } as const;

export interface MailDiagnosisDeps {
  emailConfig(projectId: string): Promise<ProjectEmailConfig>;
  /** Quando o e-mail mudou pela última vez (ISO); null = desligado. */
  emailChangedAt(projectId: string): Promise<string | null>;
  /** Valores que o painel entrega ao app (com a senha), só para comparar em memória. */
  emailValues(project: Project): Promise<Record<string, string>>;
  testInboxEnabled(project: Project): Promise<boolean>;
  sends(filter: { projectId: string; limit: number }): Promise<Pick<MailSendListResponse, "items" | "total">>;
  refusals(query: { projectId: string; limit: number }): Promise<Pick<MailRefusalsResponse, "items" | "total">>;
  /** Variáveis salvas pela pessoa no projeto. */
  savedEnv(project: Project): Promise<Record<string, string>>;
  /** Pasta do código do projeto e arquivo do compose (se for compose). */
  sourceDir(project: Project): string;
  detectFramework(srcDir: string): Promise<"laravel" | null>;
  hasQueueWorker(srcDir: string, composeFile: string | null): Promise<boolean>;
  readLaravelDefaults(srcDir: string): Promise<LaravelDefaults>;
  /** QUEUE_CONNECTION/MAIL_MAILER/LOG_* que o próprio projeto define (compose, env_file, Dockerfile). */
  readProjectFileEnv(srcDir: string, composeFile: string | null): Promise<Record<string, string>>;
  now?: () => number;
}

/**
 * Quando o app passou a rodar com o e-mail atual. Deploy que falhou não conta (muda lastDeployAt sem aplicar nada) e
 * "Reiniciar" aplica sem mexer em lastDeployAt: por isso o campo próprio. Projeto de antes dele: último deploy BEM-SUCEDIDO.
 * Nunca aplicado = nenhum "precisa reiniciar" (o app ainda nem subiu).
 */
function appliedAt(project: Project): string {
  if (project.mailAppliedAt) return project.mailAppliedAt;
  if (project.mailAppliedAt === undefined && project.lastDeployStatus === "success" && project.lastDeployAt) return project.lastDeployAt;
  return "9999-12-31T23:59:59.999Z";
}

export class MailDiagnosisService {
  private readonly now: () => number;

  constructor(private readonly deps: MailDiagnosisDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async laravelFacts(project: Project): Promise<LaravelFacts | null> {
    const srcDir = this.deps.sourceDir(project);
    if ((await this.deps.detectFramework(srcDir).catch(() => null)) !== "laravel") return null;
    const composeFile = project.detection?.type === "compose" ? (project.detection.composeFile ?? null) : null;
    const [env, defaults, hasWorker, fileEnv] = await Promise.all([
      this.deps.savedEnv(project).catch(() => ({}) as Record<string, string>),
      this.deps.readLaravelDefaults(srcDir),
      // Não conseguiu olhar = não afirma que falta worker.
      this.deps.hasQueueWorker(srcDir, composeFile).catch(() => true),
      this.deps.readProjectFileEnv(srcDir, composeFile).catch(() => ({}) as Record<string, string>),
    ]);
    return { env, defaults, hasWorker, fileEnv };
  }

  /**
   * `noticesOnly`: só os avisos do Laravel (visão geral do projeto) — sem olhar envios, recusas nem o e-mail, que
   * custam leituras de disco e de serviço que a visão geral não usa.
   */
  async diagnose(project: Project, opts: { noticesOnly?: boolean } = {}): Promise<ProjectMailDiagnosis> {
    if (opts.noticesOnly) {
      const facts = await this.laravelFacts(project);
      return { windowHours: DIAGNOSIS_WINDOW_HOURS, noSendsRecent: false, hints: [], notices: facts ? laravelNotices(facts) : [], lastAttempt: null };
    }
    const now = this.now();
    const since = now - DIAGNOSIS_WINDOW_HOURS * 3_600_000;
    const [email, changedAt, sends, refusals, facts, testInboxOn] = await Promise.all([
      this.deps.emailConfig(project.id),
      this.deps.emailChangedAt(project.id),
      this.deps.sends({ projectId: project.id, limit: 1 }),
      this.deps.refusals({ projectId: project.id, limit: 200 }),
      this.laravelFacts(project),
      this.deps.testInboxEnabled(project).catch(() => false),
    ]);

    const lastSend = sends.items[0]?.at ?? null;
    const lastRefusal = refusals.items[0] ?? null;
    let lastAttempt: MailLastAttempt | null = null;
    if (lastSend && (!lastRefusal || lastSend >= lastRefusal.at)) lastAttempt = { at: lastSend, outcome: "accepted", kind: null };
    else if (lastRefusal) lastAttempt = { at: lastRefusal.at, outcome: "refused", kind: lastRefusal.kind };

    const noSendsRecent = !lastSend || Date.parse(lastSend) < since;
    const notices = facts ? laravelNotices(facts) : [];
    if (!noSendsRecent) {
      return { windowHours: DIAGNOSIS_WINDOW_HOURS, noSendsRecent, hints: [], notices, lastAttempt };
    }

    const recent = refusals.items.filter((r) => Date.parse(r.at) >= since);
    const counts = new Map<MailRefusalKind, number>();
    for (const r of recent) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    const topKind = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const env = facts?.env ?? (await this.deps.savedEnv(project).catch(() => ({}) as Record<string, string>));
    const mailerFacts: LaravelFacts = facts ?? { env, defaults: { queue: null, mail: null, log: null }, hasWorker: true };
    const hints = buildMailHints({
      emailEnabled: email.enabled,
      hasMailbox: email.enabled && email.mailbox !== null && Object.keys(await this.deps.emailValues(project)).length > 0,
      testInboxOn,
      emailNeedsRestart: email.enabled && changedAt !== null && changedAt > appliedAt(project),
      silentMailer: silentMailer(mailerFacts),
      laravel: facts !== null,
      unlinked: facts && email.enabled ? await this.unlinkedNames(project, email, facts) : [],
      queueWithoutWorker: facts !== null && queueWithoutWorker(facts),
      refusals: { count: recent.length, topKind },
      neverConnected: sends.total === 0 && refusals.total === 0,
    });
    return { windowHours: DIAGNOSIS_WINDOW_HOURS, noSendsRecent, hints, notices, lastAttempt };
  }

  /** Nomes MAIL_* do Laravel que não chegam com o valor do e-mail do painel (nem ligados, nem iguais). */
  private async unlinkedNames(project: Project, email: ProjectEmailConfig, facts: LaravelFacts): Promise<string[]> {
    const expected = await this.deps.emailValues(project);
    const links = email.envLinks ?? {};
    const out: string[] = [];
    for (const [name, source] of Object.entries(LARAVEL_MAIL_LINKS)) {
      const linked = links[name] === source;
      const same = facts.env[name] !== undefined && expected[source] !== undefined && facts.env[name] === expected[source];
      if (!linked && !same) out.push(name);
    }
    return out;
  }
}
