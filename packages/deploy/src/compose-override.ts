/**
 * compose-override.ts — o arquivo complementar (paas.override.yml) que o painel
 * gera para o compose adotado. NÃO reescreve o compose do repositório; apenas:
 *  - anexa o serviço web à rede do painel com um alias estável para o Caddy;
 *  - injeta env extra (ex.: SMTP do painel) nos serviços indicados;
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
  env?: Record<string, string>;
  envServices?: string[];
  /** Trocas da porta do servidor por serviço (Project.portOverrides). */
  portOverrides?: Record<string, PortOverride[]>;
}

export const OVERRIDE_HEADER = "# Gerado pelo painel PaaS — não editar. Anexa o serviço web à rede do painel.\n";

/** Serviços cujas portas 80/443 o painel retira no deploy. */
export function strippedProxyPortServices(compose: string): string[] {
  return Object.keys(portsWithoutProxyPorts(compose)).filter((name) => !hasOwnHttpsProxy(compose, name));
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

  const doc = new Document({ networks: { [opts.network]: { external: true } }, services });
  const { ports } = effectiveServicePorts(opts.compose, opts.portOverrides, { stripProxyPorts: true });
  for (const [name, list] of Object.entries(ports)) {
    const node = doc.createNode(list);
    node.tag = "!override";
    doc.setIn(["services", name, "ports"], node);
  }
  return OVERRIDE_HEADER + String(doc);
}
