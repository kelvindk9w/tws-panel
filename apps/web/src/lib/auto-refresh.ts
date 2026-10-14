/**
 * auto-refresh.ts — consulta automática enquanto algo está "a caminho".
 *
 * Validação real (07/10/2026): o certificado do domínio do painel ficou
 * válido, mas a tela continuou em "Emitindo" até a pessoa recarregar a
 * página. Agora as telas que mostram um certificado ainda não válido
 * consultam sozinhas: rápido no começo, mais espaçado com o tempo, e nada
 * com a aba oculta (como o Dashboard). Ao voltar para a aba, consulta na
 * hora e recomeça o ritmo rápido.
 */
import { useEffect, useRef } from "react";
import type { CertificateItem } from "@paas/core";

/** Uma fase da agenda: até `untilMs` desde o começo, consulta a cada `everyMs`. */
export interface RefreshPhase {
  untilMs: number;
  everyMs: number;
}

/**
 * Certificado: a emissão costuma levar de segundos a 2 minutos. A cada 5 s
 * nos 2 primeiros minutos, a cada 15 s até 10 minutos, depois a cada minuto
 * (o proxy continua tentando sozinho; a tela acompanha).
 */
export const CERTIFICATE_WATCH_SCHEDULE: readonly RefreshPhase[] = [
  { untilMs: 2 * 60_000, everyMs: 5_000 },
  { untilMs: 10 * 60_000, everyMs: 15_000 },
  { untilMs: Infinity, everyMs: 60_000 },
];

/** Intervalo da fase em que `elapsedMs` cai (a última vale para sempre); null = agenda vazia. */
export function intervalAt(schedule: readonly RefreshPhase[], elapsedMs: number): number | null {
  if (schedule.length === 0) return null;
  return (schedule.find((p) => elapsedMs < p.untilMs) ?? schedule[schedule.length - 1]!).everyMs;
}

/**
 * Certificado que ainda pode mudar sozinho: automático, sem certificado
 * válido (emitindo, falhou, não conferido, vencido). Manual (ou coberto por
 * um manual) não muda sem a pessoa agir.
 */
export function certificatePending(item: CertificateItem): boolean {
  return item.mode === "automatic" && item.coveredBy === null && item.state !== "valid" && item.state !== "expiring";
}

/**
 * Enquanto `active`, chama `refresh` no ritmo da agenda. A primeira
 * consulta vem no primeiro intervalo (a tela já carregou); a próxima só é
 * marcada depois que a anterior termina (sem consultas sobrepostas); falha
 * numa consulta não interrompe as seguintes.
 */
export function useAutoRefresh(
  active: boolean,
  refresh: () => unknown,
  schedule: readonly RefreshPhase[] = CERTIFICATE_WATCH_SCHEDULE,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = Date.now();
    let stopped = false;
    // Cada ciclo tem um número: um ciclo antigo (aba ocultada no meio da consulta) não marca o próximo.
    let generation = 0;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const scheduleNext = (gen: number) => {
      if (stopped || gen !== generation || document.visibilityState === "hidden") return;
      const every = intervalAt(scheduleRef.current, Date.now() - startedAt);
      if (every === null) return;
      timer = setTimeout(() => void run(gen), every);
    };
    const run = async (gen: number) => {
      timer = null;
      try {
        await refreshRef.current();
      } catch {
        // a próxima consulta tenta de novo
      }
      scheduleNext(gen);
    };
    const onVisibility = () => {
      clear();
      generation += 1;
      if (document.visibilityState === "hidden") return;
      startedAt = Date.now();
      void run(generation);
    };

    scheduleNext(generation);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
