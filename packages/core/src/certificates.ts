/**
 * certificates.ts — página Certificados: todos os nomes que o painel serve
 * por HTTPS (painel, domínios dos projetos e mail.<domínio>), o estado do
 * certificado de cada um e o modo (automático pelo Caddy ou manual).
 */

/** A quem o nome pertence. */
export type CertificateOwnerKind = "panel" | "project" | "mail";

export interface CertificateOwner {
  kind: CertificateOwnerKind;
  /** Projeto (só quando kind = "project"). */
  projectId: string | null;
  projectName: string | null;
}

/**
 * - automatic: o Caddy emite e renova sozinho (Let's Encrypt, ZeroSSL de reserva);
 * - manual: certificado enviado pela pessoa; NÃO renova sozinho.
 */
export type CertificateMode = "automatic" | "manual";

/**
 * Estado do certificado servido de verdade:
 * - valid: válido e longe do fim;
 * - issuing: ainda sem certificado, emissão em andamento (ou esperando a próxima tentativa sem erro conhecido);
 * - failed: sem certificado e a última tentativa do Caddy falhou;
 * - expiring: válido, mas perto do fim (manual a 30 dias; automático que não renovou a 20 dias);
 * - expired: o certificado servido já venceu;
 * - unknown: não foi possível conferir (proxy fora do ar).
 */
export type CertificateState = "valid" | "issuing" | "failed" | "expiring" | "expired" | "unknown";

/** Causa provável de uma falha de emissão, traduzida para leigo. */
export type CertificateErrorCause = "dns" | "cloudflare" | "firewall" | "rate_limit" | "caa" | "unknown";

export interface CertificateIssueError {
  cause: CertificateErrorCause;
  /** Explicação em pt-BR, com o que fazer. */
  message: string;
  /** Trecho da mensagem do Caddy (texto não confiável, já limitado e sem caracteres de controle). */
  detail: string | null;
  /** Quando aconteceu (ISO), se o log informa. */
  at: string | null;
  /** Limite do Let's Encrypt: a partir de quando dá para tentar de novo (ISO). */
  retryAfter: string | null;
}

export interface ManualCertificateInfo {
  /** Emissor (organização ou nome) do certificado enviado. */
  issuer: string | null;
  validFrom: string;
  validTo: string;
  /** Nomes que o certificado cobre (ex.: "*.exemplo.com.br"). */
  names: string[];
  installedAt: string;
}

export interface CertificateItem {
  host: string;
  owner: CertificateOwner;
  mode: CertificateMode;
  /**
   * Modo manual herdado: o nome não tem certificado próprio, mas um
   * certificado manual de outro nome (wildcard) o cobre — o Caddy usa esse e
   * não emite um automático para este nome.
   */
  coveredBy: string | null;
  state: CertificateState;
  issuer: string | null;
  validTo: string | null;
  /** Automático: data aproximada da renovação (validade − 30 dias). */
  renewsAround: string | null;
  /** Último erro de emissão (só quando não há certificado válido). */
  lastError: CertificateIssueError | null;
  /** Certificado manual deste nome (nunca a chave). */
  manual: ManualCertificateInfo | null;
  /** Dá para pedir "Tentar emitir agora" (automático sem certificado válido). */
  canRetry: boolean;
}

export interface CertificateListResponse {
  checkedAt: string;
  /** O proxy central (Caddy) está rodando. */
  proxyRunning: boolean;
  items: CertificateItem[];
}

export interface CertificateRetryResponse {
  host: string;
  /** Mensagem para a pessoa (pt-BR). */
  message: string;
}

export interface InstallManualCertificateRequest {
  /** PEM do certificado, com a cadeia (intermediários). */
  certificate: string;
  /** PEM da chave privada. Nunca volta pela API. */
  privateKey: string;
}

export interface CertificateItemResponse {
  item: CertificateItem;
}
