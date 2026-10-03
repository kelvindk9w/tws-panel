/**
 * compose-services.ts — todos os serviços do compose, como o painel os
 * entende: imagem ou build, portas publicadas (e o que o painel faz com
 * 80/443), portas internas conhecidas, rede compartilhada (`network_mode:
 * service:X`), dependências e healthcheck.
 *
 * Antes a detecção mostrava só a entrada HTTP (serviço/porta). Num compose
 * grande (validação real: o cassino, com cinco serviços e um Caddy que atende
 * DENTRO do wallet) isso não bastava para entender por que a entrada é
 * "wallet:80" nem o que sobe junto.
 *
 * Só lê: o compose (já carregado) e, quando o build é local, o Dockerfile —
 * sempre dentro da pasta do projeto.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ComposeInternalPort, ComposePublishedPort, ComposeServiceInfo } from "@paas/core";
import { parse } from "yaml";
import { publishedPorts, type PublishedPort } from "./compose-ports.js";
import { hasOwnHttpsProxy } from "./proxy-ports.js";

type Service = Record<string, unknown>;

function servicesOf(content: string): Record<string, Service | null> {
  let doc: { services?: unknown } | null;
  try {
    doc = parse(content) as { services?: unknown } | null;
  } catch {
    return {};
  }
  const services = doc?.services;
  return services && typeof services === "object" && !Array.isArray(services)
    ? (services as Record<string, Service | null>)
    : {};
}

function hostPortOf(p: PublishedPort): number | null {
  return p.host.kind === "fixed" ? p.host.port : null;
}

function mappingOf(p: PublishedPort): string {
  const ip = p.hostIp === null ? "" : `${p.hostIp.includes(":") ? `[${p.hostIp}]` : p.hostIp}:`;
  switch (p.host.kind) {
    case "fixed":
      return `${ip}${p.host.port}:${p.container}`;
    case "range":
      return `${ip}${p.host.start}-${p.host.end}:${p.container}`;
    case "variable":
      return `${ip}${p.host.raw}:${p.container}`;
    case "random":
      return `${ip}${p.container}`;
  }
}

function buildOf(build: unknown): { context: string; dockerfile: string } | null {
  if (typeof build === "string") return { context: build, dockerfile: "Dockerfile" };
  if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    return {
      context: typeof b.context === "string" ? b.context : ".",
      dockerfile: typeof b.dockerfile === "string" ? b.dockerfile : "Dockerfile",
    };
  }
  return null;
}

/** Dockerfile do build local, lido só se estiver dentro da pasta do projeto. */
async function readDockerfile(dir: string, build: { context: string; dockerfile: string }): Promise<string | null> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(build.context) || build.context.startsWith("git@")) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, build.context, build.dockerfile);
  if (!file.startsWith(root + path.sep)) return null;
  return readFile(file, "utf8").catch(() => null);
}

const LOCAL_URL_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})/;

function validPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function healthcheckPort(text: string): number | null {
  const m = LOCAL_URL_PORT.exec(text);
  const port = m ? Number(m[1]) : NaN;
  return validPort(port) ? port : null;
}

/** EXPOSE (todas as portas literais) e a linha do HEALTHCHECK de um Dockerfile. */
function dockerfileFacts(content: string): { expose: number[]; healthcheck: string | null } {
  const joined = content.replace(/\\\r?\n/g, " ");
  const expose: number[] = [];
  let healthcheck: string | null = null;
  for (const line of joined.split(/\r?\n/)) {
    const ex = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (ex) {
      for (const token of ex[1]!.trim().split(/\s+/)) {
        const m = /^(\d+)(?:\/(?:tcp|udp|sctp))?$/i.exec(token);
        if (m && validPort(Number(m[1]))) expose.push(Number(m[1]));
      }
    }
    const hc = /^\s*HEALTHCHECK\s+(.+)$/i.exec(line);
    if (hc) healthcheck = hc[1]!.trim();
  }
  return { expose, healthcheck };
}

function composeHealthcheck(svc: Service): { state: "compose" | "disabled" | null; text: string } {
  const hc = svc.healthcheck;
  if (!hc || typeof hc !== "object") return { state: null, text: "" };
  const h = hc as Record<string, unknown>;
  const test = h.test;
  if (h.disable === true || (Array.isArray(test) && test[0] === "NONE")) return { state: "disabled", text: "" };
  return { state: "compose", text: Array.isArray(test) ? test.map(String).join(" ") : String(test ?? "") };
}

function envPort(environment: unknown): number | null {
  let value: unknown;
  if (Array.isArray(environment)) {
    const entry = environment.find((e) => typeof e === "string" && e.startsWith("PORT="));
    value = typeof entry === "string" ? entry.slice(5) : undefined;
  } else if (environment && typeof environment === "object") {
    value = (environment as Record<string, unknown>).PORT;
  }
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return validPort(port) ? port : null;
}

function exposePorts(expose: unknown): number[] {
  if (!Array.isArray(expose)) return [];
  return expose
    .map((e) => /^(\d+)(?:\/(?:tcp|udp|sctp))?$/i.exec(String(e).trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter(validPort);
}

function dependsOnOf(dependsOn: unknown): Array<{ service: string; condition: string | null }> {
  if (Array.isArray(dependsOn)) return dependsOn.map((s) => ({ service: String(s), condition: null }));
  if (dependsOn && typeof dependsOn === "object") {
    return Object.entries(dependsOn as Record<string, unknown>).map(([service, v]) => {
      const condition = v && typeof v === "object" ? (v as Record<string, unknown>).condition : undefined;
      return { service, condition: typeof condition === "string" ? condition : null };
    });
  }
  return [];
}

/** Lista os serviços do compose na ordem em que aparecem no arquivo. */
export async function describeComposeServices(dir: string, content: string): Promise<ComposeServiceInfo[]> {
  const services = servicesOf(content);
  const result: ComposeServiceInfo[] = [];
  for (const [name, raw] of Object.entries(services)) {
    const svc: Service = raw && typeof raw === "object" ? raw : {};
    const build = buildOf(svc.build);
    const dockerfile = build ? await readDockerfile(dir, build) : null;
    const facts = dockerfile ? dockerfileFacts(dockerfile) : { expose: [], healthcheck: null };
    const hc = composeHealthcheck(svc);

    const ownProxy = hasOwnHttpsProxy(content, name);
    const published: ComposePublishedPort[] = publishedPorts(svc.ports).map((p) => {
      const host = hostPortOf(p);
      const proxyPort = host === 80 || host === 443;
      return {
        mapping: mappingOf(p),
        containerPort: p.container,
        hostPort: host,
        panel: proxyPort ? (ownProxy ? "conflict" : "removed") : null,
      };
    });

    const internal: ComposeInternalPort[] = [];
    const add = (port: number | null, source: ComposeInternalPort["source"]) => {
      if (port !== null && !internal.some((p) => p.port === port)) internal.push({ port, source });
    };
    for (const port of exposePorts(svc.expose)) add(port, "expose");
    for (const port of facts.expose) add(port, "dockerfile");
    const hcText = hc.state === "compose" ? hc.text : hc.state === null ? (facts.healthcheck ?? "") : "";
    add(healthcheckPort(hcText), "healthcheck");
    add(envPort(svc.environment), "environment");

    const mode = typeof svc.network_mode === "string" ? /^service:(.+)$/.exec(svc.network_mode)?.[1] : undefined;
    result.push({
      name,
      image: typeof svc.image === "string" ? svc.image : null,
      build,
      publishedPorts: published,
      internalPorts: internal,
      networkModeService: mode ?? null,
      dependsOn: dependsOnOf(svc.depends_on),
      healthcheck: hc.state ?? (facts.healthcheck ? "dockerfile" : null),
    });
  }
  return result;
}
