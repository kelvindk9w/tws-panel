/**
 * onboarding-sources.ts — estado real do e-mail para o roteiro de primeiros
 * passos (services/onboarding.ts).
 *
 * A instância do MailService das rotas fica encapsulada no plugin de e-mail
 * (Fastify não a expõe aos outros plugins). Aqui cada consulta usa uma
 * instância NOVA, só para leitura: ela lê data/mail/mail.json na hora (nunca
 * um cache antigo) e só consulta o Docker quando o servidor já foi criado —
 * o mesmo que GET /api/mail/status faz. Fora da cobertura unitária pelo mesmo
 * motivo de mail-service.ts (fala com o Docker).
 */
import type { ServerConfig } from "../config.js";
import { MailService } from "./mail-service.js";
import type { EmailFacts } from "./onboarding.js";

export function mailFactsSource(config: ServerConfig): () => Promise<EmailFacts> {
  return async () => {
    const mail = new MailService(config, { log: () => undefined });
    const domains = (await mail.listDomains()).map((d) => ({
      name: d.name,
      dnsOk: d.lastVerify ? d.lastVerify.total > 0 && d.lastVerify.ok === d.lastVerify.total : null,
    }));
    let installed = false;
    let running: boolean | null = null;
    try {
      const status = await mail.status();
      installed = status.installed;
      running = status.running;
    } catch {
      // Docker indisponível: o servidor existe (há segredo), mas não deu para
      // conferir se está ligado — o passo mostra "não confirmado".
      installed = true;
      running = null;
    }
    return { installed, running, domains };
  };
}
