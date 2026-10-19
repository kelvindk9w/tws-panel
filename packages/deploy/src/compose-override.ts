/**
 * compose-override.ts — o arquivo complementar (paas.override.yml) que o painel
 * gera para o compose adotado. NÃO reescreve o compose do repositório; apenas:
 *  - anexa o serviço web à rede do painel com um alias estável para o Caddy;
 *  - com e-mail habilitado, liga os serviços que recebem o SMTP_* à rede de e-mail;
 *  - injeta env extra (ex.: SMTP do painel) nos serviços indicados;
 *  - injeta o TZ do fuso do projeto nos serviços que não definem TZ;
 *  - em app comum, troca a lista de portas por uma sem 80/443 do host
 *    (`ports: !override`, ver proxy-ports.ts);
 *  - aplica as trocas da porta do servidor feitas no painel (modal Portas,
 *    ver port-overrides.ts), na mesma lista `!override`.
 */
import { Document } from "yaml";
import type { PortOverride } from "@paas/core";
import { effectiveServicePorts } from "./port-overrides.js";
import { hasOwnHttpsProxy, portsWithoutProxyPorts } from "./proxy-ports.js";

export interface ComposeOverrideOptions {
  /** conteúdo do compose do repositório */
  compose: string;
  proxyService: string;
  slug: string;
  network: string;
  /** Rede de e-mail (paas-mail): só entram nela os `mailServices`, sem aliases. */
  mailNetwork?: string;
  /** Serviços de um projeto com e-mail habilitado (os que recebem o SMTP_*). */
  mailServices?: string[];
  env?: Record<string, string>;
  envServices?: string[];
  /** Trocas da porta do servidor por serviço (Project.portOverrides). */
  portOverrides?: Record<string, PortOverride[]>;
  /** Env de um serviço só (ex.: TZ do fuso do projeto, ver compose-timezone.ts). */
  serviceEnv?: Record<string, Record<string, string>>;
}

export const OVERRIDE_HEADER = "# Gerado pelo painel PaaS — não editar. Anexa o serviço web à rede do painel.\n";

/** Serviços cujas portas 80/443 o painel retira no deploy. */
export function strippedProxyPortServices(compose: string): string[] {
  return Object.keys(portsWithoutProxyPorts(compose)).filter((name) => !hasOwnHttpsProxy(compose, name));
}

/**
 * Endurece TODO serviço do modelo já resolvido (inclusive os de `include` e
 * `extends`, que o override por nome não alcança): sem NET_RAW (nenhum
 * container forja ARP/DNS na rede do proxy) e com `no-new-privileges`. Só
 * acrescenta; o que o projeto já pedia fica. Não altera o objeto recebido.
 */
export function hardenComposeModel(model: unknown): unknown {
  if (typeof model !== "object" || model === null || Array.isArray(model)) return model;
  const services = (model as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return model;
  const hardened: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(services)) {
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      hardened[name] = def;
      continue;
    }
    const service = def as Record<string, unknown>;
    const merge = (current: unknown, add: string) => {
      const list = Array.isArray(current) ? current.map(String) : [];
      return list.includes(add) ? list : [...list, add];
    };
    hardened[name] = {
      ...service,
      cap_drop: merge(service.cap_drop, "NET_RAW"),
      security_opt: merge(service.security_opt, "no-new-privileges:true"),
    };
  }
  return { ...(model as Record<string, unknown>), services: hardened };
}

export function composeOverrideYaml(opts: ComposeOverrideOptions): string {
  const env = opts.env ?? {};
  const services: Record<string, Record<string, unknown>> = {
    [opts.proxyService]: {
      networks: { default: null, [opts.network]: { aliases: [opts.slug] } },
    },
  };
  if (Object.keys(env).length > 0) {
    for (const name of opts.envServices ?? []) {
      services[name] = { ...(services[name] ?? {}), environment: { ...env } };
    }
  }
  for (const [name, extra] of Object.entries(opts.serviceEnv ?? {})) {
    const current = (services[name]?.environment as Record<string, string> | undefined) ?? {};
    services[name] = { ...(services[name] ?? {}), environment: { ...current, ...extra } };
  }

  const mailServices = opts.mailNetwork ? (opts.mailServices ?? []) : [];
  for (const name of mailServices) {
    const current = (services[name]?.networks as Record<string, unknown> | undefined) ?? { default: null };
    services[name] = { ...(services[name] ?? {}), networks: { ...current, [opts.mailNetwork!]: null } };
  }
  const topNetworks: Record<string, unknown> = { [opts.network]: { external: true } };
  if (mailServices.length > 0) topNetworks[opts.mailNetwork!] = { external: true };
  const doc = new Document({ networks: topNetworks, services });
  const { ports } = effectiveServicePorts(opts.compose, opts.portOverrides, { stripProxyPorts: true });
  for (const [name, list] of Object.entries(ports)) {
    const node = doc.createNode(list);
    node.tag = "!override";
    doc.setIn(["services", name, "ports"], node);
  }
  return OVERRIDE_HEADER + String(doc);
}
