/**
 * mailboxes.ts — senhas fortes e bloco de credenciais IMAP/SMTP pronto para
 * cliente externo (Outlook, Gmail "verificar outras contas", Thunderbird).
 */
import { randomBytes } from "node:crypto";
import type { MailboxCredentials, MailServerPorts } from "@paas/core";

/**
 * Gera senha forte URL/YAML-safe (base64url): sem aspas, espaços ou símbolos
 * que quebrem YAML/env files — importante porque a senha também é injetada
 * como env var nos projetos.
 */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

export interface CredentialsInput {
  email: string;
  /** Hostname público do servidor de e-mail (mail.<domínio>). */
  host: string;
  ports: MailServerPorts;
}

/**
 * Monta o bloco de configuração para um cliente de e-mail. SEM a senha:
 * ela nunca aparece na tela (pedido do dono do produto, 02/10/2026) — a
 * pessoa usa a senha que definiu e, se esqueceu, troca.
 */
export function buildCredentials(input: CredentialsInput): MailboxCredentials {
  const { email, host, ports } = input;
  return {
    email,
    username: email,
    imap: { host, port: ports.imaps, security: "ssl" },
    imapAlt: { host, port: ports.imap, security: "starttls" },
    smtp: { host, port: ports.submission, security: "starttls" },
    smtpAlt: { host, port: ports.submissions, security: "ssl" },
    notes: [
      "Usuário = endereço de e-mail completo (não apenas a parte antes do @).",
      "Senha = a que você definiu ao criar a caixa. Esqueceu? Use \"Trocar senha\" na lista de caixas.",
      "Recebimento (IMAP): prefira SSL na porta " + ports.imaps + ".",
      "Envio (SMTP): porta " + ports.submission + " com STARTTLS (padrão) ou " + ports.submissions + " com SSL.",
      "No Gmail: Configurações → Contas → 'Adicionar outro endereço de e-mail' (envio) e 'Verificar e-mails de outras contas' (recebimento).",
      "Sem autenticação anônima: sempre marque 'autenticar com usuário e senha' no envio.",
    ],
  };
}
