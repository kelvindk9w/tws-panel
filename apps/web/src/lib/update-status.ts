import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProjectUpdateStatus,
  ProjectUpdateStatusListResponse,
  ProjectUpdateStatusResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";

/** Espera entre duas leituras enquanto o servidor ainda está consultando o repositório. */
export const UPDATE_STATUS_RETRY_MS = 3_000;
/** Quantas leituras seguidas em "verificando" antes de desistir (o servidor tem prazo próprio). */
export const UPDATE_STATUS_MAX_RETRIES = 8;
/** Releitura periódica com a aba aberta (o servidor guarda o resultado por alguns minutos). */
export const UPDATE_STATUS_REFRESH_MS = 5 * 60_000;

/** Resposta de um projeto, ou null se a resposta não tem o formato esperado. */
function statusOf(res: ProjectUpdateStatusResponse | undefined): ProjectUpdateStatus | null {
  return res && typeof res === "object" && res.status && typeof res.status.state === "string" ? res.status : null;
}

/**
 * Estado do alerta de "nova atualização" de UM projeto. Nunca derruba a tela: se o painel não
 * responde, `failed` fica true (a interface diz "não deu para verificar", não "sem atualização").
 *
 * @param refreshKey muda quando o projeto muda (fim de um deploy, nova branch): a leitura é refeita.
 */
export function useProjectUpdateStatus(projectId: string | undefined, refreshKey: string, enabled = true) {
  const [status, setStatus] = useState<ProjectUpdateStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!projectId || !enabled) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    async function read() {
      try {
        const next = statusOf(await apiFetch<ProjectUpdateStatusResponse>(`/api/projects/${projectId}/update-status`));
        if (generation.current !== mine) return;
        setStatus(next);
        setFailed(next === null);
        if (next?.state === "checking" && retries < UPDATE_STATUS_MAX_RETRIES) {
          retries += 1;
          timer = setTimeout(() => void read(), UPDATE_STATUS_RETRY_MS);
        } else {
          retries = 0;
          timer = setTimeout(() => void read(), UPDATE_STATUS_REFRESH_MS);
        }
      } catch {
        if (generation.current !== mine) return;
        setFailed(true);
        timer = setTimeout(() => void read(), UPDATE_STATUS_REFRESH_MS);
      }
    }
    void read();
    return () => {
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [projectId, refreshKey, enabled]);

  /** "Verificar agora": o servidor aplica o próprio limite; o resultado volta na resposta. */
  const checkNow = useCallback(async () => {
    if (!projectId) return;
    setChecking(true);
    try {
      const next = statusOf(
        await apiFetch<ProjectUpdateStatusResponse>(`/api/projects/${projectId}/update-status/check`, { method: "POST" }),
      );
      setStatus(next);
      setFailed(next === null);
    } catch {
      // o pedido falhou: não vale mostrar o resultado antigo como se fosse de agora
      setStatus(null);
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }, [projectId]);

  return { status, failed, checking, checkNow };
}

/** Estado de TODOS os projetos (Dashboard). Falha = lista vazia + `failed`; nunca derruba a tela. */
export function useProjectUpdateStatuses() {
  const [statuses, setStatuses] = useState<ProjectUpdateStatus[]>([]);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    async function read() {
      try {
        const res = await apiFetch<ProjectUpdateStatusListResponse>("/api/projects/update-status");
        if (cancelled) return;
        const list = Array.isArray(res?.statuses) ? res.statuses : null;
        setStatuses(list ?? []);
        setFailed(list === null);
        setLoaded(true);
        if (list?.some((s) => s.state === "checking") && retries < UPDATE_STATUS_MAX_RETRIES) {
          retries += 1;
          timer = setTimeout(() => void read(), UPDATE_STATUS_RETRY_MS);
        } else {
          retries = 0;
          timer = setTimeout(() => void read(), UPDATE_STATUS_REFRESH_MS);
        }
      } catch {
        if (cancelled) return;
        setFailed(true);
        setLoaded(true);
        timer = setTimeout(() => void read(), UPDATE_STATUS_REFRESH_MS);
      }
    }
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { statuses, failed, loaded };
}
