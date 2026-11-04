/**
 * terminal-access.ts — o terminal depois do setup só abre habilitado (senha + 2FA), por sessão e por
 * uma janela curta. Este hook consulta o estado no servidor (GET /api/terminal/access), mantém a
 * contagem regressiva pelo relógio DESTE navegador (o servidor manda quanto FALTA, nunca um instante
 * absoluto: relógio dessincronizado não atrapalha) e oferece habilitar e desligar.
 *
 * O servidor é quem decide: a tela só espelha. Falha na consulta vira `error` (nunca "habilitado").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalAccessStatus, TerminalEnableResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";

/** De quanto em quanto tempo reconfere o estado enquanto habilitado (a ociosidade só o servidor sabe). */
const REFRESH_MS = 20_000;

export function isTerminalAccess(value: unknown): value is TerminalAccessStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.required === "boolean" && typeof v.enabled === "boolean" && typeof v.remainingMs === "number";
}

export interface TerminalAccessState {
  /** null enquanto carrega ou se a consulta falhou. */
  status: TerminalAccessStatus | null;
  error: boolean;
  /** Milissegundos que faltam para a janela acabar, pelo relógio local (0 se desligado). */
  remainingMs: number;
  reload: () => void;
  /** Habilita com a reautenticação. Lança o erro da API (a tela mostra a mensagem). */
  enable: (payload: { currentPassword: string; code: string; emailCode?: string }) => Promise<TerminalEnableResponse>;
  disable: () => Promise<void>;
}

export function useTerminalAccess(): TerminalAccessState {
  const [status, setStatus] = useState<TerminalAccessStatus | null>(null);
  const [error, setError] = useState(false);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const apply = useCallback((next: TerminalAccessStatus) => {
    setStatus(next);
    setError(false);
    setDeadline(next.required && next.enabled ? Date.now() + next.remainingMs : null);
    setNow(Date.now());
  }, []);

  const reload = useCallback(() => {
    apiFetch<unknown>("/api/terminal/access")
      .then((res) => {
        if (!alive.current) return;
        if (isTerminalAccess(res)) apply(res);
        else setError(true);
      })
      .catch(() => {
        if (alive.current) setError(true);
      });
  }, [apply]);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const live = status?.required === true && status.enabled;

  // contagem regressiva (1 s) e reconferência periódica enquanto habilitado
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const refresh = setInterval(reload, REFRESH_MS);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [live, reload]);

  // o prazo local chegou ao fim: pergunta ao servidor (que desligou) em vez de supor
  const expired = live && deadline !== null && now >= deadline;
  useEffect(() => {
    if (expired) reload();
  }, [expired, reload]);

  const enable = useCallback(
    async (payload: { currentPassword: string; code: string; emailCode?: string }) => {
      const res = await apiFetch<TerminalEnableResponse>("/api/terminal/access/enable", { method: "POST", body: JSON.stringify(payload) });
      if (alive.current) apply(res);
      return res;
    },
    [apply],
  );

  const disable = useCallback(async () => {
    const res = await apiFetch<TerminalAccessStatus>("/api/terminal/access/disable", { method: "POST", body: "{}" });
    if (alive.current) apply(res);
  }, [apply]);

  return {
    status,
    error,
    remainingMs: live && deadline !== null ? Math.max(0, deadline - now) : 0,
    reload,
    enable,
    disable,
  };
}

/** mm:ss */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
