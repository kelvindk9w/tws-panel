/**
 * trusted-proxies.ts — de quem o painel aceita o X-Forwarded-For (achado A4).
 *
 * Só do Caddy central (o único proxy na frente do painel) e do loopback. Com
 * `trustProxy: true` qualquer par que alcançasse a porta do painel informava o
 * IP que quisesse: burlava o limite de tentativas de login e a auditoria.
 *
 * O IP do Caddy muda quando o container é recriado, e o `trustProxy` do
 * Fastify é síncrono: a lista fica em memória, relida em segundo plano (no
 * boot, a cada minuto e quando chega um par privado desconhecido). Enquanto
 * não se sabe, o IP registrado é o do par — nunca o de um cabeçalho.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PAAS_CADDY_CONTAINER } from "@paas/core";

const execFileAsync = promisify(execFile);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** IPv4 privado (RFC 1918) ou IPv6 ULA: só estes podem ser o Caddy. */
function isPrivate(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, "");
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a);
}

/** IPs do Caddy em todas as redes (saída de `docker inspect -f '{{json .NetworkSettings.Networks}}'`). */
export function caddyAddresses(json: string): string[] {
  try {
    const networks = JSON.parse(json) as Record<string, { IPAddress?: string }> | null;
    return Object.values(networks ?? {})
      .map((n) => n?.IPAddress ?? "")
      .filter((ip) => ip !== "");
  } catch {
    return [];
  }
}

export async function lookupCaddyAddresses(container: string = PAAS_CADDY_CONTAINER): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", container], {
    timeout: 5_000,
  });
  return caddyAddresses(stdout.trim());
}

export class TrustedProxies {
  private ips = new Set<string>();
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private readonly gap: number;

  constructor(
    private readonly lookup: () => Promise<string[]> = lookupCaddyAddresses,
    opts: { minRefreshGapMs?: number } = {},
  ) {
    this.gap = opts.minRefreshGapMs ?? 5_000;
  }

  /** Passa direto para `trustProxy` do Fastify. */
  isTrusted = (address: string, _hop: number): boolean => {
    if (LOOPBACK.has(address)) return true;
    if (this.ips.has(address)) return true;
    // par privado que não conhecemos: pode ser o Caddy recriado
    if (isPrivate(address) && Date.now() - this.lastRefresh >= this.gap) void this.refresh();
    return false;
  };

  async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        this.ips = new Set(await this.lookup());
      } catch {
        // Docker indisponível: segue com o que já se sabia
      } finally {
        this.lastRefresh = Date.now();
        this.refreshing = null;
      }
    })();
    await this.refreshing;
  }
}
