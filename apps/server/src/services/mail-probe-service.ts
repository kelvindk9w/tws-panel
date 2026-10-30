/**
 * mail-probe-service.ts — "Testar conexão a partir do app" (aba E-mail do projeto).
 *
 * Roda o teste do pacote mailer (packages/mailer/src/smtp-probe.ts) dentro do container do painel, que está na mesma
 * rede Docker dos projetos e resolve mail.<domínio> como o app resolve. Usa as credenciais REAIS da caixa do projeto
 * (as mesmas que o deploy entrega ao app), lidas na hora e nunca devolvidas.
 *
 * Um teste por vez por projeto (um segundo pedido enquanto o primeiro roda recebe 409): o teste abre uma conexão e
 * faz um login, então repetir em rajada viraria tentativa de login em excesso na caixa. O limite de pedidos por minuto
 * fica na rota.
 */
import type { MailProbeResult, Project } from "@paas/core";
import type { SmtpProbeOptions } from "@paas/mailer";
import { httpError } from "./http-error.js";

export interface MailProbeDeps {
  /** Valores SMTP que o painel entrega ao app; {} = e-mail desligado ou caixa sem senha. */
  smtpValues(project: Project): Promise<Record<string, string>>;
  probe(opts: SmtpProbeOptions): Promise<MailProbeResult>;
  audit?: { record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown> };
}

export class MailProbeService {
  private readonly running = new Set<string>();

  constructor(private readonly deps: MailProbeDeps) {}

  async run(project: Project, actor: string): Promise<MailProbeResult> {
    const env = await this.deps.smtpValues(project);
    const host = env.SMTP_HOST;
    const username = env.SMTP_USER;
    const password = env.SMTP_PASS;
    if (!host || !username || !password) {
      throw httpError(409, "email_not_enabled", "Ligue o e-mail do projeto (com uma caixa que tenha senha) antes de testar a conexão.");
    }
    const port = Number(env.SMTP_PORT) || 587;
    if (this.running.has(project.id)) throw httpError(409, "probe_running", "Já há um teste de conexão deste projeto em andamento.");
    this.running.add(project.id);
    try {
      const result = await this.deps.probe({ host, port, username, password });
      await this.deps.audit
        ?.record({
          actor,
          action: "mail.project.probe",
          target: project.id,
          detail: result.ok
            ? `Teste de conexão do e-mail do projeto "${project.name}": tudo certo.`
            : `Teste de conexão do e-mail do projeto "${project.name}": falhou em ${result.failedStep} (${result.failure}).`,
        })
        .catch(() => undefined);
      return result;
    } finally {
      this.running.delete(project.id);
    }
  }
}
