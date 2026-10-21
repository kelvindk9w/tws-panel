/**
 * mail-auth-error.ts — o 401/403 do Stalwart numa mensagem que diz o que fazer.
 *
 * A senha de administração do Stalwart mora no mail.json do painel e no
 * config.toml do container; depois de restaurar o painel ou o e-mail elas podem
 * divergir e toda chamada dá "You have to authenticate first". A mensagem é
 * única para todas as telas (E-mail, Envios, Webmail).
 */
import { StalwartApiError } from "@paas/mailer";
import { httpError, type HttpError } from "./http-error.js";

export const MAIL_AUTH_FAILED_MESSAGE =
  "O painel não conseguiu autenticar no servidor de e-mail (a senha de administração guardada não é a do servidor em execução, o que acontece depois de restaurar o painel ou o e-mail). Reaplique a configuração: pare e inicie o servidor de e-mail em E-mail → Servidor, ou use o aviso do Dashboard.";

/** 409 `mail_auth_failed` se o erro é um 401/403 do Stalwart; senão null (o erro segue como estava). */
export function mailAuthError(err: unknown): HttpError | null {
  if (err instanceof StalwartApiError && (err.status === 401 || err.status === 403)) {
    return httpError(409, "mail_auth_failed", MAIL_AUTH_FAILED_MESSAGE);
  }
  return null;
}

/**
 * Falha do Stalwart ao sincronizar (E-mail → Sincronizar): fora do ar ou outra
 * resposta de erro, em português. O 401/403 fica com `mailAuthError`. Null se
 * o erro não é do Stalwart.
 */
export function mailSyncError(err: unknown): HttpError | null {
  if (!(err instanceof StalwartApiError) || err.status === 401 || err.status === 403) return null;
  if (err.status === 0) {
    return httpError(
      502,
      "mail_unreachable",
      "O painel não conseguiu falar com o servidor de e-mail agora. Confira se ele está rodando em E-mail → Servidor e tente de novo. Nada foi alterado.",
    );
  }
  return httpError(502, "mail_sync_failed", `O servidor de e-mail respondeu com erro e nada foi alterado: ${err.message}`);
}
