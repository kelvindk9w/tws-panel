/**
 * compose-override.ts — o arquivo complementar (paas.override.yml) que o painel
 * gera para o compose adotado. NÃO reescreve o compose do repositório; apenas:
 *  - anexa o serviço web à rede do painel com um alias estável para o Caddy;
 *  - com e-mail habilitado, liga os serviços que recebem o SMTP_* à rede de e-mail;
 *  - injeta env extra (ex.: SMTP do painel) nos serviços indicados;
 *  - injeta o TZ do fuso do projeto nos serviços que não definem TZ;
 *  - passa ao build (`build.args`) as Variáveis marcadas como "de build" que o Dockerfile declara com ARG;
 *  - em app comum, troca a lista de portas por uma sem 80/443 do host
 *    (`ports: !override`, ver proxy-ports.ts);
 *  - aplica as trocas da porta do servidor feitas no painel (modal Portas,
 *    ver port-overrides.ts), na mesma lista `!override`.
 */
import { Document, parse } from "yaml";
import { TWS_LABEL_MAIL_DECIDED, type PortOverride } from "@paas/core";
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
  /** Decisão por serviço (`in`/`out`), gravada como label `tws.mail.decided` para o painel agir no container já rodando. */
  mailDecisions?: Record<string, "in" | "out">;
  /** Modelo resolvido do compose (docker compose config, sem o override): decide quem tem network_mode. */
  resolved?: unknown;
  env?: Record<string, string>;
  envServices?: string[];
  /** Trocas da porta do servidor por serviço (Project.portOverrides). */
  portOverrides?: Record<string, PortOverride[]>;
  /** Env de um serviço só (ex.: TZ do fuso do projeto, ver compose-timezone.ts). */
  serviceEnv?: Record<string, Record<string, string>>;
  /**
   * Argumentos de build por serviço (`build.args`): as Variáveis marcadas como "de build" que o Dockerfile do
   * serviço declara com ARG. Valem sobre os `args` do compose do repositório (o painel é a fonte da Variável).
   */
  buildArgs?: Record<string, Record<string, string>>;
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

type OwnerResult = { kind: "self" } | { kind: "owner"; name: string } | { kind: "none" };

type ServiceDefs = Record<string, Record<string, unknown>>;

function servicesOf(doc: unknown): ServiceDefs {
  const services = (doc as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return {};
  return services as ServiceDefs;
}

/**
 * Serviços com o que importa para as redes. Com o modelo resolvido (saída do
 * `docker compose config`: merge, extends — inclusive de outro arquivo — e
 * include já aplicados) vale ele. Sem ele, o YAML cru com merge `<<:` e
 * `extends` do mesmo arquivo resolvidos (o de outro arquivo só o modelo resolvido alcança).
 */
export function composeServiceDefs(compose: string, resolved?: unknown): ServiceDefs {
  if (resolved !== undefined) {
    const fromModel = servicesOf(resolved);
    if (Object.keys(fromModel).length > 0) return fromModel;
  }
  let raw: ServiceDefs;
  try {
    raw = servicesOf(parse(compose, { merge: true }));
  } catch {
    return {};
  }
  const out: ServiceDefs = {};
  for (const [name, def] of Object.entries(raw)) {
    let mode = def?.network_mode;
    const seen = new Set<string>([name]);
    let ext = def?.extends;
    while (mode === undefined && ext !== undefined) {
      const target = typeof ext === "string" ? ext : typeof ext === "object" && ext !== null && (ext as { file?: unknown }).file === undefined ? (ext as { service?: unknown }).service : undefined;
      if (typeof target !== "string" || seen.has(target) || !(target in raw)) break;
      seen.add(target);
      mode = raw[target]?.network_mode;
      ext = raw[target]?.extends;
    }
    out[name] = mode === undefined ? (def ?? {}) : { ...(def ?? {}), network_mode: mode };
  }
  return out;
}

/**
 * Quem pode receber `networks` no lugar de `name`. O compose recusa `networks`
 * junto de `network_mode`; então o serviço com `network_mode: service:X` usa a
 * rede de X (segue a cadeia). `host`/`none`/`bridge`/`container:...`, dono
 * inexistente e ciclo não têm dono ("none"): nada é gerado para eles.
 */
export function networkOwner(defs: ServiceDefs, name: string): OwnerResult {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    const def = defs[current];
    const mode = typeof def?.network_mode === "string" ? def.network_mode.trim() : "";
    if (mode === "") return current === name ? { kind: "self" } : { kind: "owner", name: current };
    const m = /^service:(.+)$/.exec(mode);
    if (!m || seen.has(current)) return { kind: "none" };
    seen.add(current);
    const next = m[1]!.trim();
    if (!(next in defs)) return { kind: "none" };
    current = next;
  }
}

export interface MailNetworkTargets {
  /** Serviços que de fato recebem `networks` com a rede de e-mail. */
  targets: string[];
  /** Serviço com network_mode → dono do namespace que entrou no lugar dele. */
  delegated: Record<string, string>;
  /** Serviços sem como entrar na rede (host, none, container:, dono inexistente, ciclo). */
  skipped: string[];
}

/** Resolve os serviços do e-mail para os que podem receber `networks` (dono do namespace no lugar de quem o compartilha). */
export function mailNetworkTargets(compose: string, requested: readonly string[], resolved?: unknown): MailNetworkTargets {
  const defs = composeServiceDefs(compose, resolved);
  const targets: string[] = [];
  const delegated: Record<string, string> = {};
  const skipped: string[] = [];
  for (const name of requested) {
    const r = networkOwner(defs, name);
    if (r.kind === "none") {
      if (!skipped.includes(name)) skipped.push(name);
      continue;
    }
    const target = r.kind === "self" ? name : r.name;
    if (r.kind === "owner") delegated[name] = target;
    if (!targets.includes(target)) targets.push(target);
  }
  return { targets, delegated, skipped };
}

export function composeOverrideYaml(opts: ComposeOverrideOptions): string {
  const env = opts.env ?? {};
  const defs = composeServiceDefs(opts.compose, opts.resolved);
  const services: Record<string, Record<string, unknown>> = {};
  const proxyOwner = networkOwner(defs, opts.proxyService);
  if (proxyOwner.kind !== "none") {
    const proxyTarget = proxyOwner.kind === "owner" ? proxyOwner.name : opts.proxyService;
    services[proxyTarget] = { networks: { default: null, [opts.network]: { aliases: [opts.slug] } } };
  }
  if (Object.keys(env).length > 0) {
    for (const name of opts.envServices ?? []) {
      services[name] = { ...(services[name] ?? {}), environment: { ...env } };
    }
  }
  for (const [name, extra] of Object.entries(opts.serviceEnv ?? {})) {
    const current = (services[name]?.environment as Record<string, string> | undefined) ?? {};
    services[name] = { ...(services[name] ?? {}), environment: { ...current, ...extra } };
  }

  for (const [name, args] of Object.entries(opts.buildArgs ?? {})) {
    // `$` é interpolação do compose: dobrado para o valor chegar ao build exatamente como foi salvo
    const escaped = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.split("$").join("$$")]));
    services[name] = { ...(services[name] ?? {}), build: { args: escaped } };
  }

  for (const [name, decided] of Object.entries(opts.mailDecisions ?? {})) {
    services[name] = { ...(services[name] ?? {}), labels: { [TWS_LABEL_MAIL_DECIDED]: decided } };
  }
  const mailServices = opts.mailNetwork ? mailNetworkTargets(opts.compose, opts.mailServices ?? [], opts.resolved).targets : [];
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
