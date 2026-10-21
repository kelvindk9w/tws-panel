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
  "O painel não conseguiu autenticar no servidor de e-mail (a senha de administração guardada não é a do servidor em execução, o que acontece depois de restaurar o painel ou o e-mail). Use Reparar agora, na tela E-mail ou no aviso do Dashboard (regrava a configuração com a senha do painel e reinicia o servidor de e-mail, sem apagar dados) ou, em E-mail → Servidor, pare e inicie o servidor.";

export const MAIL_AUTH_REPAIR_FAILED_MESSAGE =
  "O painel tentou regravar a configuração e reiniciar o servidor de e-mail para acertar a senha de administração, mas o servidor continua recusando a senha guardada. Nada foi apagado. Próximo passo: em E-mail → Servidor, pare e inicie o servidor; se o erro continuar, confira no servidor (VPS) se o config.toml do contêiner paas-stalwart tem a mesma senha de administração do painel (o guia de restauração traz o comando, que só diz se são iguais ou diferentes) e olhe o log com docker logs paas-stalwart.";

export const MAIL_AUTH_STILL_REFUSED_MESSAGE =
  "O painel conferiu a senha de administração e o servidor de e-mail a aceita, mas a leitura foi recusada de novo. Nada foi reiniciado nem apagado. Próximo passo: tente Sincronizar mais uma vez; se repetir, olhe o log com docker logs paas-stalwart.";

/**
 * Depois de UMA tentativa de reparo que não resolveu: o erro diz o que o painel
 * tentou e o que fazer agora (nunca pede para reaplicar o que já foi feito).
 */
export function mailAuthRepairFailedError(result: "ok" | "failed" | "unreachable" | "not_running"): HttpError {
  if (result === "failed") return httpError(409, "mail_auth_repair_failed", MAIL_AUTH_REPAIR_FAILED_MESSAGE);
  if (result === "ok") return httpError(409, "mail_auth_still_refused", MAIL_AUTH_STILL_REFUSED_MESSAGE);
  if (result === "not_running") {
    return httpError(409, "mail_server_stopped", "O servidor de e-mail está parado. Inicie-o antes de continuar.");
  }
  return httpError(
    502,
    "mail_unreachable",
    "O painel tentou reparar a senha de administração, mas não conseguiu falar com o servidor de e-mail agora. Confira se ele está rodando em E-mail → Servidor e tente de novo. Nada foi alterado.",
  );
}

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

const NEXT_STEP_MESSAGE =
  "Próximo passo: em E-mail → Servidor, pare e inicie o servidor; se o erro continuar, confira no servidor (VPS) se a senha de administração do config.toml do contêiner paas-stalwart é a mesma do painel (o guia de restauração traz o comando, que só diz se são iguais ou diferentes) e olhe o log com docker logs paas-stalwart.";

/**
 * O reparo da senha parou no meio (falha ao copiar a configuração, ao
 * reiniciar ou o servidor demorou a voltar): não é verdade que "reiniciou e
 * continua recusando". O motivo vai curto e sem a senha de administração.
 */
export function mailAuthRepairIncompleteError(cause: unknown, secret: string | null): HttpError {
  let reason = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (secret) reason = reason.split(secret).join("***");
  reason = reason.replace(/\s+/g, " ").trim().slice(0, 160);
  return httpError(
    409,
    "mail_auth_repair_incomplete",
    `O reparo da senha de administração do servidor de e-mail não terminou${reason ? ` (${reason})` : ""}. Nada foi apagado. ${NEXT_STEP_MESSAGE}`,
  );
}
