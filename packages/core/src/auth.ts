/**
 * auth.ts — tipos, constantes e validações compartilhadas da autenticação
 * do painel (conta admin, sessões e login).
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Nome do cookie de sessão em HTTP simples (httpOnly, SameSite=Strict). */
export const SESSION_COOKIE = "paas_session";

/**
 * Nome do cookie de sessão em HTTPS. O prefixo `__Host-` obriga Secure, Path=/
 * e proíbe Domain: um site irmão (outro `*.sslip.io`) não consegue gravar um
 * cookie com esse nome por cima do verdadeiro (cookie tossing).
 */
export const SESSION_COOKIE_SECURE = "__Host-paas_session";

/** Nome do cookie de sessão conforme o protocolo da conexão. */
export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

/** Duração da sessão: 12 horas. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Tentativas de login por IP antes do bloqueio. */
export const LOGIN_MAX_ATTEMPTS = 5;

/** Janela de contagem das tentativas de login (1 minuto). */
export const LOGIN_WINDOW_MS = 60 * 1000;

/**
 * Bloqueio POR CONTA do código de 6 dígitos da verificação em duas etapas
 * (vale para qualquer IP): 5 erros seguidos bloqueiam o código do app por
 * 5 min; cada nova reincidência dobra o tempo, até 24 h. O código de
 * recuperação continua aceito durante o bloqueio, e um login bem-sucedido
 * zera tudo.
 */
export const TWO_FACTOR_LOCK_MAX_FAILURES = 5;
export const TWO_FACTOR_LOCK_BASE_MS = 5 * 60 * 1000;
export const TWO_FACTOR_LOCK_MAX_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tipos da API
// ---------------------------------------------------------------------------

/** Forma pública do usuário admin (nunca expõe o hash da senha). */
export interface AdminUser {
  /** O que se digita no login. */
  username: string;
  createdAt: string;
  /** Nome mostrado no painel (Configurações → Perfil). null = mostra o usuário. */
  displayName?: string | null;
  /** E-mail de contato da conta (Configurações → Perfil). */
  email?: string | null;
}

/** PUT /api/settings/profile — só os campos que mudam; texto vazio apaga. */
export interface UpdateProfileRequest {
  displayName?: string;
  email?: string;
  /** Trocar o usuário de login exige `currentPassword`. */
  username?: string;
  currentPassword?: string;
}

export interface UpdateProfileResponse {
  user: AdminUser;
}

export const DISPLAY_NAME_MAX_LENGTH = 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validação simples de e-mail (formato nome@dominio.tld). */
export function validateEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

export interface CreateAdminRequest {
  username: string;
  password: string;
}

export interface CreateAdminResponse {
  ok: true;
  user: AdminUser;
}

export interface LoginRequest {
  username: string;
  password: string;
  /**
   * Código do app autenticador (6 dígitos) ou código de recuperação — só
   * quando a verificação em duas etapas está ativa. Sem ele, o login com a
   * senha certa responde 401 `two_factor_required`.
   */
  code?: string;
}

export interface LoginResponse {
  ok: true;
  user: AdminUser;
  expiresAt: string;
}

/** Onde fica o menu de navegação do painel (Configurações → Aparência). */
export type NavLayout = "top" | "left" | "right";
export const NAV_LAYOUTS: readonly NavLayout[] = ["top", "left", "right"];

/** Preferências de interface da conta — guardadas no servidor, valem em qualquer computador. */
export interface UserPreferences {
  navLayout: NavLayout;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = { navLayout: "top" };

/** PUT /api/settings/preferences — só os campos que mudam. */
export type UpdatePreferencesRequest = Partial<UserPreferences>;

export interface UpdatePreferencesResponse {
  preferences: UserPreferences;
}

export interface AuthMeResponse {
  user: AdminUser;
  session: { expiresAt: string };
  /** Chegam junto com a sessão: o painel já é desenhado no formato escolhido. */
  preferences: UserPreferences;
}

/** GET /api/version — só a versão do painel (ex.: "0.1.0"), nada mais. */
export interface PanelVersionResponse {
  version: string;
}

/** GET /api/auth/2fa */
export interface TwoFactorStatusResponse {
  enabled: boolean;
  /** Códigos de recuperação ainda não usados. */
  recoveryCodesLeft: number;
}

/** GET /api/security/edge — o painel está atrás do proxy da Cloudflare (nuvem laranja)? */
export interface EdgeStatusResponse {
  cloudflareProxy: boolean;
  lastSeenAt: string | null;
}

/** POST /api/auth/2fa/setup — segredo mostrado UMA vez, para o QR code. */
export interface TwoFactorSetupResponse {
  secret: string;
  otpauthUri: string;
}

/** POST /api/auth/2fa/enable e /api/auth/2fa/disable */
export interface TwoFactorConfirmRequest {
  currentPassword: string;
  code: string;
  /** Código por e-mail: só quando o usuário ligou esse fator (desativar o 2FA o exige). */
  emailCode?: string;
}

/** POST /api/auth/2fa/enable — códigos de recuperação, mostrados UMA vez. */
export interface TwoFactorEnableResponse {
  recoveryCodes: string[];
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  emailCode?: string;
}

// ---------------------------------------------------------------------------
// Validações (compartilhadas entre backend e frontend)
// ---------------------------------------------------------------------------

/** Regras de força de senha avaliadas individualmente (para checklist na UI). */
export interface PasswordStrength {
  valid: boolean;
  checks: {
    minLength: boolean;
    hasUpper: boolean;
    hasLower: boolean;
    hasNumber: boolean;
  };
}

export const PASSWORD_MIN_LENGTH = 12;

export function validatePasswordStrength(password: string): PasswordStrength {
  const checks = {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasNumber: /[0-9]/.test(password),
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}

/** Mensagens pt-BR das regras de senha não atendidas. */
export function passwordStrengthErrors(password: string): string[] {
  const { checks } = validatePasswordStrength(password);
  const errors: string[] = [];
  if (!checks.minLength) errors.push(`mínimo de ${PASSWORD_MIN_LENGTH} caracteres`);
  if (!checks.hasUpper) errors.push("ao menos uma letra maiúscula");
  if (!checks.hasLower) errors.push("ao menos uma letra minúscula");
  if (!checks.hasNumber) errors.push("ao menos um número");
  return errors;
}

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}
