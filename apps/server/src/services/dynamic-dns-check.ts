/**
 * dynamic-dns-check.ts — o nome aponta para ESTA VPS? Conferência que o `ask`
 * faz antes de gastar uma emissão nova: sem ela, qualquer pessoa que mande um
 * handshake com o nome de um cliente ainda sem DNS (nomes fáceis de adivinhar)
 * esgota a cota da hora e deixa os clientes legítimos sem certificado.
 *
 * Resolve A e AAAA (o resolvedor segue CNAME) e compara com os IPs públicos da
 * VPS que o painel conhece. Regras:
 *  - não saber os IPs da VPS = não autorizar (falha segura; o guia diz para
 *    configurar PAAS_PUBLIC_IP);
 *  - consulta com tempo limite curto; erro, tempo esgotado ou nome sem
 *    registro = "não aponta";
 *  - cache curto, positivo e negativo, e uma consulta por vez por nome;
 *  - nunca escreve o nome em log.
 */
import { isIP } from "node:net";

export interface DnsCheckDeps {
  /** IPs públicos da VPS (IPv4 e, se houver, IPv6). */
  ownIps(): readonly string[];
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  now?: () => number;
  /** Tempo máximo da consulta (padrão 2 s). */
  timeoutMs?: number;
  /** Quanto vale um "aponta" (padrão 5 min). */
  positiveTtlMs?: number;
  /** Quanto vale um "não aponta" (padrão 60 s: o cliente acabou de criar o registro). */
  negativeTtlMs?: number;
}

const MAX_CACHE = 5_000;

/** IPv6 em forma comparável (minúsculas, sem colchetes); IPv4 como veio. */
function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(v) === 6 ? new URL(`http://[${v}]/`).hostname.slice(1, -1) : v;
}

export function buildPointsHere(deps: DnsCheckDeps): (host: string) => Promise<boolean> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const positiveTtl = deps.positiveTtlMs ?? 300_000;
  const negativeTtl = deps.negativeTtlMs ?? 60_000;
  const cache = new Map<string, { ok: boolean; until: number }>();
  const inflight = new Map<string, Promise<boolean>>();

  async function lookup(host: string, own: Set<string>): Promise<boolean> {
    const withTimeout = <T,>(p: Promise<T>): Promise<T | null> => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      });
      return Promise.race([p.catch(() => null), limit]).finally(() => clearTimeout(timer));
    };
    const [v4, v6] = await Promise.all([withTimeout(deps.resolve4(host)), withTimeout(deps.resolve6(host))]);
    return [...(v4 ?? []), ...(v6 ?? [])].some((ip) => own.has(normalizeIp(ip)));
  }

  return async (host: string): Promise<boolean> => {
    const own = new Set(deps.ownIps().map(normalizeIp).filter((ip) => isIP(ip) !== 0));
    if (own.size === 0) return false; // sem IP da VPS conhecido: não autoriza
    const t = now();
    const hit = cache.get(host);
    if (hit && hit.until > t) return hit.ok;
    const running = inflight.get(host);
    if (running) return running;
    const job = lookup(host, own)
      .then((ok) => {
        if (cache.size >= MAX_CACHE) {
          for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
          if (cache.size >= MAX_CACHE) cache.clear();
        }
        cache.set(host, { ok, until: t + (ok ? positiveTtl : negativeTtl) });
        return ok;
      })
      .finally(() => inflight.delete(host));
    inflight.set(host, job);
    return job;
  };
}
