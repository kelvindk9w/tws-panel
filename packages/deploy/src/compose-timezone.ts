/**
 * compose-timezone.ts — o fuso horário escolhido no painel (campo "Fuso
 * horário" do projeto) chega aos serviços como `TZ=<fuso>`.
 *
 * Precedência (decidida com o pedido "sem sobrescrever um TZ que o próprio
 * projeto já defina"):
 *  1. TZ no `environment:` do serviço no compose → o projeto manda;
 *  2. TZ num `env_file:` do serviço — o `.env` vem da seção Variáveis, os
 *     outros arquivos são lidos da pasta do código → o projeto manda;
 *  3. `ENV TZ` no Dockerfile do serviço (quando o painel consegue ler o
 *     contexto de build) → o valor da imagem manda e o painel não injeta;
 *  4. senão, o painel injeta o TZ escolhido pelo paas.override.yml.
 * Imagens de banco/cache (mysql, postgres, redis...) nunca recebem TZ.
 * Imagem pronta (`image:` sem `build:`) com `ENV TZ` interno não dá para
 * detectar: nesse caso o TZ do painel (variável de ambiente) vence o da imagem.
 */
import path from "node:path";
import { parse } from "yaml";
import { isDatabaseImage, type ProjectTimezoneDefinition, type ProjectTimezoneExcluded } from "@paas/core";
import { dockerfileEnvTz } from "./dockerfile.js";

type ServiceDef = { environment?: EnvBlock; env_file?: unknown; image?: unknown; build?: unknown } | null;

type EnvBlock = Record<string, unknown> | unknown[] | null | undefined;

/** Valor de TZ num bloco `environment:` (mapa ou lista); undefined = não define. */
function tzInEnvironment(env: EnvBlock): string | undefined {
  if (Array.isArray(env)) {
    for (const item of env) {
      if (typeof item !== "string") continue;
      if (item === "TZ") return "(do ambiente do servidor)";
      if (item.startsWith("TZ=")) return item.slice(3);
    }
    return undefined;
  }
  if (env && typeof env === "object" && "TZ" in env) {
    const v = env.TZ;
    return v === null || v === undefined ? "(do ambiente do servidor)" : String(v);
  }
  return undefined;
}

/** Caminhos de um `env_file:` (texto, lista de textos ou lista de { path }). */
function envFilePaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list
    .map((v) => (typeof v === "string" ? v : v && typeof v === "object" && "path" in v ? String((v as { path: unknown }).path) : null))
    .filter((v): v is string => v !== null);
}

/** Valor de TZ no conteúdo de um arquivo .env (última definição vale). */
export function tzInDotenv(content: string): string | undefined {
  let found: string | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TZ\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    found = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}

/** Caminho (relativo à raiz do código) do Dockerfile de um serviço com `build:`; null = sem build. */
function serviceDockerfile(def: ServiceDef): string | null {
  const b = def?.build;
  if (typeof b === "string") return path.posix.normalize(path.posix.join(b, "Dockerfile"));
  if (b && typeof b === "object") {
    const o = b as { context?: unknown; dockerfile?: unknown; dockerfile_inline?: unknown };
    if (o.dockerfile_inline !== undefined) return null;
    const ctx = typeof o.context === "string" ? o.context : ".";
    const file = typeof o.dockerfile === "string" ? o.dockerfile : "Dockerfile";
    return path.posix.normalize(path.posix.join(ctx, file));
  }
  return null;
}

function isDotEnv(p: string): boolean {
  return p.replace(/^\.\//, "") === ".env";
}

/**
 * Onde o próprio projeto define TZ, por serviço.
 * `variables`: a seção Variáveis (vira o `.env` do compose).
 * `readFile`: lê um arquivo da pasta do código (null = não existe).
 */
export function composeTimezoneDefinitions(
  compose: string,
  variables: Record<string, string>,
  readFile: (relPath: string) => string | null,
): ProjectTimezoneDefinition[] {
  let doc: { services?: Record<string, ServiceDef> } | null;
  try {
    doc = parse(compose) as typeof doc;
  } catch {
    return [];
  }
  const out: ProjectTimezoneDefinition[] = [];
  for (const [service, def] of Object.entries(doc?.services ?? {})) {
    const inCompose = tzInEnvironment(def?.environment);
    if (inCompose !== undefined) {
      out.push({ service, value: inCompose, where: "compose" });
      continue;
    }
    for (const file of envFilePaths(def?.env_file)) {
      if (isDotEnv(file)) {
        if (variables.TZ !== undefined && variables.TZ !== "") {
          out.push({ service, value: variables.TZ, where: "variables" });
          break;
        }
        continue;
      }
      const content = readFile(file);
      const value = content === null ? undefined : tzInDotenv(content);
      if (value !== undefined) {
        out.push({ service, value, where: "env_file" });
        break;
      }
    }
    if (out.at(-1)?.service === service) continue;
    const dockerfile = serviceDockerfile(def);
    const text = dockerfile === null ? null : readFile(dockerfile);
    const fromImage = text === null ? undefined : dockerfileEnvTz(text);
    if (fromImage !== undefined) out.push({ service, value: fromImage, where: "dockerfile" });
  }
  return out;
}

/** Serviços de banco/cache (imagem reconhecida): o painel não injeta TZ neles. */
export function composeTimezoneExcluded(compose: string): ProjectTimezoneExcluded[] {
  try {
    const doc = parse(compose) as { services?: Record<string, ServiceDef> } | null;
    return Object.entries(doc?.services ?? {})
      .filter(([, def]) => typeof def?.image === "string" && isDatabaseImage(def.image))
      .map(([service, def]) => ({ service, image: String(def!.image) }));
  } catch {
    return [];
  }
}

/** Dockerfiles dos serviços (caminhos relativos à raiz do código), para ler antes de procurar `ENV TZ`. */
export function composeDockerfiles(compose: string): string[] {
  try {
    const doc = parse(compose) as { services?: Record<string, ServiceDef> } | null;
    const all = Object.values(doc?.services ?? {}).map(serviceDockerfile).filter((p): p is string => p !== null);
    return [...new Set(all)];
  } catch {
    return [];
  }
}

/** Todos os `env_file:` dos serviços (para ler os arquivos antes de procurar TZ). */
export function composeEnvFiles(compose: string): string[] {
  try {
    const doc = parse(compose) as { services?: Record<string, { env_file?: unknown } | null> } | null;
    const all = Object.values(doc?.services ?? {}).flatMap((def) => envFilePaths(def?.env_file));
    return [...new Set(all)].filter((p) => !isDotEnv(p));
  } catch {
    return [];
  }
}

/** Serviços do compose (para injetar o TZ em quem não define). */
export function composeServiceList(compose: string): string[] {
  try {
    const doc = parse(compose) as { services?: Record<string, unknown> } | null;
    return Object.keys(doc?.services ?? {});
  } catch {
    return [];
  }
}

/** TZ por serviço para o paas.override.yml: todos menos os que já definem. */
export function timezoneServiceEnv(
  services: string[],
  definitions: ProjectTimezoneDefinition[],
  zone: string | null,
  excluded: ProjectTimezoneExcluded[] = [],
): Record<string, Record<string, string>> {
  if (!zone) return {};
  const defined = new Set([...definitions.map((d) => d.service), ...excluded.map((e) => e.service)]);
  return Object.fromEntries(services.filter((s) => !defined.has(s)).map((s) => [s, { TZ: zone }]));
}
