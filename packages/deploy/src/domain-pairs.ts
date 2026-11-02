/**
 * domain-pairs.ts — quais pares (com/sem www) o proxy deve redirecionar.
 *
 * Um par só entra no Caddyfile quando (1) a pessoa não o desligou, (2) nenhum
 * projeto nem o painel usa esse nome e (3) o DNS dele já aponta para a VPS.
 * O terceiro ponto é o que evita falha de ACME e gasto do limite do Let's
 * Encrypt: o Caddy só pede certificado de nome que tem bloco.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pairOf, type DomainDnsState, type Project } from "@paas/core";
import type { CaddyRedirect } from "./caddy.js";
import { projectDomain } from "./caddy.js";

export interface PairCandidate extends CaddyRedirect {
  /** Projeto dono do canônico. */
  projectId: string;
}

/** Todo nome que um projeto usa de forma explícita (principal e adicionais). */
export function explicitDomains(projects: Project[]): Set<string> {
  return new Set(projects.flatMap((p) => [projectDomain(p), ...(p.aliases ?? [])]));
}

/**
 * Pares possíveis: do canônico ligado, o outro nome, desde que ninguém o use
 * (projeto, adicional ou `reserved`, como os endereços do painel).
 */
export function pairCandidates(projects: Project[], reserved: Iterable<string> = []): PairCandidate[] {
  const used = explicitDomains(projects);
  for (const name of reserved) used.add(name);
  const out = new Map<string, PairCandidate>();
  for (const p of projects) {
    const off = new Set(p.pairOff ?? []);
    for (const canonical of [projectDomain(p), ...(p.aliases ?? [])]) {
      if (off.has(canonical)) continue;
      const pair = pairOf(canonical);
      if (!pair || used.has(pair.pair) || out.has(pair.pair)) continue;
      out.set(pair.pair, { host: pair.pair, to: canonical, projectId: p.id });
    }
  }
  return [...out.values()];
}

/**
 * Os pares a redirecionar agora. `state` consulta o DNS de um nome; um nome
 * que "não respondeu" mantém o que já estava (`previous`): um tropeço do
 * resolvedor não derruba um redirecionamento que funcionava, nem inventa um
 * novo.
 */
export async function activePairs(
  candidates: PairCandidate[],
  state: ((host: string) => Promise<DomainDnsState>) | undefined,
  previous: ReadonlySet<string> = new Set(),
): Promise<CaddyRedirect[]> {
  if (!state || candidates.length === 0) return [];
  const results = await Promise.all(
    candidates.map(async (c) => ({ c, s: await state(c.host).catch((): DomainDnsState => "unavailable") })),
  );
  return results
    .filter(({ c, s }) => s === "pointed" || (s === "unavailable" && previous.has(c.host)))
    .map(({ c }) => ({ host: c.host, to: c.to }));
}

/**
 * Lê os últimos pares aplicados com sucesso (gravados por `saveLastPairs`). Arquivo
 * ausente ou ilegível = nenhum par conhecido (nunca lança). Serve para um DNS mudo,
 * logo depois de o painel reiniciar, não derrubar um redirecionamento que já funcionava.
 */
export async function loadLastPairs(file: string): Promise<Set<string>> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { pairs?: unknown };
    return new Set(Array.isArray(data.pairs) ? data.pairs.filter((h): h is string => typeof h === "string") : []);
  } catch {
    return new Set();
  }
}

/** Grava (de forma atômica) os pares aplicados. Melhor esforço: falhar aqui só devolve `false`. */
export async function saveLastPairs(file: string, pairs: ReadonlySet<string>): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ pairs: [...pairs].sort(), savedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}
