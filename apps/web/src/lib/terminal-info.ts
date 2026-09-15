/**
 * terminal-info.ts — o que a interface precisa saber sobre o terminal ao vivo
 * depois que o operador passou a escolher, na instalação, com qual usuário ele
 * abre e como os comandos de root rodam (PAAS_TERMINAL_USER / PAAS_ROOT_MODE).
 *
 * Regras:
 *  - /api/terminal/info só é consultado com o terminal LIBERADO (mesma regra
 *    do WebSocket: sem token/sessão válida, nenhuma chamada);
 *  - resposta com formato inesperado vale como "indisponível" — a interface
 *    nunca inventa um modo que o servidor não declarou;
 *  - `hostDockerAccess` (usuário do terminal com acesso ao Docker do host =
 *    root sem senha): nos modos senha/segundo-plano, campo ausente (servidor
 *    antigo) ou valor desconhecido vira "nao-verificado" — nunca "nao" sem
 *    verificação; nas sessões root e no container de dev é sempre null;
 *  - transporte da senha: fora de https e fora do túnel SSH (localhost), o
 *    que se digita no terminal atravessa a internet SEM criptografia.
 */
import { useEffect, useState } from "react";
import { isHostDockerAccess, type TerminalElevation, type TerminalInfoResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";

const ELEVATIONS: readonly TerminalElevation[] = ["root-legado", "root", "senha", "segundo-plano", "container-dev"];

function isTerminalInfo(value: unknown): value is TerminalInfoResponse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.user === "string" &&
    typeof v.elevation === "string" &&
    (ELEVATIONS as readonly string[]).includes(v.elevation) &&
    (v.configuredUser === null || typeof v.configuredUser === "string")
  );
}

/** Normaliza `hostDockerAccess` conforme o modo (ver regras no topo). */
function withHostDockerAccess(info: TerminalInfoResponse): TerminalInfoResponse {
  const userSession = info.elevation === "senha" || info.elevation === "segundo-plano";
  const raw: unknown = (info as { hostDockerAccess?: unknown }).hostDockerAccess;
  const hostDockerAccess = userSession ? (isHostDockerAccess(raw) ? raw : "nao-verificado") : null;
  return { ...info, hostDockerAccess };
}

export interface TerminalInfoState {
  /** null enquanto carrega, com o terminal bloqueado ou se a consulta falhou. */
  info: TerminalInfoResponse | null;
  /** true quando a consulta falhou (ou veio em formato desconhecido). */
  unavailable: boolean;
}

export function useTerminalInfo(enabled: boolean): TerminalInfoState {
  const [state, setState] = useState<TerminalInfoState>({ info: null, unavailable: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<unknown>("/api/terminal/info")
      .then((res) => {
        if (cancelled) return;
        setState(isTerminalInfo(res) ? { info: withHostDockerAccess(res), unavailable: false } : { info: null, unavailable: true });
      })
      .catch(() => {
        if (!cancelled) setState({ info: null, unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Transporte da senha
// ---------------------------------------------------------------------------

export interface PageLocationLike {
  protocol: string;
  hostname: string;
}

/** Endereços do túnel SSH (`ssh -L 9000:localhost:9000 …`): o trecho pela
 * internet vai dentro do SSH, criptografado, mesmo com a página em http. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isInsecureTransport(loc: PageLocationLike): boolean {
  if (loc.protocol === "https:") return false;
  return !LOOPBACK_HOSTS.has(loc.hostname.toLowerCase());
}

// ---------------------------------------------------------------------------
// Falhas do sudo (modo senha)
// ---------------------------------------------------------------------------

/**
 * Mensagem do servidor quando a varredura falhou porque o sudo não executou
 * nada (HTTP 424 `sudo_elevation_failed`), ou null para qualquer outro erro.
 * O Fastify serializa o erro como { statusCode, code, error, message } — o
 * apiFetch guarda `error` ("Failed Dependency") em `code` e o corpo inteiro
 * em `data`, então o código real é procurado nos dois lugares.
 */
export function sudoElevationFailure(err: unknown): string | null {
  if (!(err instanceof ApiRequestError) || err.status !== 424) return null;
  const bodyCode = (err as { data?: Record<string, unknown> }).data?.code;
  if (err.code === "sudo_elevation_failed" || bodyCode === "sudo_elevation_failed") return err.message;
  return null;
}

/**
 * O job de fase não tem código de erro, só a mensagem (SecurityJob.error).
 * As mensagens de falha do sudo (terminal-service.ts) e a de terminal
 * indisponível no modo senha (terminal-runner.ts) citam o sudo ou o modo;
 * a falha comum de script ("script X saiu com código N") não.
 */
export function isSudoJobError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /\bsudo\b|PAAS_ROOT_MODE=senha/i.test(error);
}

/** Primeira letra maiúscula (as mensagens do servidor começam minúsculas). */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
