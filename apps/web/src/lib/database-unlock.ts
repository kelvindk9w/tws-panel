/**
 * database-unlock.ts — estado da liberação da edição do banco (aba Banco): consulta ao servidor, contagem regressiva
 * local e volta ao bloqueio quando o prazo acaba.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseUnlockStatus } from "@paas/core";
import { apiFetch } from "@/lib/api";

/** mm:ss (ou h:mm:ss a partir de uma hora). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export interface DatabaseUnlock {
  /** Liberada agora (já considera o prazo local). */
  unlocked: boolean;
  /** Milissegundos que faltam; null = até a sessão acabar (ou bloqueado). */
  remainingMs: number | null;
  /** A liberação acabou por prazo enquanto a tela estava aberta. */
  ended: boolean;
  refresh: () => Promise<void>;
  lock: () => Promise<void>;
}

/** `tickMs`: intervalo da contagem (testes podem encurtar). */
export function useDatabaseUnlock(projectId: string, tickMs = 1000): DatabaseUnlock {
  const [status, setStatus] = useState<DatabaseUnlockStatus | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ended, setEnded] = useState(false);
  const refreshingExpiry = useRef(false);

  const apply = useCallback((next: DatabaseUnlockStatus | null) => {
    setStatus(next);
    setNow(Date.now());
    setDeadline(next?.unlocked && next.remainingMs !== null ? Date.now() + next.remainingMs : null);
    if (next?.unlocked) setEnded(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await apiFetch<DatabaseUnlockStatus>(`/api/projects/${projectId}/database/unlock`));
    } catch {
      apply(null);
    }
  }, [projectId, apply]);

  const lock = useCallback(async () => {
    apply(await apiFetch<DatabaseUnlockStatus>(`/api/projects/${projectId}/database/lock`, { method: "POST" }));
  }, [projectId, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = status?.unlocked === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [running, tickMs]);

  const expired = running && deadline !== null && now >= deadline;
  useEffect(() => {
    if (!expired || refreshingExpiry.current) return;
    refreshingExpiry.current = true;
    setEnded(true);
    void refresh().finally(() => {
      refreshingExpiry.current = false;
    });
  }, [expired, refresh]);

  return {
    unlocked: running && !expired,
    remainingMs: running && deadline !== null ? Math.max(0, deadline - now) : null,
    ended: ended && !running,
    refresh,
    lock,
  };
}
