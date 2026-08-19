/**
 * guardrails.ts — análise de segurança de arquivos docker-compose ao adotá-los.
 *
 * Prévia da Fase 4 (plano §5.4): motivada pelos problemas REAIS encontrados nos
 * projetos do usuário (docs/projects-analysis.md — cachetaGrok):
 *  - porta de banco de dados publicada no host (5432 exposta);
 *  - credenciais fracas/hardcoded (cacheta:cacheta);
 *  - serviços de dev em produção (Mailhog na 8025).
 */
import { parse } from "yaml";
import type { GuardrailWarning } from "@paas/core";

/** Portas de container conhecidas de bancos de dados. */
const DATABASE_PORTS = new Map<number, string>([
  [5432, "PostgreSQL"],
  [3306, "MySQL/MariaDB"],
  [6379, "Redis"],
  [27017, "MongoDB"],
  [1521, "Oracle"],
  [1433, "SQL Server"],
  [5984, "CouchDB"],
  [9200, "Elasticsearch"],
]);

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
  [key: string]: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Extrai pares hostPort->containerPort das formas curta/longa do compose. */
function publishedPorts(ports: unknown): Array<{ host: number; container: number }> {
  if (!Array.isArray(ports)) return [];
  const result: Array<{ host: number; container: number }> = [];
  for (const entry of ports) {
    if (typeof entry === "string" || typeof entry === "number") {
      const str = String(entry);
      // formas: "8080:80", "127.0.0.1:8080:80", "8080:80/tcp"
      const parts = str.replace(/\/(tcp|udp)$/i, "").split(":");
      if (parts.length >= 2) {
        const host = Number(parts[parts.length - 2]);
        const container = Number(parts[parts.length - 1]);
        if (Number.isInteger(host) && Number.isInteger(container)) {
          result.push({ host, container });
        }
      }
    } else if (entry && typeof entry === "object") {
      const e = entry as { published?: unknown; target?: unknown };
      const host = Number(e.published);
      const container = Number(e.target);
      if (Number.isInteger(host) && Number.isInteger(container)) {
        result.push({ host, container });
      }
    }
  }
  return result;
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
export function analyzeCompose(content: string, fileName: string): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const doc = parse(content) as ComposeFile;
  const services = doc.services ?? {};

  for (const [name, service] of Object.entries(services)) {
    // 1) porta de banco publicada no host
    for (const { host, container } of publishedPorts(service.ports)) {
      const db = DATABASE_PORTS.get(container);
      if (db) {
        warnings.push({
          id: "compose.db-port-exposed",
          severity: "critical",
          service: name,
          message: `Serviço "${name}" publica a porta ${host} do host para a porta ${container} do ${db}. Em produção, bancos não devem ser acessíveis de fora da rede Docker.`,
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
    for (const [key, value] of envEntries(service.environment)) {
      if (SECRET_KEY_PATTERN.test(key) && isWeakSecret(value)) {
        warnings.push({
          id: "compose.weak-credentials",
          severity: "warning",
          service: name,
          message: `Serviço "${name}" define ${key} com valor fraco ou previsível. Gere uma credencial forte e gerencie como secret.`,
        });
      }
    }
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

  // 1) serviço com nome de proxy web (ex.: Caddy próprio do trader)
  for (const name of names) {
    const svc = services[name];
    if (svc && (WEB_NAME.test(name) || /^(caddy|nginx|traefik)/i.test(asString(svc.image) ?? ""))) {
      const ports = publishedPorts(svc.ports);
      const containerPort = ports.find((p) => WEB_PORTS.includes(p.container))?.container ?? ports[0]?.container ?? null;
      notes.push(`Serviço "${name}" identificado como entrada web (nome/imagem de proxy).`);
      return { service: name, port: containerPort ?? 80, notes };
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
    const expose = svc?.expose;
    if (Array.isArray(expose) && expose.length > 0) {
      const port = Number(String(expose[0]).replace(/\/(tcp|udp)$/i, ""));
      if (Number.isInteger(port)) {
        notes.push(`Serviço "${name}" expõe a porta ${port} (via expose).`);
        return { service: name, port, notes };
      }
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
