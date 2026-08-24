/**
 * rules.ts — sistema completo de guardrails de deploy (Fase 4, plano §5.4).
 *
 * Regras com 3 níveis:
 *  - block: impede o deploy sem override explícito (registrado em auditoria);
 *  - warn:  alerta, permite o deploy;
 *  - info:  informativo.
 *
 * Motivadas pelos problemas REAIS dos projetos do usuário
 * (docs/projects-analysis.md — cachetaGrok): porta de banco exposta,
 * credenciais triviais (cacheta:cacheta), Mailhog em produção.
 *
 * Regras:
 *  - db-port-exposed      (block) porta de banco publicada no host
 *  - weak-credentials     (block) credenciais triviais no compose/env
 *  - privileged-container (block) privileged: true ou docker.sock montado
 *  - dev-service-in-prod  (warn)  mailhog/phpmyadmin/adminer/debug tools
 *  - secret-in-code       (warn)  padrões de secrets no diretório fonte
 *  - latest-tag           (info)  imagens com tag :latest
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GuardrailFinding, GuardrailLevel, GuardrailReport } from "@paas/core";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Constantes das regras
// ---------------------------------------------------------------------------

/** Portas de container conhecidas de bancos de dados. */
const DATABASE_PORTS = new Map<number, string>([
  [5432, "PostgreSQL"],
  [3306, "MySQL/MariaDB"],
  [6379, "Redis"],
  [27017, "MongoDB"],
  [1433, "SQL Server"],
]);

/** Imagens de serviços típicos de desenvolvimento/depuração. */
const DEV_IMAGES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /mailhog/i, name: "Mailhog" },
  { pattern: /mailpit/i, name: "Mailpit" },
  { pattern: /phpmyadmin/i, name: "phpMyAdmin" },
  { pattern: /adminer/i, name: "Adminer" },
  { pattern: /pgadmin/i, name: "pgAdmin" },
  { pattern: /mongodb-compass/i, name: "MongoDB Compass" },
  { pattern: /redisinsight/i, name: "RedisInsight" },
  { pattern: /selenium/i, name: "Selenium" },
  { pattern: /debug/i, name: "ferramenta de debug" },
];

/** Chaves de ambiente que carregam credenciais. */
const SECRET_KEY_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)/i;
const USER_KEY_PATTERN = /(USER|USERNAME|LOGIN)$/i;

/**
 * Valores notoriamente fracos (minúsculos para comparação) — ~20 padrões,
 * incluindo os pares triviais de bancos (postgres/mysql/redis/mongo).
 */
const WEAK_VALUES = new Set([
  "password",
  "passwd",
  "passw0rd",
  "secret",
  "changeme",
  "change-me",
  "admin",
  "root",
  "1234",
  "12345",
  "123456",
  "1234567",
  "12345678",
  "qwerty",
  "letmein",
  "iloveyou",
  "postgres",
  "mysql",
  "redis",
  "mongo",
  "mongodb",
  "cacheta",
  "dev",
  "test",
]);

/** Candidatos de arquivo compose (mesma prioridade da detecção). */
const COMPOSE_CANDIDATES = [
  "compose.prod.yml",
  "compose.prod.yaml",
  "compose.production.yml",
  "docker-compose.prod.yml",
  "docker-compose.prod.yaml",
  "docker-compose.production.yml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

// ---------------------------------------------------------------------------
// Scan de secrets no código-fonte (regexes conservadoras)
// ---------------------------------------------------------------------------

/** Diretórios ignorados no scan de secrets. */
const SECRET_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
]);

/** Extensões de texto inspecionadas pelo scan de secrets. */
const SECRET_SCAN_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".yml", ".yaml", ".env", ".ini", ".conf", ".cfg", ".toml",
  ".py", ".php", ".rb", ".go", ".sh", ".bash", ".sql", ".txt",
]);

const SECRET_SCAN_MAX_FILE_BYTES = 512 * 1024;
const SECRET_SCAN_MAX_FILES = 2_000;

interface SecretPattern {
  id: string;
  pattern: RegExp;
  description: string;
}

/**
 * Padrões conservadores de secrets comitados. Cada um tem formato inconfundível
 * para evitar falsos positivos (documentação, hashes, placeholders).
 */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    description: "chave de acesso AWS (AKIA/ASIA…)",
  },
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    description: "chave privada em PEM",
  },
  {
    id: "github-token",
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    description: "token do GitHub (ghp_*/github_pat_*)",
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    description: "token do Slack (xox*-*)",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    description: "chave de API do Google (AIza…)",
  },
  {
    id: "stripe-key",
    pattern: /\b(sk|pk)_(live|test)_[0-9A-Za-z]{24,}\b/,
    description: "chave do Stripe (sk_live_*/pk_live_*)",
  },
];

/**
 * Tokens genéricos de alta entropia atribuídos a variáveis suspeitas:
 * `QUALQUER_SECRET|TOKEN|KEY = "valor"` com ≥ 20 chars de charset denso.
 * Placeholders óbvios são descartados para não poluir o relatório.
 */
const GENERIC_SECRET_ASSIGNMENT =
  /\b[A-Za-z_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD)[A-Za-z_]*\s*[:=]\s*["']([A-Za-z0-9+/=_-]{20,})["']/;

const PLACEHOLDER_HINTS = /example|sample|placeholder|changeme|change-me|your[_-]|xxxx|\.\.\.|dummy|fake|redacted|<[a-z-]+>/i;

/** Entropia aproximada por charset: exige mistura de classes de caracteres. */
function looksHighEntropy(value: string): boolean {
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[+/=_-]/.test(value));
  if (classes < 3) return false;
  // repetição excessiva indica placeholder ("abcabcabc…")
  if (/^(.{1,4})\1{3,}$/.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parse do compose (formas curta/longa)
// ---------------------------------------------------------------------------

interface ComposeService {
  image?: string;
  ports?: unknown;
  environment?: unknown;
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

/** Extrai pares hostPort->containerPort das formas curta/longa do compose. */
function publishedPorts(ports: unknown): Array<{ host: number; container: number }> {
  if (!Array.isArray(ports)) return [];
  const result: Array<{ host: number; container: number }> = [];
  for (const entry of ports) {
    if (typeof entry === "string" || typeof entry === "number") {
      const str = String(entry);
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
  // par "usuario:senha" iguais em um único valor (ex.: "cacheta:cacheta")
  if (v.includes(":")) {
    const [user, pass] = v.split(":", 2);
    if (user && pass && user === pass) return true;
  }
  return v.length > 0 && v.length < 6;
}

/**
 * Volume que monta o socket do Docker (acesso total ao host).
 * Exportada para guardrails.ts (preview do wizard/detecção) reutilizar a
 * MESMA lógica da regra "privileged-container" que bloqueia o deploy, em vez
 * de duplicá-la — ver comentário em analyzeCompose (guardrails.ts).
 */
export function mountsDockerSock(volumes: unknown): boolean {
  if (!Array.isArray(volumes)) return false;
  return volumes.some((entry) => {
    if (typeof entry === "string") return entry.includes("/var/run/docker.sock");
    if (entry && typeof entry === "object") {
      const source = String((entry as { source?: unknown }).source ?? "");
      return source.includes("/var/run/docker.sock");
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Regras sobre o compose
// ---------------------------------------------------------------------------

function analyzeComposeRules(content: string, fileName: string): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  const doc = parse(content) as ComposeFile;
  const services = doc.services ?? {};

  for (const [name, service] of Object.entries(services)) {
    // db-port-exposed (block)
    for (const { host, container } of publishedPorts(service.ports)) {
      const db = DATABASE_PORTS.get(container);
      if (db) {
        findings.push({
          rule: "db-port-exposed",
          level: "block",
          title: `Porta de banco de dados publicada no host (${db})`,
          evidence: `${fileName}: serviço "${name}" publica ${host}:${container}`,
          fix: "Remova a entrada de `ports` do serviço de banco — em produção ele deve ser acessível apenas pela rede interna do Docker. Se precisar de acesso pontual, use túnel SSH.",
          service: name,
        });
      }
    }

    const image = asString(service.image) ?? "";

    // dev-service-in-prod (warn)
    for (const { pattern, name: devName } of DEV_IMAGES) {
      if (pattern.test(image)) {
        findings.push({
          rule: "dev-service-in-prod",
          level: "warn",
          title: `Serviço de desenvolvimento no deploy (${devName})`,
          evidence: `${fileName}: serviço "${name}" usa a imagem "${image}"`,
          fix: `Remova ${devName} do compose de produção (mantenha-o apenas no compose de desenvolvimento).`,
          service: name,
        });
      }
    }

    // latest-tag (info)
    if (image && !image.includes("@") && (image.endsWith(":latest") || !image.includes(":"))) {
      findings.push({
        rule: "latest-tag",
        level: "info",
        title: "Imagem sem versão fixada (tag :latest)",
        evidence: `${fileName}: serviço "${name}" usa "${image.endsWith(":") ? image : image.includes(":") ? image : `${image}:latest`}"`,
        fix: "Fixe uma versão específica da imagem (ex.: redis:7.2-alpine) para deploys reproduzíveis.",
        service: name,
      });
    }

    // privileged-container (block)
    if (service.privileged === true) {
      findings.push({
        rule: "privileged-container",
        level: "block",
        title: "Container privilegiado",
        evidence: `${fileName}: serviço "${name}" define privileged: true`,
        fix: "Remova `privileged: true` — equivale a root no host. Se o serviço precisa de uma capability específica, use `cap_add` com o mínimo necessário.",
        service: name,
      });
    }
    if (mountsDockerSock(service.volumes)) {
      findings.push({
        rule: "privileged-container",
        level: "block",
        title: "Socket do Docker montado no container",
        evidence: `${fileName}: serviço "${name}" monta /var/run/docker.sock`,
        fix: "Evite montar o docker.sock — dá controle total sobre o host. Se indispensável, monte read-only (:ro) e restrinja o serviço.",
        service: name,
      });
    }

    // weak-credentials (block)
    const env = envEntries(service.environment);
    for (const [key, value] of env) {
      if (SECRET_KEY_PATTERN.test(key) && isWeakSecret(value)) {
        findings.push({
          rule: "weak-credentials",
          level: "block",
          title: `Credencial fraca ou trivial em ${key}`,
          evidence: `${fileName}: serviço "${name}" define ${key} com valor fraco/previsível`,
          fix: "Gere uma credencial forte (ex.: openssl rand -hex 24) e gerencie-a fora do compose commitado (env do painel ou arquivo .env não versionado).",
          service: name,
        });
      }
    }
    // par usuário == senha em variáveis separadas (ex.: POSTGRES_USER == POSTGRES_PASSWORD)
    const users = env.filter(([k, v]) => USER_KEY_PATTERN.test(k) && v);
    const passwords = env.filter(([k, v]) => SECRET_KEY_PATTERN.test(k) && v);
    for (const [userKey, userValue] of users) {
      for (const [passKey, passValue] of passwords) {
        if (userValue && passValue && userValue.trim().toLowerCase() === passValue.trim().toLowerCase()) {
          findings.push({
            rule: "weak-credentials",
            level: "block",
            title: "Usuário e senha idênticos",
            evidence: `${fileName}: serviço "${name}" usa o mesmo valor em ${userKey} e ${passKey}`,
            fix: "Usuário e senha iguais são o primeiro alvo de bots. Gere uma senha forte independente do usuário.",
            service: name,
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Regra secret-in-code (scan do diretório fonte)
// ---------------------------------------------------------------------------

async function scanSecrets(dir: string): Promise<GuardrailFinding[]> {
  const findings: GuardrailFinding[] = [];
  const seen = new Set<string>(); // dedup por (padrão + arquivo)
  let scanned = 0;

  async function walk(current: string, rel: string): Promise<void> {
    if (scanned >= SECRET_SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= SECRET_SCAN_MAX_FILES) return;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SECRET_SCAN_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".git")) {
          await walk(full, entryRel);
        }
      } else if (entry.isFile()) {
        const ext = entry.name === ".env" || entry.name.startsWith(".env.")
          ? ".env"
          : path.extname(entry.name).toLowerCase();
        if (!SECRET_SCAN_EXTENSIONS.has(ext)) continue;
        try {
          const info = await stat(full);
          if (info.size > SECRET_SCAN_MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        scanned += 1;
        let content: string;
        try {
          content = await readFile(full, "utf8");
        } catch {
          continue;
        }
        inspectFile(entryRel, content);
      }
    }
  }

  function report(id: string, file: string, line: number, description: string): void {
    const key = `${id}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule: "secret-in-code",
      level: "warn",
      title: `Possível secret comitado (${description})`,
      evidence: `${file}:${line}`,
      fix: "Remova o segredo do código e rotacione a credencial imediatamente — considere-a comprometida. Injete via variável de ambiente/secret do painel.",
    });
  }

  function inspectFile(file: string, content: string): void {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const { id, pattern, description } of SECRET_PATTERNS) {
        if (pattern.test(line)) report(id, file, i + 1, description);
      }
      const generic = GENERIC_SECRET_ASSIGNMENT.exec(line);
      if (generic?.[1] && looksHighEntropy(generic[1]) && !PLACEHOLDER_HINTS.test(generic[1])) {
        report("generic-high-entropy", file, i + 1, "token de alta entropia em variável suspeita");
      }
    }
  }

  await walk(dir, "");
  return findings;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface GuardrailRuleInfo {
  rule: string;
  level: GuardrailLevel;
  title: string;
}

/** Catálogo das regras (documentação/testes). */
export const GUARDRAIL_RULES: readonly GuardrailRuleInfo[] = [
  { rule: "db-port-exposed", level: "block", title: "Porta de banco de dados publicada no host" },
  { rule: "weak-credentials", level: "block", title: "Credenciais triviais no compose/env" },
  { rule: "privileged-container", level: "block", title: "Container privilegiado ou docker.sock montado" },
  { rule: "dev-service-in-prod", level: "warn", title: "Serviço de desenvolvimento em produção" },
  { rule: "secret-in-code", level: "warn", title: "Possível secret comitado no código" },
  { rule: "latest-tag", level: "info", title: "Imagem com tag :latest" },
];

function summarize(findings: GuardrailFinding[]): { blockers: number; warnings: number; infos: number } {
  let blockers = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.level === "block") blockers += 1;
    else if (f.level === "warn") warnings += 1;
    else infos += 1;
  }
  return { blockers, warnings, infos };
}

/**
 * Executa todos os guardrails sobre um diretório de código-fonte.
 * Tolerante: compose inválido vira finding "block" (YAML quebrado não deve deployar).
 */
export async function runGuardrails(dir: string): Promise<GuardrailReport> {
  const findings: GuardrailFinding[] = [];

  // Compose (regras de infra)
  let composeFile: string | null = null;
  for (const candidate of COMPOSE_CANDIDATES) {
    try {
      await readFile(path.join(dir, candidate));
      composeFile = candidate;
      break;
    } catch {
      // próximo candidato
    }
  }
  if (composeFile) {
    const content = await readFile(path.join(dir, composeFile), "utf8");
    try {
      findings.push(...analyzeComposeRules(content, composeFile));
    } catch {
      findings.push({
        rule: "invalid-compose",
        level: "block",
        title: "Arquivo compose inválido",
        evidence: `${composeFile}: não foi possível interpretar como YAML válido`,
        fix: "Corrija a sintaxe do arquivo compose antes de deployar.",
      });
    }
  }

  // Secrets no código-fonte
  findings.push(...(await scanSecrets(dir)));

  // Ordena por severidade (block → warn → info) para a UI.
  const order: Record<GuardrailLevel, number> = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  return {
    ranAt: new Date().toISOString(),
    dir,
    findings,
    ...summarize(findings),
  };
}
