/**
 * proxy-network.ts — onde o Caddy do painel está na rede dos projetos (paas-net).
 *
 * O app atrás do Caddy só vê o IP do Caddy como par da conexão; para ler o IP
 * real do visitante (X-Forwarded-For) ele precisa confiar nesse proxy. O IP do
 * Caddy NÃO é fixo: a rede é criada sem sub-rede definida (o Docker escolhe) e o
 * container recebe o próximo endereço livre, que pode mudar quando ele é
 * recriado (atualização da imagem, `docker rm`). A sub-rede, ao contrário, vale
 * enquanto a rede existir. O painel entrega as duas. A recomendação principal é
 * confiar só no IP (renovado a cada deploy do projeto); a sub-rede é a alternativa
 * simples, mas cobre também os projetos vizinhos da paas-net, que se alcançam entre si.
 *
 * Lê pelo mesmo caminho que o resto do servidor usa com o Docker (a CLI contra
 * o socket do host), com cache curto. Nunca lança: sem Docker, devolve nulos.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PAAS_CADDY_CONTAINER, PAAS_NETWORK } from "@paas/core";

const execFileAsync = promisify(execFile);

/** Nomes das variáveis que o painel entrega aos projetos. */
export const PROXY_ENV_IP = "PAAS_PROXY_IP";
export const PROXY_ENV_SUBNET = "PAAS_PROXY_SUBNET";
export const PROXY_ENV_NAMES = [PROXY_ENV_IP, PROXY_ENV_SUBNET] as const;

/** Cabeçalhos com dados do visitante que o Caddy envia; a descrição vem do locale da web. */
export const PROXY_HEADERS = ["X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host"] as const;

export interface ProxyNetworkFacts {
  /** IP do container do Caddy na paas-net (null = não está na rede ou Docker indisponível). */
  ip: string | null;
  /** Sub-rede IPv4 da paas-net, em CIDR (null = rede inexistente ou ilegível). */
  subnet: string | null;
}

type Inspect = () => Promise<string>;

export async function inspectNetwork(): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["network", "inspect", PAAS_NETWORK, "-f", "{{json .}}"], { timeout: 5_000 });
  return stdout;
}

/** Extrai IP do Caddy e sub-rede IPv4 da saída de `docker network inspect -f '{{json .}}'`. */
export function parseProxyNetwork(json: string): ProxyNetworkFacts {
  try {
    const net = JSON.parse(json) as {
      IPAM?: { Config?: { Subnet?: string }[] | null } | null;
      Containers?: Record<string, { Name?: string; IPv4Address?: string }> | null;
    } | null;
    const subnet =
      (net?.IPAM?.Config ?? []).map((c) => c?.Subnet ?? "").find((s) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)) ?? null;
    const caddy = Object.values(net?.Containers ?? {}).find((c) => c?.Name === PAAS_CADDY_CONTAINER);
    const ip = (caddy?.IPv4Address ?? "").split("/")[0] ?? "";
    return { ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null, subnet };
  } catch {
    return { ip: null, subnet: null };
  }
}

/**
 * Leitor padrão da rede. Em produção é o Docker de verdade; o setup dos testes do servidor troca por um leitor que
 * devolve nada, para que nenhum teste dependa da paas-net da máquina em que roda (ex.: o runner do CI tem Docker).
 */
export const proxyNetworkDefaults: { inspect: Inspect } = { inspect: inspectNetwork };

export class ProxyNetwork {
  private cached: { at: number; facts: ProxyNetworkFacts } | null = null;

  constructor(
    private readonly inspect: Inspect = () => proxyNetworkDefaults.inspect(),
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Valores com cache curto (10 s); `fresh` ignora o cache. O deploy usa o cache: no pior caso o valor tem até 10 s. */
  async facts(fresh = false): Promise<ProxyNetworkFacts> {
    if (!fresh && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.facts;
    let facts: ProxyNetworkFacts;
    try {
      facts = parseProxyNetwork(await this.inspect());
    } catch {
      facts = { ip: null, subnet: null };
    }
    this.cached = { at: this.now(), facts };
    return facts;
  }

  /** As variáveis PAAS_PROXY_*: só as que se conhecem (sem valor vazio). */
  async env(fresh = false): Promise<Record<string, string>> {
    const { ip, subnet } = await this.facts(fresh);
    return { ...(ip ? { [PROXY_ENV_IP]: ip } : {}), ...(subnet ? { [PROXY_ENV_SUBNET]: subnet } : {}) };
  }
}
