/**
 * mailboxes.ts — senhas fortes e bloco de credenciais IMAP/SMTP pronto para
 * cliente externo (Outlook, Gmail "verificar outras contas", Thunderbird).
 */
import { randomBytes, randomInt } from "node:crypto";
import type { MailboxCredentials, MailServerPorts } from "@paas/core";

/**
 * Gera senha forte URL/YAML-safe (base64url): sem aspas, espaços ou símbolos
 * que quebrem YAML/env files — importante porque a senha também é injetada
 * como env var nos projetos.
 */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
/**
 * Especiais da senha gerada: só `-`, `_` e `.`. São os "não reservados" da
 * RFC 3986 — passam sem escape numa URL smtp://usuario:senha@host, no .env do
 * compose, no YAML do override, num `export` de shell e no JSON. Ficam de
 * fora `$` (interpolação do compose), `#` (comentário no .env), aspas, `\`,
 * espaço, `:` (YAML), `@`, `/`, `%`, `&`, `!` e companhia.
 */
export const STRONG_PASSWORD_SPECIALS = "-_.";
const ALL = UPPER + LOWER + DIGITS + STRONG_PASSWORD_SPECIALS;

/**
 * Senha forte para a caixa do projeto ("Gerar uma senha forte para mim"):
 * sempre com maiúscula, minúscula, número e especial, começando com letra ou
 * número (um `-` no início pareceria opção de comando ou item de lista YAML).
 * `pick(n)` sorteia um inteiro em [0, n) — crypto.randomInt; injetável em teste.
 */
export function generateStrongPassword(length = 24, pick: (n: number) => number = (n) => randomInt(n)): string {
  if (length < 12) throw new RangeError("A senha gerada precisa de pelo menos 12 caracteres.");
  const chars = [UPPER, LOWER, DIGITS, STRONG_PASSWORD_SPECIALS].map((set) => set[pick(set.length)]!);
  while (chars.length < length) chars.push(ALL[pick(ALL.length)]!);
  // Fisher–Yates: os quatro tipos garantidos não ficam sempre no começo.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = pick(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  if (STRONG_PASSWORD_SPECIALS.includes(chars[0]!)) {
    const k = chars.findIndex((c) => !STRONG_PASSWORD_SPECIALS.includes(c));
    [chars[0], chars[k]] = [chars[k]!, chars[0]!];
  }
  return chars.join("");
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
