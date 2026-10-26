/**
 * Carrega a saúde do envio de um domínio (GET) e faz "Verificar agora" (POST),
 * com espera entre verificações: o servidor só aceita uma por domínio a cada
 * 15 s (429), então o botão fica desabilitado, com a contagem, em vez de
 * deixar a pessoa bater no limite. Usado pelo card completo e pelo resumo da
 * página do projeto: a lógica é uma só.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MAIL_HEALTH_MIN_INTERVAL_MS, type DeliveryHealthStateResponse } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { apiErrorText } from "@/i18n";

const COOLDOWN_S = Math.ceil(MAIL_HEALTH_MIN_INTERVAL_MS / 1000);

/** Espera pedida pelo servidor no 429 (retryAfter, em segundos), entre 1 e 60; sem ela, os 15 s padrão. */
export function retryAfterSeconds(err: ApiRequestError): number {
  const value = Number(err.data?.retryAfter);
  return Number.isFinite(value) && value >= 1 ? Math.min(60, Math.ceil(value)) : COOLDOWN_S;
}

export function useDeliveryHealth(domain: string) {
  const [state, setState] = useState<DeliveryHealthStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const mounted = useRef(true);
  const base = `/api/mail/domains/${encodeURIComponent(domain)}/health`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setState(null);
    setError(null);
    let cancelled = false;
    apiFetch<DeliveryHealthStateResponse>(base)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorText(err, "mailHealth.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const next = await apiFetch<DeliveryHealthStateResponse>(`${base}/check`, { method: "POST" });
      if (mounted.current) {
        setState(next);
        setCooldown(COOLDOWN_S);
      }
    } catch (err) {
      if (mounted.current) {
        setError(apiErrorText(err, "mailHealth.checkError"));
        if (err instanceof ApiRequestError && (err.code === "health_check_too_soon" || err.code === "health_check_busy")) {
          setCooldown(retryAfterSeconds(err));
        }
      }
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [base]);

  /** "Marcar como ciente" (PTR, porta 25): o servidor devolve o estado já com a marcação aplicada. */
  const acknowledge = useCallback(
    async (id: string, reason: string): Promise<boolean> => {
      setError(null);
      try {
        const body = reason.trim() === "" ? undefined : JSON.stringify({ reason: reason.trim() });
        const next = await apiFetch<DeliveryHealthStateResponse>(`${base}/ack/${encodeURIComponent(id)}`, { method: "PUT", ...(body ? { body } : {}) });
        if (mounted.current) setState(next);
        return true;
      } catch (err) {
        if (mounted.current) setError(apiErrorText(err, "mailHealth.ack.error"));
        return false;
      }
    },
    [base],
  );

  const unacknowledge = useCallback(
    async (id: string): Promise<boolean> => {
      setError(null);
      try {
        const next = await apiFetch<DeliveryHealthStateResponse>(`${base}/ack/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (mounted.current) setState(next);
        return true;
      } catch (err) {
        if (mounted.current) setError(apiErrorText(err, "mailHealth.ack.error"));
        return false;
      }
    },
    [base],
  );

  /** Substitui o estado por um já calculado pelo servidor (o "Verificar" do MTA-STS devolve a saúde com o item reavaliado). */
  const applyState = useCallback((next: DeliveryHealthStateResponse) => {
    if (mounted.current) setState(next);
  }, []);

  return { state, error, checking, cooldown, check, acknowledge, unacknowledge, applyState };
}
