/**
 * Tipos compartilhados do webmail (Roundcube em container, servido em
 * https://mail.<domínio>/ pelo Caddy central). Ver
 * comoFuncionaSistema/email/webmail.json.
 */

/** Nome do container do webmail gerenciado pelo painel. */
export const PAAS_WEBMAIL_CONTAINER = "paas-webmail";

/** Volume Docker do webmail (banco SQLite de preferências e sessões). */
export const PAAS_WEBMAIL_VOLUME = "paas_webmail_data";

/** Porta em que o webmail responde dentro da paas-net (imagem "nonroot": 8000). */
export const WEBMAIL_INTERNAL_PORT = 8000;

/**
 * Endereço do webmail de um host de e-mail. Com `user`, o campo "usuário"
 * já vem preenchido (o Roundcube lê `_user` da URL). A senha NUNCA vai na
 * URL: ficaria no histórico do navegador e nos logs.
 */
export function webmailUrl(host: string, user?: string | null): string {
  const base = `https://${host}/`;
  return user ? `${base}?_user=${encodeURIComponent(user)}` : base;
}

/** Endereço do webmail de um domínio de e-mail (mail.<domínio>). */
export interface WebmailLink {
  domain: string;
  host: string;
  url: string;
}

export interface WebmailStatus {
  /** A pessoa ativou o webmail (fica ligado junto com o servidor de e-mail). */
  enabled: boolean;
  /** O container existe. */
  installed: boolean;
  running: boolean;
  image: string;
  containerName: string;
  /** O servidor de e-mail (Stalwart) está rodando — sem ele o webmail não entra. */
  mailServerRunning: boolean;
  /**
   * O webmail confere o certificado do servidor de e-mail pelo nome. false =
   * o certificado de verdade ainda não foi instalado: a conexão interna é
   * cifrada, mas sem conferir o nome (ver webmail.json).
   */
  tlsVerified: boolean;
  /** Um endereço por domínio de e-mail cadastrado. */
  links: WebmailLink[];
  /** IPs bloqueados agora por excesso de senhas erradas. */
  blockedIps: number;
  /** Orientação em português quando algo está fora do esperado. */
  message: string | null;
}

export interface WebmailActionResponse {
  ok: true;
  status: WebmailStatus;
}
