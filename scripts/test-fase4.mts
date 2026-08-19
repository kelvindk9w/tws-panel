/**
 * test-fase4.mts — testes end-to-end da Fase 4 (Guardrails + Monitoramento).
 *
 * Sobe a API do painel em ambiente isolado (/tmp) e valida:
 *  1. Guardrails: compose com TODOS os problemas (DB exposta + cred fraca +
 *     mailhog + privileged + latest) + secret no código → níveis corretos;
 *     deploy bloqueado (409 guardrail_blocked) + alerta + auditoria;
 *     deploy com override passa (202) e gera entrada de auditoria
 *  2. Baseline + diff: cria baseline no container alvo → instala pacote, abre
 *     porta e altera arquivo crítico → scan gera alertas com o diff correto
 *  3. Blacklist: endpoint por DNSBL + resolver mockado (127.0.0.2 = listed,
 *     NXDOMAIN = clean, 127.255.255.x = unknown)
 *  4. Alertas: ciclo open → acknowledged → resolved via API (+ filtros)
 *  5. Scheduler: intervalo configurável, roda sozinho e persiste última execução
 *  6. Auditoria paginada
 *  7. Limpeza completa (containers/rede/dirs de teste)
 *
 * Uso: pnpm test:fase4
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkIpBlacklists, type BlacklistResolverLike } from "../packages/mailer/src/index.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API_PORT = 19200;
const TOKEN = "token-teste-fase4";
const TARGET_CONTAINER = "paas-fase4-target";
// TEST-NET-3 (RFC 5737): IP reservado — blacklist determinística (nunca listado).
const PUBLIC_IP = "203.0.113.10";

const DATA_DIR = await mkdtemp(path.join(tmpdir(), "paas-fase4-e2e-"));
const FIXTURE_DIR = await mkdtemp(path.join(tmpdir(), "paas-fase4-app-"));
let server: ChildProcess | null = null;
let passed = 0;

function step(name: string) {
  console.log(`\n\x1b[36m▶ ${name}\x1b[0m`);
}
function ok(msg: string) {
  passed++;
  console.log(`  \x1b[32m✔ ${msg}\x1b[0m`);
}

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

async function apiRaw<T = unknown>(method: string, pathName: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${pathName}`, {
    method,
    headers: {
      "x-setup-token": TOKEN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, body: json as T };
}

async function api<T = unknown>(method: string, pathName: string, body?: unknown): Promise<T> {
  const { status, body: json } = await apiRaw<T>(method, pathName, body);
  if (status >= 400) {
    throw new Error(`API ${method} ${pathName} → ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/audit`, {
        headers: { "x-setup-token": TOKEN },
      });
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API do painel não subiu a tempo.");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dockerExec(cmd: string): Promise<string> {
  const { stdout } = await run("docker", ["exec", TARGET_CONTAINER, "bash", "-c", cmd], {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// Inventário anterior ao teste — só removemos o que ESTE teste criou.
async function dockerExists(kind: "container" | "network", name: string): Promise<boolean> {
  const args = kind === "container" ? ["inspect", name] : ["network", "inspect", name];
  try {
    await run("docker", args);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fixture: compose com TODOS os problemas + secret no código
// ---------------------------------------------------------------------------

await writeFile(
  path.join(FIXTURE_DIR, "compose.yml"),
  `# Fixture de teste da Fase 4 — propositalmente insegura.
services:
  web:
    image: alpine:3
    command: sleep 600
    ports:
      - "15433:5432"          # db-port-exposed (block)
    environment:
      POSTGRES_USER: cacheta
      POSTGRES_PASSWORD: cacheta   # weak-credentials: usuário == senha (block)
    privileged: true          # privileged-container (block)
  mail:
    image: mailhog/mailhog:latest  # dev-service-in-prod (warn) + latest-tag (info)
`,
);
await writeFile(
  path.join(FIXTURE_DIR, "config.js"),
  `// fixture — chave de exemplo da documentação da AWS (não é um segredo real)\nconst AWS_KEY = "AKIAIOSFODNN7EXAMPLE";\nmodule.exports = { AWS_KEY };\n`,
);

// ---------------------------------------------------------------------------
// Boot da API
// ---------------------------------------------------------------------------

step("0. Subindo API do painel em ambiente isolado");
const caddyExisted = await dockerExists("container", "paas-caddy");
const netExisted = await dockerExists("network", "paas-net");
const targetExisted = await dockerExists("container", TARGET_CONTAINER);

server = spawn("pnpm", ["--filter", "@paas/server", "exec", "tsx", "src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    SETUP_TOKEN: TOKEN,
    PAAS_DATA_DIR: DATA_DIR,
    PAAS_TARGET_CONTAINER: TARGET_CONTAINER,
    PAAS_CADDY_HTTP_PORT: "18280",
    PAAS_CADDY_HTTPS_PORT: "18281",
    PAAS_PUBLIC_IP: PUBLIC_IP,
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
await waitForServer();
ok(`API no ar na porta ${API_PORT} (data dir isolado)`);

let projectId = "";
let projectJobId = "";

try {
  // -------------------------------------------------------------------------
  step("1. Guardrails: compose com todos os problemas → block/warn/info corretos");
  const project = await api<{ project: { id: string; slug: string } }>("POST", "/api/projects", {
    name: "App Inseguro Fase4",
    ingestMode: "existing",
    source: FIXTURE_DIR,
    domain: "fase4-guardrails.localhost",
  });
  projectId = project.project.id;

  const { report } = await api<{ report: {
    findings: Array<{ rule: string; level: string }>;
    blockers: number; warnings: number; infos: number;
  } | null }>("GET", `/api/projects/${projectId}/guardrails`);
  assert.ok(report, "relatório de guardrails deveria existir");
  const byRule = new Map(report.findings.map((f) => [f.rule, f.level]));
  assert.equal(byRule.get("db-port-exposed"), "block", "db-port-exposed deve ser block");
  assert.equal(byRule.get("weak-credentials"), "block", "weak-credentials deve ser block");
  assert.equal(byRule.get("privileged-container"), "block", "privileged-container deve ser block");
  assert.equal(byRule.get("dev-service-in-prod"), "warn", "dev-service-in-prod deve ser warn");
  assert.equal(byRule.get("secret-in-code"), "warn", "secret-in-code deve ser warn");
  assert.equal(byRule.get("latest-tag"), "info", "latest-tag deve ser info");
  assert.ok(report.blockers >= 3, `esperava ≥3 blockers, veio ${report.blockers}`);
  ok(`6 regras detectadas com níveis corretos (${report.blockers} block, ${report.warnings} warn, ${report.infos} info)`);
  const dbFinding = report.findings.find((f) => f.rule === "db-port-exposed");
  assert.ok(dbFinding && "evidence" in dbFinding && "fix" in dbFinding, "finding deve ter evidência + correção");
  ok(`evidência + sugestão de correção presentes (ex.: "${(dbFinding as { evidence: string }).evidence}")`);

  // -------------------------------------------------------------------------
  step("2. Deploy SEM override → bloqueado (409) + alerta + auditoria");
  const blocked = await apiRaw<{ error: string; report?: { blockers: number } }>(
    "POST",
    `/api/projects/${projectId}/deploy`,
    {},
  );
  assert.equal(blocked.status, 409, `deploy sem override deveria retornar 409, veio ${blocked.status}`);
  assert.equal(blocked.body.error, "guardrail_blocked");
  assert.ok((blocked.body.report?.blockers ?? 0) >= 3, "resposta deve incluir o relatório");
  ok("deploy bloqueado com 409 guardrail_blocked + relatório no corpo");

  const alertsAfterBlock = await api<{ alerts: Array<{ source: string; severity: string; title: string }> }>(
    "GET",
    "/api/alerts?source=guardrail",
  );
  assert.ok(
    alertsAfterBlock.alerts.some((a) => a.severity === "critical" && a.title.includes("bloqueado")),
    "deveria existir alerta crítico de guardrail",
  );
  const auditAfterBlock = await api<{ entries: Array<{ action: string }> }>("GET", "/api/audit");
  assert.ok(auditAfterBlock.entries.some((e) => e.action === "deploy.blocked"), "auditoria deve registrar deploy.blocked");
  ok("alerta crítico (guardrail) + auditoria deploy.blocked registrados");

  // -------------------------------------------------------------------------
  step("3. Deploy COM override → 202 + auditoria guardrail.override");
  const started = await apiRaw<{ job: { id: string; status: string } }>(
    "POST",
    `/api/projects/${projectId}/deploy`,
    { guardrailOverride: true },
  );
  assert.equal(started.status, 202, `deploy com override deveria retornar 202, veio ${started.status}`);
  projectJobId = started.body.job.id;
  const auditAfterOverride = await api<{ entries: Array<{ action: string; detail: string }> }>("GET", "/api/audit");
  const overrideEntry = auditAfterOverride.entries.find((e) => e.action === "guardrail.override");
  assert.ok(overrideEntry, "auditoria deve registrar guardrail.override");
  assert.match(overrideEntry.detail, /db-port-exposed/, "override deve detalhar as regras violadas");
  assert.ok(auditAfterOverride.entries.some((e) => e.action === "deploy.start"), "auditoria deve registrar deploy.start");
  ok("deploy aceito com override; auditoria guardrail.override + deploy.start");

  // Aguarda o job terminar (vai FALHAR no health check — os containers da fixture
  // não servem HTTP; o que importa é que o override permitiu o pipeline rodar).
  const deadline = Date.now() + 300_000;
  let jobStatus = "running";
  let jobLog = "";
  while (Date.now() < deadline) {
    const { job } = await api<{ job: { status: string; log: string } }>(
      "GET",
      `/api/projects/${projectId}/jobs/${projectJobId}`,
    );
    jobStatus = job.status;
    jobLog = job.log;
    if (jobStatus === "success" || jobStatus === "failed") break;
    await sleep(3_000);
  }
  assert.match(jobLog, /Guardrails de segurança/, "log do deploy deve mostrar a etapa de guardrails");
  assert.match(jobLog, /Override explícito/, "log deve registrar o override");
  ok(`pipeline rodou até o fim com override (status final: ${jobStatus}; guardrails no log)`);

  // Remove o projeto (limpa containers/compose do teste).
  await api("DELETE", `/api/projects/${projectId}?deleteSource=false`);
  ok("projeto de teste removido (stack compose derrubada)");

  // -------------------------------------------------------------------------
  step("4. Baseline: snapshot do alvo (pacotes, portas, arquivos)");
  const baselineRes = await apiRaw<{ baseline: {
    packages: string[]; ports: Array<{ proto: string; port: number }>; files: Record<string, string | null>;
  } }>("POST", "/api/security/baseline");
  assert.equal(baselineRes.status, 201);
  const baseline = baselineRes.body.baseline;
  assert.ok(baseline.packages.length > 0, "baseline deve listar pacotes");
  assert.ok(Object.keys(baseline.files).includes("/etc/ssh/sshd_config"), "deve rastrear sshd_config");
  ok(`baseline criado: ${baseline.packages.length} pacotes, ${baseline.ports.length} portas, ${Object.keys(baseline.files).length} arquivo(s)`);

  // -------------------------------------------------------------------------
  step("5. Diff: instalar pacote + abrir porta + alterar arquivo → alertas");
  await dockerExec("apt-get update -qq && apt-get install -y -qq --no-install-recommends netcat-openbsd >/dev/null");
  await dockerExec("mkdir -p /etc/ssh && echo '# altered by fase4 test' >> /etc/ssh/sshd_config");
  await run("docker", ["exec", "-d", TARGET_CONTAINER, "bash", "-c", "nc -lk -p 23456 >/dev/null 2>&1"]);
  await sleep(1_000);

  const monitorRun = await api<{ result: {
    alertsCreated: number;
    diff: {
      newPackages: string[];
      newPorts: Array<{ proto: string; port: number }>;
      changedFiles: string[];
      addedFiles: string[];
    } | null;
  } }>("POST", "/api/security/monitor/run");
  const diff = monitorRun.result.diff;
  assert.ok(diff, "diff deveria existir (há baseline)");
  assert.ok(
    diff.newPackages.some((p) => p.startsWith("netcat-openbsd")),
    `diff deveria conter netcat-openbsd: ${diff.newPackages.slice(0, 5).join(", ")}`,
  );
  assert.ok(
    diff.newPorts.some((p) => p.proto === "tcp" && p.port === 23456),
    `diff deveria conter a porta tcp/23456: ${JSON.stringify(diff.newPorts)}`,
  );
  const fileChanges = [...diff.changedFiles, ...diff.addedFiles];
  assert.ok(
    fileChanges.includes("/etc/ssh/sshd_config"),
    `diff deveria conter sshd_config: ${fileChanges.join(", ")}`,
  );
  assert.ok(monitorRun.result.alertsCreated > 0, "scan deveria ter gerado alertas");
  ok(`diff correto: +netcat-openbsd, +tcp/23456, ~sshd_config (${monitorRun.result.alertsCreated} alerta(s))`);

  const scanAlerts = await api<{ alerts: Array<{ source: string; title: string; detail: string }> }>(
    "GET",
    "/api/alerts?source=scan&status=open",
  );
  assert.ok(scanAlerts.alerts.some((a) => a.title.includes("portas")), "alerta de novas portas");
  assert.ok(scanAlerts.alerts.some((a) => a.title.includes("pacotes")), "alerta de pacotes");
  assert.ok(scanAlerts.alerts.some((a) => a.title.includes("arquivos")), "alerta de arquivos críticos");
  ok("alertas de scan por categoria (portas/pacotes/arquivos) abertos");

  // -------------------------------------------------------------------------
  step("6. Blacklist: endpoint + resolver mockado (listed/clean/unknown)");
  // Endpoint real: TEST-NET-3 — Spamhaus ZEN o lista via PBL (espaço reservado
  // não deveria enviar e-mail), então aceitamos qualquer status VÁLIDO; quando
  // listed, o link de remoção é obrigatório.
  const bl = await api<{
    ip: { target: string; results: Array<{ dnsbl: string; status: string; removalUrl: string | null }> } | null;
    domains: unknown[];
    listedCount: number;
  }>("GET", "/api/mail/blacklist");
  assert.ok(bl.ip, "resposta deve incluir o IP");
  assert.equal(bl.ip.target, PUBLIC_IP);
  assert.equal(bl.ip.results.length, 3, "3 DNSBLs de IP");
  for (const r of bl.ip.results) {
    assert.ok(["listed", "clean", "unknown"].includes(r.status), `status válido (${r.dnsbl}: ${r.status})`);
    if (r.status === "listed") {
      assert.ok(r.removalUrl, `${r.dnsbl} listado deve trazer link de remoção`);
    }
  }
  assert.equal(
    bl.listedCount,
    bl.ip.results.filter((r) => r.status === "listed").length,
    "listedCount consistente",
  );
  ok(`endpoint retorna 3 DNSBLs com status válidos (${bl.ip.results.map((r) => r.status).join("/")})`);

  // Mock determinístico: 127.0.0.2 é reservado para teste em várias DNSBLs.
  const listedResolver: BlacklistResolverLike = { resolve4: async () => ["127.0.0.2"] };
  const cleanResolver: BlacklistResolverLike = {
    resolve4: async () => {
      const err = new Error("queryA ENOTFOUND") as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    },
  };
  const refusedResolver: BlacklistResolverLike = { resolve4: async () => ["127.255.255.254"] };
  const mockListed = await checkIpBlacklists("127.0.0.2", listedResolver);
  assert.ok(mockListed.every((r) => r.status === "listed" && r.removalUrl), "mock: 127.0.0.2 → listed com link de remoção");
  const mockClean = await checkIpBlacklists("203.0.113.10", cleanResolver);
  assert.ok(mockClean.every((r) => r.status === "clean"), "mock: NXDOMAIN → clean");
  const mockRefused = await checkIpBlacklists("203.0.113.10", refusedResolver);
  assert.ok(mockRefused.every((r) => r.status === "unknown"), "mock: 127.255.255.x → unknown (nunca listed)");
  ok("resolver mockado: listed (com link de remoção) / clean / unknown");

  // -------------------------------------------------------------------------
  step("7. Alertas: ciclo open → acknowledged → resolved + filtros");
  const openAlerts = await api<{ alerts: Array<{ id: string; status: string }> }>(
    "GET",
    "/api/alerts?status=open",
  );
  assert.ok(openAlerts.alerts.length > 0, "deve haver alertas abertos");
  const target = openAlerts.alerts[0]!;
  const acked = await api<{ alert: { status: string; acknowledgedAt: string | null } }>(
    "POST",
    `/api/alerts/${target.id}/ack`,
  );
  assert.equal(acked.alert.status, "acknowledged");
  assert.ok(acked.alert.acknowledgedAt, "acknowledgedAt preenchido");
  const ackFilter = await api<{ alerts: Array<{ id: string }> }>("GET", "/api/alerts?status=acknowledged");
  assert.ok(ackFilter.alerts.some((a) => a.id === target.id), "filtro acknowledged deve conter o alerta");
  const resolved = await api<{ alert: { status: string; resolvedAt: string | null } }>(
    "POST",
    `/api/alerts/${target.id}/resolve`,
  );
  assert.equal(resolved.alert.status, "resolved");
  assert.ok(resolved.alert.resolvedAt, "resolvedAt preenchido");
  const openAfter = await api<{ alerts: Array<{ id: string }>; openCount: number }>(
    "GET",
    "/api/alerts?status=open",
  );
  assert.ok(!openAfter.alerts.some((a) => a.id === target.id), "alerta resolvido sai dos abertos");
  const notFound = await apiRaw("POST", "/api/alerts/inexistente/ack");
  assert.equal(notFound.status, 404, "alerta inexistente → 404");
  ok("ciclo completo open→ack→resolve + filtros + 404");

  // -------------------------------------------------------------------------
  step("8. Scheduler: intervalo configurável, roda e persiste última execução");
  await api("PUT", "/api/security/monitor/config", { intervalMs: 10_000 });
  const stateBefore = await api<{ schedulerRunning: boolean; lastRunAt: string | null; config: { intervalMs: number } }>(
    "GET",
    "/api/security/monitor/last",
  );
  assert.equal(stateBefore.schedulerRunning, true, "agendador deveria estar ativo");
  assert.equal(stateBefore.config.intervalMs, 10_000);
  const firstRunAt = stateBefore.lastRunAt;
  await sleep(25_000);
  const stateAfter = await api<{ lastRunAt: string | null; lastResult: { id: string } | null }>(
    "GET",
    "/api/security/monitor/last",
  );
  assert.ok(stateAfter.lastRunAt, "lastRunAt deveria existir");
  assert.notEqual(stateAfter.lastRunAt, firstRunAt, "agendador deveria ter rodado de novo sozinho");
  const monitorFile = JSON.parse(
    await readFile(path.join(DATA_DIR, "security", "monitor.json"), "utf8"),
  ) as { intervalMs: number; lastRunAt: string | null; lastResult: unknown };
  assert.equal(monitorFile.intervalMs, 10_000, "intervalo persistido em disco");
  assert.equal(monitorFile.lastRunAt, stateAfter.lastRunAt, "última execução persistida em disco");
  assert.ok(monitorFile.lastResult, "último resultado persistido em disco");
  ok("agendador rodou sozinho (novo lastRunAt) e persistiu config+resultado em data/security/monitor.json");

  // Intervalo inválido → 400
  const badInterval = await apiRaw("PUT", "/api/security/monitor/config", { intervalMs: 1_000 });
  assert.equal(badInterval.status, 400, "intervalo abaixo do mínimo → 400");
  ok("validação de intervalo mínimo (400)");

  // -------------------------------------------------------------------------
  step("9. Auditoria paginada");
  const auditPage = await api<{ entries: unknown[]; total: number; page: number; perPage: number }>(
    "GET",
    "/api/audit?page=1&perPage=2",
  );
  assert.equal(auditPage.entries.length, 2, "perPage=2 deve limitar a página");
  assert.ok(auditPage.total >= 5, `auditoria deveria ter ≥5 entradas, tem ${auditPage.total}`);
  ok(`paginação ok (total=${auditPage.total}, página com ${auditPage.entries.length})`);
} finally {
  // -------------------------------------------------------------------------
  step("10. Limpeza");
  server?.kill("SIGTERM");
  await sleep(500);
  server?.kill("SIGKILL");

  if (projectId) {
    // garante que nada da stack do projeto ficou para trás (slug: app-inseguro-fase4)
    const leftover = await run("docker", [
      "ps", "-aq", "--filter", "label=com.docker.compose.project=paas-app-inseguro-fase4",
    ]).catch(() => null);
    const ids = (leftover?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (ids.length > 0) {
      await run("docker", ["rm", "-f", ...ids]).catch(() => undefined);
    }
  }
  if (!targetExisted) {
    await run("docker", ["rm", "-f", TARGET_CONTAINER]).catch(() => undefined);
  }
  if (!caddyExisted) {
    await run("docker", ["rm", "-f", "paas-caddy"]).catch(() => undefined);
  }
  if (!netExisted) {
    await run("docker", ["network", "rm", "paas-net"]).catch(() => undefined);
  }
  await rm(DATA_DIR, { recursive: true, force: true });
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  // fixture continua no host (modo existing não copia); removida acima
  console.log("  containers/rede/dirs de teste removidos");
}

console.log(`\n\x1b[32m✔ Fase 4: ${passed} verificações passaram\x1b[0m`);
process.exit(0);
