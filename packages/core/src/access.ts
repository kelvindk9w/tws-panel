/**
 * access.ts — recuperação e gestão do acesso à VPS pelo painel: chaves SSH do
 * usuário de administração, senha desse usuário no Linux, bloqueios do fail2ban,
 * kit de recuperação e o código por e-mail (fator EXTRA opcional).
 *
 * Tipos e funções puras compartilhados entre servidor e interface.
 */

// ---------------------------------------------------------------------------
// Código por e-mail
// ---------------------------------------------------------------------------

/** Validade do código por e-mail (uso único). */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
/** Erros seguidos que invalidam o código pendente (é preciso pedir outro). */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Intervalo mínimo entre dois envios do mesmo usuário. */
export const EMAIL_CODE_RESEND_GAP_MS = 30_000;
/** Envios por hora, por usuário. */
export const EMAIL_CODE_MAX_SENDS_PER_HOUR = 5;

/**
 * Ações para as quais um código por e-mail pode ser pedido. O código fica preso à ação para a qual foi pedido
 * (um código "para o kit" não vale para "adicionar chave") e o e-mail diz qual é.
 */
export const EMAIL_CODE_ACTIONS = {
  "access.keys": "gerenciar as chaves SSH da VPS",
  "access.password": "trocar a senha do usuário Linux da VPS",
  "access.unban": "desbloquear um IP no fail2ban",
  "access.kit": "gerar o kit de recuperação",
  "auth.2fa-disable": "desligar a verificação em duas etapas",
  "auth.recovery-codes": "gerar códigos de recuperação novos",
  "auth.password": "trocar a senha do painel",
  "setup.restart": "recomeçar o assistente de configuração",
  "token.create": "criar um token de API",
  "token.edit": "ampliar um token de API",
  "email.toggle": "ligar ou desligar o código por e-mail",
  "terminal.enable": "habilitar o terminal web da VPS",
  "deploy.override": "liberar os bloqueios de segurança de um deploy",
  "docker.buildx": "instalar o plugin buildx do Docker na VPS",
  "database.write": "alterar ou apagar dados do banco de um projeto",
} as const;

export type EmailCodeAction = keyof typeof EMAIL_CODE_ACTIONS;

export function isEmailCodeAction(value: unknown): value is EmailCodeAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EMAIL_CODE_ACTIONS, value);
}

/** Código de 6 dígitos (espaços ignorados). */
export function looksLikeEmailCode(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ""));
}

/** GET /api/auth/email-code */
export interface EmailCodeStatusResponse {
  /** Preenchido quando o alerta por e-mail da mudança NÃO pôde sair (o motivo, em português); a tela mostra. */
  alertWarning?: string;
  /** O fator está ligado para as ações sensíveis de acesso. */
  enabled: boolean;
  enabledAt: string | null;
  /** Precisa estar ligada para ligar o código por e-mail (ele é um fator EXTRA). */
  twoFactorEnabled: boolean;
  /** Endereço do administrador, mascarado (ex.: a***@example.com). Null = não cadastrado. */
  address: string | null;
  /** O domínio do endereço é uma caixa hospedada nesta própria VPS (dependência circular). Null = não deu para saber. */
  hostedHere: boolean | null;
  /** O envio de e-mail do painel está pronto. */
  mailReady: boolean;
  /** Por que o envio não está pronto (null quando está). */
  mailReason: string | null;
  /** Dá para ligar agora (2FA ligado, endereço cadastrado e envio pronto). */
  canEnable: boolean;
}

/** POST /api/auth/email-code/send */
export interface EmailCodeSendResponse {
  sentTo: string;
  expiresInSec: number;
  resendAfterSec: number;
}

/** POST /api/auth/email-code/enable e /disable */
export interface EmailCodeToggleRequest {
  currentPassword: string;
  code: string;
  emailCode: string;
}

// ---------------------------------------------------------------------------
// Reautenticação das ações sensíveis
// ---------------------------------------------------------------------------

/** Senha do painel + código do app (2FA) + (quando o fator está ligado) o código por e-mail. */
export interface AccessCredentials {
  currentPassword: string;
  code?: string;
  emailCode?: string;
}

// ---------------------------------------------------------------------------
// Chaves SSH
// ---------------------------------------------------------------------------

export interface ParsedSshPublicKey {
  type: string;
  /** Parte base64 da chave (o que identifica a chave). */
  blob: string;
  comment: string;
  /** Tamanho em bits (só RSA); null nos demais tipos. */
  bits: number | null;
}

export const SSH_RSA_MIN_BITS = 3072;

const SSH_LINE_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]{40,}={0,2})(?: ([^\x00-\x1f\x7f'"\\]{0,120}))?$/;

function decodeBase64(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Inteiro de 32 bits em ordem de rede; além do fim do blob lê zeros (quem chama confere os tamanhos). */
function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

/** Tamanho do módulo de uma chave ssh-rsa (bits) a partir do blob; null se o blob não bate. */
function rsaBits(blob: Uint8Array): number | null {
  let at = 4 + "ssh-rsa".length; // o nome do tipo já foi conferido por quem chama
  const eLen = readUint32(blob, at);
  if (eLen > 16) return null;
  at += 4 + eLen;
  const nLen = readUint32(blob, at);
  if (nLen < 1 || at + 4 + nLen > blob.length) return null;
  at += 4;
  let i = 0;
  while (i < nLen && blob[at + i] === 0) i += 1;
  if (i >= nLen) return null;
  const first = blob[at + i]!;
  const leadingZeroBits = Math.clz32(first) - 24;
  return (nLen - i) * 8 - leadingZeroBits;
}

/**
 * Interpreta UMA linha de chave pública no formato do authorized_keys, sem
 * opções na frente (nada de `command=`, `from=`...): só o tipo, a chave e um
 * comentário. Null = formato inválido ou blob que não bate com o tipo.
 */
export function parseSshPublicKey(line: string): ParsedSshPublicKey | null {
  const trimmed = line.trim();
  if (trimmed.length < 50 || trimmed.length > 2048) return null;
  const m = SSH_LINE_RE.exec(trimmed);
  if (!m) return null;
  const type = m[1]!;
  const blobText = m[2]!;
  const bytes = decodeBase64(blobText);
  if (!bytes) return null;
  if (readUint32(bytes, 0) !== type.length) return null;
  if (String.fromCharCode(...bytes.slice(4, 4 + type.length)) !== type) return null;
  let bits: number | null = null;
  if (type === "ssh-rsa") {
    bits = rsaBits(bytes);
    if (bits === null) return null;
  }
  return { type, blob: blobText, comment: (m[3] ?? "").trim(), bits };
}

/** Chave aceita para ser ADICIONADA pelo painel: formato certo e, se RSA, com pelo menos 3072 bits. */
export function checkNewSshPublicKey(line: string): { ok: true; key: ParsedSshPublicKey } | { ok: false; reason: string } {
  const key = parseSshPublicKey(line);
  if (!key) {
    return {
      ok: false,
      reason:
        "Chave pública inválida. Cole a linha inteira do arquivo .pub (começa com ssh-ed25519, ssh-rsa ou ecdsa-sha2-...), sem opções na frente.",
    };
  }
  if (key.type === "ssh-rsa" && (key.bits as number) < SSH_RSA_MIN_BITS) {
    return { ok: false, reason: `Chave RSA fraca (${key.bits} bits). Use ssh-ed25519 ou RSA de pelo menos ${SSH_RSA_MIN_BITS} bits.` };
  }
  return { ok: true, key };
}

export interface SshKeyInfo {
  /** SHA256:... (como o ssh-keygen -l mostra). */
  fingerprint: string;
  type: string;
  comment: string;
  bits: number | null;
  /** A linha tem opções na frente (command=, from=...): foi posta à mão; o painel não as cria. */
  hasOptions: boolean;
}

/** Entrada do authorized_keys que o painel não gere (tipo não reconhecido, como sk-* ou certificado): só leitura. */
export interface OtherKeyInfo {
  /** Tipo como está na linha (ex.: sk-ssh-ed25519@openssh.com); "desconhecido" se a linha não deu para ler. */
  type: string;
  /** SHA256:... quando o conteúdo da chave pôde ser lido; null caso contrário. */
  fingerprint: string | null;
  comment: string;
}

/** GET /api/security/access */
export interface AccessStatusResponse {
  /** O painel consegue gerir o acesso (alvo é a VPS real e há usuário de administração). */
  available: boolean;
  /** Por que não está disponível (null quando está). */
  reason: string | null;
  /** Usuário Linux de administração (o do terminal e do SSH). */
  user: string | null;
  twoFactorEnabled: boolean;
  emailCodeEnabled: boolean;
  keys: SshKeyInfo[];
  /** Chaves de tipos que o painel não gere (somente leitura; o sshd as aceita). */
  otherKeys: OtherKeyInfo[];
  /** Existe um authorized_keys2 com conteúdo (o sshd também o lê; o painel não mexe nele). */
  authorizedKeys2: boolean;
  /** O sshd usa outro arquivo de chaves que não o ~/.ssh/authorized_keys (o painel então não grava nada). */
  authorizedKeysFileCustom: string | null;
  /** Falha ao ler as chaves (a lista vem vazia). */
  keysError: string | null;
}

export interface AddSshKeyRequest extends AccessCredentials {
  publicKey: string;
}

/** Respostas das ações de acesso que avisam o dono por e-mail. */
export interface AccessAlertInfo {
  /** Preenchido quando o alerta por e-mail da mudança NÃO pôde sair (o motivo, em português); a tela mostra. */
  alertWarning?: string;
}

export interface RemoveSshKeyRequest extends AccessCredentials {
  fingerprint: string;
}

export interface SetLinuxPasswordRequest extends AccessCredentials {
  newLinuxPassword: string;
}

/** Senha do usuário Linux: tamanho e caracteres seguros para o chpasswd (uma linha). */
export function linuxPasswordErrors(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 12) errors.push("pelo menos 12 caracteres");
  if (password.length > 128) errors.push("no máximo 128 caracteres");
  if (/[\r\n\0]/.test(password)) errors.push("sem quebras de linha");
  return errors;
}

// ---------------------------------------------------------------------------
// fail2ban
// ---------------------------------------------------------------------------

export interface BanJail {
  jail: string;
  ips: string[];
  /** A saída do fail2ban foi cortada no limite: a lista pode estar incompleta. */
  partial?: boolean;
}

/** GET /api/security/access/bans */
export interface BansResponse {
  /** Preenchido quando o alerta por e-mail da mudança NÃO pôde sair (o motivo, em português); a tela mostra. */
  alertWarning?: string;
  available: boolean;
  reason: string | null;
  jails: BanJail[];
  /** IP de quem está com o painel aberto (para destacar "este é o seu IP"). */
  yourIp: string | null;
}

export interface UnbanRequest extends AccessCredentials {
  ip: string;
}

// ---------------------------------------------------------------------------
// Kit de recuperação
// ---------------------------------------------------------------------------

/** POST /api/security/access/kit — nada secreto: nenhuma senha, chave privada ou código. */
export interface RecoveryKitResponse {
  generatedAt: string;
  panelAddress: string | null;
  panelAddressIp: string | null;
  linuxUser: string | null;
  sshPort: number | null;
  keys: SshKeyInfo[];
  /** Impressão digital da chave do servidor (para conferir o "primeiro acesso"). Vazio se não deu para ler. */
  hostKeys: string[];
  recoveryCodesLeft: number;
  emailCodeEnabled: boolean;
  installDir: string;
}

// ---------------------------------------------------------------------------
// Códigos de recuperação do 2FA
// ---------------------------------------------------------------------------

/** Quando restam este tanto de códigos de recuperação (ou menos), o painel avisa. */
export const RECOVERY_CODES_LOW = 3;

/** POST /api/auth/2fa/recovery-codes */
export interface RegenerateRecoveryCodesRequest extends AccessCredentials {
  currentPassword: string;
}

export interface RegenerateRecoveryCodesResponse extends AccessAlertInfo {
  recoveryCodes: string[];
}
