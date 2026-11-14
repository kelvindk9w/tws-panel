/**
 * mail-networks.ts — sub-redes e gateways das redes Docker por onde os apps, o webmail e o painel falam com o servidor
 * de e-mail (a rede de e-mail de cada projeto — `paas-mail-<slug>` —, a paas-mailweb, a paas-mail e, em instalação
 * antiga, paas-net). Serve para dizer se uma recusa veio "de dentro" (container do painel ou de um app) ou de fora.
 *
 * Por que não basta "endereço privado": com o proxy em espaço de usuário do Docker, clientes da INTERNET (em especial
 * IPv6) chegam ao container com o endereço do gateway da rede (x.y.0.1). Esse endereço é privado mas não é um app. Só
 * conta como interno um endereço DENTRO da sub-rede e DIFERENTE do gateway; o gateway vira "unknown".
 *
 * Lê `GET /networks/<nome>` (o mesmo que `docker network inspect`) e a lista das redes de e-mail de projeto (pela
 * label do painel) pelo socket do Docker, só leitura, com cache:
 * 10 minutos quando deu certo, 1 minuto quando falhou (para não martelar o Docker, e para voltar logo).
 */
import { PAAS_LABEL_MAIL_PROJECT, PAAS_MAIL_NETWORK, PAAS_MAIL_WEBMAIL_NETWORK, PAAS_NETWORK, isProjectMailNetworkName } from "@paas/core";
import type { MailNetwork } from "@paas/mailer";
import { dockerGet } from "./docker-logs.js";

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
const NETWORK_MAX_BYTES = 1024 * 1024;

/** `IPAM.Config` de um documento de rede → sub-redes e gateways. */
export function parseNetworkDoc(doc: unknown): MailNetwork[] {
  const config = (doc as { IPAM?: { Config?: unknown } } | null)?.IPAM?.Config;
  if (!Array.isArray(config)) return [];
  const out: MailNetwork[] = [];
  for (const entry of config) {
    const e = entry as { Subnet?: unknown; Gateway?: unknown } | null;
    if (typeof e?.Subnet !== "string" || !e.Subnet.includes("/")) continue;
    out.push({ subnet: e.Subnet, gateway: typeof e.Gateway === "string" && e.Gateway ? e.Gateway : null });
  }
  return out;
}

export interface MailNetworksDeps {
  /** Documento da rede (JSON do inspect) ou null se não deu para ler. */
  fetchNetwork(name: string): Promise<unknown | null>;
  /** Documentos das redes de e-mail de projeto (`paas-mail-<slug>`); ausente = nenhuma. */
  listProjectNetworks?: () => Promise<unknown[]>;
  now?: () => number;
  names?: readonly string[];
}

export class MailNetworksProvider {
  private cache: { at: number; ttl: number; value: MailNetwork[] | null } | null = null;
  private inflight: Promise<MailNetwork[] | null> | null = null;

  constructor(private readonly deps: MailNetworksDeps) {}

  /** null = não deu para consultar nenhuma rede (quem chama usa o plano B). */
  async get(): Promise<MailNetwork[] | null> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cache && now - this.cache.at < this.cache.ttl) return this.cache.value;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    const value = await this.inflight;
    this.cache = { at: now, ttl: value ? OK_TTL_MS : FAIL_TTL_MS, value };
    return value;
  }

  private async load(): Promise<MailNetwork[] | null> {
    const names = this.deps.names ?? [PAAS_MAIL_NETWORK, PAAS_MAIL_WEBMAIL_NETWORK, PAAS_NETWORK];
    const [docs, projects] = await Promise.all([
      Promise.all(names.map((n) => this.deps.fetchNetwork(n).catch(() => null))),
      (this.deps.listProjectNetworks?.() ?? Promise.resolve([])).catch((): unknown[] => []),
    ]);
    const networks = [...docs, ...projects].flatMap((d) => (d ? parseNetworkDoc(d) : []));
    return networks.length > 0 ? networks : null;
  }
}

/** Leitor real: `GET /networks/<nome>` no socket do Docker. */
export function dockerNetworkFetcher(socketPath: string): MailNetworksDeps["fetchNetwork"] {
  return async (name) => {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) return null;
    const r = await dockerGet(socketPath, `/networks/${name}`, NETWORK_MAX_BYTES, 5000);
    if (!r.ok || r.status !== 200) return null;
    try {
      return JSON.parse(r.body.toString("utf8")) as unknown;
    } catch {
      return null;
    }
  };
}

/**
 * Leitor real das redes de e-mail de projeto: `GET /networks?filters={"label":["paas.mail.project"]}` no socket do
 * Docker. Só valem as que também têm o nome no formato `paas-mail-<slug>`.
 */
export function dockerProjectMailNetworksLister(socketPath: string): NonNullable<MailNetworksDeps["listProjectNetworks"]> {
  return async () => {
    const filters = encodeURIComponent(JSON.stringify({ label: [PAAS_LABEL_MAIL_PROJECT] }));
    const r = await dockerGet(socketPath, `/networks?filters=${filters}`, NETWORK_MAX_BYTES, 5000);
    if (!r.ok || r.status !== 200) return [];
    try {
      const list = JSON.parse(r.body.toString("utf8")) as unknown;
      if (!Array.isArray(list)) return [];
      return list.filter((d) => {
        const name = (d as { Name?: unknown } | null)?.Name;
        return typeof name === "string" && isProjectMailNetworkName(name);
      });
    } catch {
      return [];
    }
  };
}
