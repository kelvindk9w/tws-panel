/**
 * compose-timezone.ts — o fuso horário escolhido no painel (campo "Fuso
 * horário" do projeto) chega aos serviços como `TZ=<fuso>`.
 *
 * Precedência (decidida com o pedido "sem sobrescrever um TZ que o próprio
 * projeto já defina"):
 *  1. TZ no `environment:` do serviço no compose → o projeto manda;
 *  2. TZ num `env_file:` do serviço — o `.env` vem da seção Variáveis, os
 *     outros arquivos são lidos da pasta do código → o projeto manda;
 *  3. senão, o painel injeta o TZ escolhido pelo paas.override.yml.
 * Um `ENV TZ` dentro do Dockerfile/imagem perde para a escolha do painel: só
 * há injeção quando a pessoa escolhe um fuso (o padrão é "Padrão da imagem").
 */
import { parse } from "yaml";
import type { ProjectTimezoneDefinition } from "@paas/core";

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
  let doc: { services?: Record<string, { environment?: EnvBlock; env_file?: unknown } | null> } | null;
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
  }
  return out;
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
): Record<string, Record<string, string>> {
  if (!zone) return {};
  const defined = new Set(definitions.map((d) => d.service));
  return Object.fromEntries(services.filter((s) => !defined.has(s)).map((s) => [s, { TZ: zone }]));
}
