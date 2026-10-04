/**
 * port-overrides.ts — trocas da porta do SERVIDOR feitas no painel (modal
 * "Portas" da página do projeto). Pedido do dono depois de publicar o cassino:
 * trocar a porta publicada de um container sem mexer no repositório.
 *
 * O painel só LÊ o repositório. A troca vai para o arquivo complementar
 * (paas.override.yml) com `ports: !override` — o mesmo mecanismo que já retira
 * 80/443 (proxy-ports.ts). A lista final de cada serviço é: as portas do
 * compose, sem 80/443 (app comum), com as trocas e remoções aplicadas.
 *
 * Só o lado do servidor muda (porta e endereço de escuta). A porta interna —
 * onde o app escuta dentro do container — é do código do app, nunca muda aqui.
 *
 * Cada porta publicada tem uma chave estável: como ela está escrita no compose
 * ("127.0.0.1:8010:8010", "5353:53/udp"). Se o compose mudar e a porta sumir,
 * a troca deixa de valer (e o deploy avisa) em vez de cair noutra porta.
 */
import type { PortOverride } from "@paas/core";
import { parse } from "yaml";
import { publishedPorts, type PublishedPort } from "./compose-ports.js";
import { hasOwnHttpsProxy } from "./proxy-ports.js";

/** Uma porta publicada de um serviço do compose, como o painel a identifica. */
export interface ComposePortEntry {
  /** Chave estável: a porta como está no compose. */
  key: string;
  containerPort: number;
  protocol: string;
  /** Endereço de escuta do compose; null = todos. */
  hostIp: string | null;
  /** Porta do servidor quando fixa; null = faixa, variável ou aleatória. */
  hostPort: number | null;
  /** Lado do servidor em texto ("127.0.0.1:8010", "${P}", "aleatória"). */
  composeHost: string;
  /** 80/443: "removed" = o painel retira; "conflict" = proxy HTTPS próprio. */
  panel: "removed" | "conflict" | null;
}

function servicesOf(content: string): Record<string, Record<string, unknown> | null> {
  let doc: { services?: unknown } | null;
  try {
    doc = parse(content) as { services?: unknown } | null;
  } catch {
    return {};
  }
  const services = doc?.services;
  return services && typeof services === "object" && !Array.isArray(services)
    ? (services as Record<string, Record<string, unknown> | null>)
    : {};
}

function ipPrefix(ip: string | null): string {
  if (ip === null) return "";
  return ip.includes(":") ? `[${ip}]:` : `${ip}:`;
}

function hostText(p: PublishedPort): string {
  switch (p.host.kind) {
    case "fixed":
      return String(p.host.port);
    case "range":
      return `${p.host.start}-${p.host.end}`;
    case "variable":
      return p.host.raw;
    case "random":
      return "";
  }
}

/**
 * Chave da porta: forma curta normalizada, com o protocolo quando não é tcp.
 * É também o texto que vai para o override quando a entrada é reescrita.
 */
function keyOf(p: PublishedPort): string {
  const proto = p.protocol === "tcp" ? "" : `/${p.protocol}`;
  if (p.host.kind === "random") return `${p.hostIp === null ? "" : `${ipPrefix(p.hostIp)}:`}${p.container}${proto}`;
  return `${ipPrefix(p.hostIp)}${hostText(p)}:${p.container}${proto}`;
}

function isProxyPort(p: PublishedPort): boolean {
  return p.host.kind === "fixed" && (p.host.port === 80 || p.host.port === 443);
}

/** Forma curta do compose para uma porta publicada: "127.0.0.1:18010:8010". */
export function portEntryText(hostIp: string | null, hostPort: number, containerPort: number, protocol: string): string {
  return `${ipPrefix(hostIp)}${hostPort}:${containerPort}${protocol === "tcp" ? "" : `/${protocol}`}`;
}

/** Portas publicadas de cada serviço do compose (todos os serviços, na ordem do arquivo). */
export function composePortEntries(compose: string): Record<string, ComposePortEntry[]> {
  const result: Record<string, ComposePortEntry[]> = {};
  for (const [name, svc] of Object.entries(servicesOf(compose))) {
    const ownProxy = hasOwnHttpsProxy(compose, name);
    result[name] = publishedPorts(svc?.ports).map((p) => {
      const text = hostText(p);
      return {
        key: keyOf(p),
        containerPort: p.container,
        protocol: p.protocol,
        hostIp: p.hostIp,
        hostPort: p.host.kind === "fixed" ? p.host.port : null,
        composeHost: p.host.kind === "random" ? (p.hostIp === null ? "aleatória" : `aleatória em ${p.hostIp}`) : `${ipPrefix(p.hostIp)}${text}`,
        panel: isProxyPort(p) ? (ownProxy ? "conflict" : "removed") : null,
      };
    });
  }
  return result;
}

export interface EffectivePorts {
  /** Lista final de portas, só dos serviços que mudam. */
  ports: Record<string, unknown[]>;
  /** Trocas aplicadas (para o log do deploy); to null = publicação removida. */
  changes: Array<{ service: string; from: string; to: string | null }>;
  /** Trocas salvas que não se aplicam mais (porta fora do compose, ou 80/443). */
  stale: Array<{ service: string; original: string }>;
}

/**
 * Lista final de portas por serviço. `stripProxyPorts` = retirar 80/443 de app
 * comum (o deploy); sem ela (os guardrails), só as trocas do painel entram.
 */
export function effectiveServicePorts(
  compose: string,
  overrides: Record<string, PortOverride[]> | undefined,
  opts: { stripProxyPorts: boolean },
): EffectivePorts {
  const services = servicesOf(compose);
  const result: EffectivePorts = { ports: {}, changes: [], stale: [] };
  const used = new Set<string>();

  for (const [name, svc] of Object.entries(services)) {
    const raw = Array.isArray(svc?.ports) ? (svc.ports as unknown[]) : [];
    const strip = opts.stripProxyPorts && !hasOwnHttpsProxy(compose, name);
    const byKey = new Map((overrides?.[name] ?? []).map((o) => [o.original, o]));
    let changed = false;
    const list: unknown[] = [];
    for (const entry of raw) {
      const expanded = publishedPorts([entry]);
      if (strip && expanded.some(isProxyPort)) {
        changed = true;
        continue;
      }
      const touched = expanded.some((p) => !isProxyPort(p) && byKey.has(keyOf(p)));
      if (!touched) {
        list.push(entry);
        continue;
      }
      changed = true;
      for (const p of expanded) {
        const key = keyOf(p);
        const o = isProxyPort(p) ? undefined : byKey.get(key);
        if (!o) {
          list.push(key);
          continue;
        }
        used.add(`${name}\n${key}`);
        const to = o.hostPort === null ? null : portEntryText(o.hostIp, o.hostPort, p.container, p.protocol);
        if (to !== null) list.push(to);
        result.changes.push({ service: name, from: key, to });
      }
    }
    if (changed) result.ports[name] = list;
  }

  for (const [service, list] of Object.entries(overrides ?? {})) {
    for (const o of list) {
      if (!used.has(`${service}\n${o.original}`)) result.stale.push({ service, original: o.original });
    }
  }
  return result;
}
