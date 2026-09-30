/**
 * compose-override.ts — o arquivo complementar (paas.override.yml) que o painel
 * gera para o compose adotado. NÃO reescreve o compose do repositório; apenas:
 *  - anexa o serviço web à rede do painel com um alias estável para o Caddy;
 *  - injeta env extra (ex.: SMTP do painel) nos serviços indicados;
 *  - em app comum, troca a lista de portas por uma sem 80/443 do host
 *    (`ports: !override`, ver proxy-ports.ts).
 */
import { Document } from "yaml";
import { hasOwnHttpsProxy, portsWithoutProxyPorts } from "./proxy-ports.js";

export interface ComposeOverrideOptions {
  /** conteúdo do compose do repositório */
  compose: string;
  proxyService: string;
  slug: string;
  network: string;
  env?: Record<string, string>;
  envServices?: string[];
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
  const remaining = portsWithoutProxyPorts(opts.compose);
  for (const name of strippedProxyPortServices(opts.compose)) {
    const node = doc.createNode(remaining[name]);
    node.tag = "!override";
    doc.setIn(["services", name, "ports"], node);
  }
  return OVERRIDE_HEADER + String(doc);
}
