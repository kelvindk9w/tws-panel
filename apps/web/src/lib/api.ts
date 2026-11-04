import { t } from "@/i18n/react";
import { SETUP_TOKEN_HEADER, SETUP_TOKEN_QUERY, type ApiError } from "@paas/core";

const STORAGE_KEY = "paas.setup-token";

/**
 * Lê o token da query string (?token=...) na primeira visita e persiste na
 * sessão, limpando a URL. IDEMPOTENTE: chamadas seguintes devolvem o token
 * já guardado na sessão (a URL já foi limpa na primeira).
 */
export function initSetupToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get(SETUP_TOKEN_QUERY);
  if (fromQuery) {
    sessionStorage.setItem(STORAGE_KEY, fromQuery);
    // remove o token da URL para não vazar em histórico/logs
    params.delete(SETUP_TOKEN_QUERY);
    const clean = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (clean ? `?${clean}` : ""));
    return fromQuery;
  }
  return sessionStorage.getItem(STORAGE_KEY);
}

// Captura o ?token= o MAIS CEDO possível: no carregamento do módulo, ANTES
// de o React renderizar. Sem isso o link do instalador (http://IP:9000/?token=...)
// se perdia: o guard de rotas redireciona "/" → "/setup" e o redirect do
// React Router pode derrubar a query string antes de qualquer useEffect rodar.
initSetupToken();

export function getSetupToken(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setSetupToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearSetupToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Payload extra do corpo de erro (ex.: report de guardrails no 409). */
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Evento disparado quando o servidor diz que a sessão do painel acabou (RequireAuth leva ao /login). */
export const SESSION_EXPIRED_EVENT = "paas:session-expired";

export interface ApiFetchInit extends RequestInit {
  /**
   * O que fazer se o servidor responder "sessão inválida ou expirada" (401):
   * "redirect" (padrão) leva ao login; "ignore" só devolve o erro — para quem
   * acompanha algo que derruba a sessão de propósito (reinício do painel).
   */
  onUnauthorized?: "redirect" | "ignore";
}

/** 401 de SESSÃO (não de senha errada nem de setup token): o servidor usa o código "unauthorized". */
function isSessionExpired(status: number, code: string, message: string): boolean {
  return status === 401 && code === "unauthorized" && !/setup token/i.test(message);
}

/** Fetch com header de setup token e tratamento de erro padronizado. */
export async function apiFetch<T>(path: string, options?: ApiFetchInit): Promise<T> {
  const { onUnauthorized = "redirect", ...init } = options ?? {};
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  // JSON por padrão; quem envia outra coisa (arquivo cru) informa o tipo.
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getSetupToken();
  if (token) headers.set(SETUP_TOKEN_HEADER, token);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiRequestError(0, "network_error", t("common.api.networkError"));
  }

  if (!response.ok) {
    let code = "http_error";
    let message = t("common.api.httpError", { status: response.status });
    let data: Record<string, unknown> | undefined;
    try {
      const body = (await response.json()) as Partial<ApiError> & Record<string, unknown>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
      data = body;
    } catch {
      // resposta não-JSON: mantém mensagem padrão
    }
    // /api/auth/me e /logout já têm tratamento próprio (guard e menu do usuário).
    if (onUnauthorized === "redirect" && isSessionExpired(response.status, code, message) && !/^\/api\/auth\/(me|logout)\b/.test(path)) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiRequestError(response.status, code, message, data);
  }
  if (response.status === 204) return undefined as T; // sem corpo
  return (await response.json()) as T;
}
