/**
 * login-messages.ts — textos (pt-BR) do aviso de tentativas restantes do login.
 * As durações vêm de 60·2^k s (IP) ou 300·2^k s (conta): sempre >= 60 s e nunca
 * exatamente 1 hora, por isso não há ramo de segundos nem "1 hora".
 */
export function attemptsText(n: number): string {
  return n === 1 ? "Resta 1 tentativa" : `Restam ${n} tentativas`;
}

export function durationText(sec: number): string {
  if (sec < 3600) {
    const m = Math.ceil(sec / 60);
    return m === 1 ? "1 minuto" : `${m} minutos`;
  }
  return `${Math.ceil(sec / 3600)} horas`;
}
