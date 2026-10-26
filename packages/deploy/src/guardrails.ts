/**
 * guardrails.ts — análise de segurança de arquivos docker-compose ao adotá-los.
 *
 * Prévia da Fase 4 (plano §5.4): motivada pelos problemas REAIS encontrados nos
 * projetos do usuário (docs/internal/projects-analysis.md — cachetaGrok):
 *  - porta de banco de dados publicada no host (5432 exposta);
 *  - credenciais fracas/hardcoded (cacheta:cacheta);
 *  - serviços de dev em produção (Mailhog na 8025).
 */
import { parse } from "yaml";
import { PAAS_NETWORK, type GuardrailWarning } from "@paas/core";
import { DATABASE_PORTS, describeHostSide, publishedPorts } from "./compose-ports.js";
import { checkComposeModel } from "./compose-model.js";
import { resolveWithVariables } from "./variable-resolve.js";

/** Imagens de serviços típicos de desenvolvimento. */
const DEV_IMAGES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /mailhog/i, name: "Mailhog" },
  { pattern: /mailpit/i, name: "Mailpit" },
  { pattern: /phpmyadmin/i, name: "phpMyAdmin" },
  { pattern: /adminer/i, name: "Adminer" },
  { pattern: /pgadmin/i, name: "pgAdmin" },
];

/** Chaves de ambiente que carregam credenciais. */
const SECRET_KEY_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)/i;

/** Valores notoriamente fracos (minúsculos para comparação). */
const WEAK_VALUES = new Set([
  "password",
  "passwd",
  "secret",
  "changeme",
  "change-me",
  "admin",
  "root",
  "1234",
  "12345",
  "123456",
  "12345678",
  "qwerty",
  "cacheta",
  "dev",
  "test",
]);

interface ComposeService {
  image?: string;
  ports?: unknown;
  environment?: unknown;
  networks?: unknown;
  privileged?: unknown;
  volumes?: unknown;
  [key: string]: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function envEntries(environment: unknown): Array<[string, string | null]> {
  if (Array.isArray(environment)) {
    return environment
      .map((item) => asString(item))
      .filter((s): s is string => s !== null)
      .map((s) => {
        const idx = s.indexOf("=");
        return idx === -1 ? ([s, null] as [string, null]) : ([s.slice(0, idx), s.slice(idx + 1)] as [string, string]);
      });
  }
  if (environment && typeof environment === "object") {
    return Object.entries(environment as Record<string, unknown>).map(([k, v]) => [
      k,
      v === null || v === undefined ? null : String(v),
    ]);
  }
  return [];
}

function isWeakSecret(value: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (WEAK_VALUES.has(v)) return true;
  // usuário:senha iguais (ex.: "cacheta:cacheta") ou valor muito curto
  if (v.includes(":")) {
    const [user, pass] = v.split(":", 2);
    if (user && pass && user === pass) return true;
  }
  return v.length > 0 && v.length < 6;
}

/**
 * Analisa o conteúdo de um arquivo compose e retorna os warnings de guardrails.
 * Lança erro se o YAML for inválido.
 */
export function analyzeCompose(
  content: string,
  fileName: string,
  srcRoot?: string,
  /** Valores das Variáveis salvas do projeto: conferem credencial fraca por trás de `${VAR}`; só o nome sai. */
  variables?: Readonly<Record<string, string>>,
): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const doc = parse(content, { merge: true }) as ComposeFile;
  const services = doc.services ?? {};

  for (const [name, service] of Object.entries(services)) {
    // 1) porta de banco publicada no host
    // A porta do host pode ser aleatória ou vir de variável — o que decide é a
    // porta do container. O endereço (hostIp) ainda não é considerado: loopback
    // também é acusado, igual à regra que bloqueia em rules.ts.
    for (const port of publishedPorts(service.ports)) {
      const db = DATABASE_PORTS.get(port.container);
      if (db) {
        warnings.push({
          id: "compose.db-port-exposed",
          severity: "critical",
          service: name,
          message: `Serviço "${name}" publica ${describeHostSide(port)} para a porta ${port.container} do ${db}. Em produção, bancos não devem ser acessíveis de fora da rede Docker.`,
        });
      }
    }

    // 2) serviço de dev em produção
    const image = asString(service.image) ?? "";
    for (const { pattern, name: devName } of DEV_IMAGES) {
      if (pattern.test(image)) {
        warnings.push({
          id: "compose.dev-service",
          severity: "warning",
          service: name,
          message: `Serviço "${name}" usa ${devName}, ferramenta de desenvolvimento. Remova do deploy de produção.`,
        });
      }
    }

    // 3) credenciais fracas em variáveis de ambiente
    for (const [key, raw] of envEntries(service.environment)) {
      const resolved = raw === null ? null : resolveWithVariables(raw, variables);
      if (SECRET_KEY_PATTERN.test(key) && isWeakSecret(resolved?.text ?? null)) {
        const from = resolved && resolved.names.length > 0 ? ` (valor da Variável ${resolved.names.join(", ")})` : "";
        warnings.push({
          id: "compose.weak-credentials",
          severity: "warning",
          service: name,
          message: `Serviço "${name}" define ${key} com valor fraco ou previsível${from}. Gere uma credencial forte e gerencie como secret.`,
        });
      }
    }

  }

  // 4) o que o compose pode pedir ao Docker (privilégios, namespaces, montagens,
  // redes e build) — a MESMA lista de compose-model.ts que barra o deploy
  // (rules.ts). Sem a pasta do projeto só dá para conferir os privilégios.
  for (const f of checkComposeModel(doc, { fileName, srcRoot: srcRoot ?? ".", mode: "raw", panelNetwork: PAAS_NETWORK })) {
    if (!srcRoot && !["privileged-container", "host-namespace", "panel-resource", "unsupported-field"].includes(f.rule)) continue;
    warnings.push({
      id: `compose.${f.rule}`,
      severity: "critical",
      ...(f.service ? { service: f.service } : {}),
      message: `${f.title} — ${f.evidence}. Isso vai BLOQUEAR o deploy até ser corrigido.`,
    });
  }

  if (Object.keys(services).length === 0) {
    warnings.push({
      id: "compose.no-services",
      severity: "info",
      message: `Nenhum serviço encontrado em ${fileName}. Verifique se é o arquivo correto.`,
    });
  }

  return warnings;
}

/** Primeira porta de `expose` do serviço ("3000", 3000 ou "3000/tcp"); null se não há uma válida. */
function exposedPort(service: ComposeService): number | null {
  const expose = service.expose;
  if (!Array.isArray(expose) || expose.length === 0) return null;
  const port = Number(String(expose[0]).replace(/\/(tcp|udp)$/i, ""));
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Heurística para escolher o serviço/porta que recebe o tráfego web (upstream
 * do Caddy central): prioriza serviços com nome/imagem de proxy web, depois
 * quem publica 80/443, depois quem expõe portas web comuns.
 */
export function guessProxyTarget(
  content: string,
): { service: string | null; port: number | null; notes: string[] } {
  const notes: string[] = [];
  let doc: ComposeFile;
  try {
    doc = parse(content) as ComposeFile;
  } catch {
    return { service: null, port: null, notes };
  }
  const services = doc.services ?? {};
  const names = Object.keys(services);
  if (names.length === 0) return { service: null, port: null, notes };

  const WEB_NAME = /^(caddy|nginx|web|frontend|front|app|gateway|proxy|site)$/i;
  const WEB_PORTS = [80, 443, 3000, 8080, 8000, 4173, 5173];

  // Serviço web dentro do namespace de rede de outro (`network_mode:
  // service:X`, visto no projeto cassino): o compose recusa `networks` junto
  // de network_mode, então quem entra na rede do painel é o dono do
  // namespace (X), na porta em que o web escuta.
  const resolveNamespace = (name: string, port: number | null) => {
    const mode = asString(services[name]?.network_mode) ?? "";
    const m = /^service:(.+)$/.exec(mode);
    if (!m || !services[m[1]!]) return { service: name, port };
    const envPort = envEntries(services[name]?.environment).find(([k]) => k === "PORT")?.[1];
    const listen = envPort && /^\d+$/.test(envPort) ? Number(envPort) : port;
    notes.push(
      `Serviço "${name}" usa network_mode: service:${m[1]} — o painel liga o proxy a "${m[1]}" na porta ${listen ?? "?"}. ` +
        `O "${name}" precisa escutar em 0.0.0.0 (não só em 127.0.0.1) para ser alcançado pela rede do painel.`,
    );
    return { service: m[1]!, port: listen };
  };

  // 1) serviço com nome de proxy web (ex.: Caddy próprio do trader). Imagem
  // de proxy (caddy/nginx/traefik) vem ANTES de um nome genérico ("web",
  // "app"): quando o projeto tem proxy próprio, é ele a entrada (validação
  // real: o cassino tem "web" e um Caddy interno que roteia site e carteira).
  const isProxyImage = (n: string) => /^(caddy|nginx|traefik)/i.test(asString(services[n]?.image) ?? "");
  const ordered = [...names.filter(isProxyImage), ...names.filter((n) => !isProxyImage(n))];
  for (const name of ordered) {
    const svc = services[name];
    if (svc && (WEB_NAME.test(name) || isProxyImage(name))) {
      // só a porta do container interessa (upstream na rede Docker); a do host,
      // que pode ser aleatória ou vir de variável, nunca é usada aqui
      const ports = publishedPorts(svc.ports);
      // porta publicada (a interna) → expose → só então o 80 de sempre
      const containerPort =
        ports.find((p) => WEB_PORTS.includes(p.container))?.container ?? ports[0]?.container ?? exposedPort(svc) ?? null;
      notes.push(`Serviço "${name}" identificado como entrada web (nome/imagem de proxy).`);
      if (containerPort === null) notes.push(`Serviço "${name}" não publica nem expõe porta: assumindo a 80 — confira a porta.`);
      return { ...resolveNamespace(name, containerPort ?? 80), notes };
    }
  }

  // 2) serviço que publica porta web
  for (const name of names) {
    const svc = services[name];
    if (!svc) continue;
    const ports = publishedPorts(svc.ports);
    const web = ports.find((p) => WEB_PORTS.includes(p.container));
    if (web) {
      notes.push(`Serviço "${name}" publica a porta web ${web.container}.`);
      return { service: name, port: web.container, notes };
    }
  }

  // 3) fallback: primeiro serviço que declara "expose"
  for (const name of names) {
    const svc = services[name];
    const port = svc ? exposedPort(svc) : null;
    if (port !== null) {
      notes.push(`Serviço "${name}" expõe a porta ${port} (via expose).`);
      return { service: name, port, notes };
    }
  }

  notes.push("Não foi possível inferir o serviço web; configure manualmente.");
  return { service: names[0] ?? null, port: null, notes };
}

/** Serviços do compose que definem "networks" próprias (override do painel pode conflitar). */
export function servicesWithCustomNetworks(content: string): string[] {
  try {
    const doc = parse(content) as ComposeFile;
    return Object.entries(doc.services ?? {})
      .filter(([, svc]) => svc && svc.networks !== undefined)
      .map(([name]) => name);
  } catch {
    return [];
  }
}
