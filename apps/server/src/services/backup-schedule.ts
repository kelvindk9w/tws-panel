/**
 * backup-schedule.ts — regras de horário dos backups (funções puras).
 *
 * Horários: o primeiro do dia às `hour` (03:00 por padrão), no fuso da VPS
 * (o container do painel monta o /etc/localtime do servidor, ver
 * docker-compose.yml), e depois a cada `frequencyHours` (24, 12 ou 6 h).
 * Ex.: a cada 6 h = 03:00, 09:00, 15:00 e 21:00.
 */
import { BACKUP_PASSWORD_REMINDER_DAYS } from "@paas/core";

const HOUR_MS = 3_600_000;

/** O horário de backup mais recente que já chegou (<= now). */
export function currentSlot(now: number, frequencyHours: number, hour: number): number {
  const anchor = new Date(now);
  anchor.setHours(hour, 0, 0, 0);
  let slot = anchor.getTime();
  if (slot > now) {
    const prev = new Date(slot);
    prev.setDate(prev.getDate() - 1);
    slot = prev.getTime();
  }
  const step = frequencyHours * HOUR_MS;
  while (slot + step <= now) slot += step;
  return slot;
}

/** O próximo horário de backup (> now). */
export function nextSlot(now: number, frequencyHours: number, hour: number): number {
  return currentSlot(now, frequencyHours, hour) + frequencyHours * HOUR_MS;
}

/** Sem backup externo conferido há mais que isto = atrasado: 2 dias ou 2× a frequência. */
export function remoteStaleThresholdMs(frequencyHours: number): number {
  return Math.max(48 * HOUR_MS, 2 * frequencyHours * HOUR_MS);
}

export function isRemoteStale(input: {
  lastVerifiedAt: number | null;
  /** Desde quando o item tem backup externo (destino conectado / item ligado). */
  since: number;
  now: number;
  frequencyHours: number;
}): boolean {
  const base = input.lastVerifiedAt ?? input.since;
  return input.now - base > remoteStaleThresholdMs(input.frequencyHours);
}

/** "Você ainda tem sua senha de backup?" — a cada 3 meses sem teste certo nem lembrete. */
export function isReminderDue(input: {
  passwordSetAt: number | null;
  lastTestOkAt: number | null;
  lastReminderAt: number | null;
  now: number;
}): boolean {
  if (input.passwordSetAt === null) return false;
  const base = Math.max(input.passwordSetAt, input.lastTestOkAt ?? 0, input.lastReminderAt ?? 0);
  return input.now - base >= BACKUP_PASSWORD_REMINDER_DAYS * 24 * HOUR_MS;
}

/** Deslocamento em minutos (positivo a leste) → "UTC-03:00". */
export function timezoneLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
