/**
 * auth.ts — tipos, constantes e validações compartilhadas da autenticação
 * do painel (conta admin, sessões e login).
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Nome do cookie de sessão (httpOnly, SameSite=Lax). */
export const SESSION_COOKIE = "paas_session";

/** Duração da sessão: 12 horas. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Tentativas de login por IP antes do bloqueio. */
export const LOGIN_MAX_ATTEMPTS = 5;

/** Janela de contagem das tentativas de login (1 minuto). */
export const LOGIN_WINDOW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Tipos da API
// ---------------------------------------------------------------------------

/** Forma pública do usuário admin (nunca expõe o hash da senha). */
export interface AdminUser {
  username: string;
  createdAt: string;
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
}

export interface LoginResponse {
  ok: true;
  user: AdminUser;
  expiresAt: string;
}

export interface AuthMeResponse {
  user: AdminUser;
  session: { expiresAt: string };
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
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
