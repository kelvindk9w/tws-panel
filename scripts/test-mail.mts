/**
 * test-mail.mts — testes end-to-end da Fase 3 (E-mail).
 *
 * Sobe a API do painel em portas altas (ambiente isolado em /tmp), provisiona
 * o Stalwart em container de teste e valida:
 *  1. Bootstrap do Stalwart (start/status/versão)
 *  2. Domínio exemplo.invalid → DKIM RSA 2048 no checklist + postmaster@
 *  3. Verificação DNS: domínio .invalid → ❌ missing sem quebrar; PTR →
 *     action_required com texto de chamado; caminho ✅ via resolver mockado
 *  4. Envio SMTP (587 STARTTLS) entre duas caixas + leitura via IMAPS (993)
 *  5. Endpoint de credenciais IMAP/SMTP completo
 *  6. Injeção SMTP: projeto de exemplo da Fase 2 → redeploy → env vars no
 *     container + conectividade SMTP a partir do container
 *  7. Limpeza de containers/volumes de teste
 *
 * Uso: pnpm test:mail
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { buildDnsChecklist, verifyDnsRecords, type DnsResolverLike } from "../packages/mailer/src/index.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API_PORT = 19100;
const TOKEN = "token-teste-fase3";
const DOMAIN = "exemplo.invalid";
// TEST-NET-3 (RFC 5737): IP reservado, sem PTR — torna o teste de PTR determinístico.
const PUBLIC_IP = "203.0.113.10";
// Nota: 10080 está na lista de "bad ports" do fetch (WHATWG) — o undici do Node
// se recusa a conectar. Por isso a API de admin usa 18081 nos testes.
const PORTS = { smtp: 10125, submission: 10587, submissions: 10465, imap: 10143, imaps: 10993, http: 18081 };

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "paas-mail-e2e-"));
let server: ChildProcess | null = null;
let passed = 0;

function step(name: string) {
  console.log(`\n\x1b[36m▶ ${name}\x1b[0m`);
}
function ok(msg: string) {
  passed++;
  console.log(`  \x1b[32m✔ ${msg}\x1b[0m`);
}

async function api<T = unknown>(method: string, pathName: string, body?: unknown): Promise<T> {
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
  if (!res.ok) {
    throw new Error(`API ${method} ${pathName} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json as T;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/mail/status`, {
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

async function waitJob(projectId: string, jobId: string, timeoutMs = 600_000): Promise<{ status: string; log: string; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { job } = await api<{ job: { status: string; log: string; error: string | null } }>(
      "GET",
      `/api/projects/${projectId}/jobs/${jobId}`,
    );
    if (job.status === "success" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("deploy não terminou a tempo");
}

// ---------------------------------------------------------------------------
// Boot da API do painel (ambiente isolado)
// ---------------------------------------------------------------------------

step("0. Subindo API do painel em ambiente isolado");
server = spawn("pnpm", ["--filter", "@paas/server", "exec", "tsx", "src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    SETUP_TOKEN: TOKEN,
    PAAS_DATA_DIR: DATA_DIR,
    PAAS_CADDY_HTTP_PORT: "18080",
    PAAS_CADDY_HTTPS_PORT: "18443",
    PAAS_STALWART_PORT_SMTP: String(PORTS.smtp),
    PAAS_STALWART_PORT_SUBMISSION: String(PORTS.submission),
    PAAS_STALWART_PORT_SUBMISSIONS: String(PORTS.submissions),
    PAAS_STALWART_PORT_IMAP: String(PORTS.imap),
    PAAS_STALWART_PORT_IMAPS: String(PORTS.imaps),
    PAAS_STALWART_PORT_HTTP: String(PORTS.http),
    PAAS_PUBLIC_IP: PUBLIC_IP,
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
await waitForServer();
ok(`API no ar na porta ${API_PORT} (data dir isolado: ${DATA_DIR})`);

try {
  // -------------------------------------------------------------------------
  step("1. Bootstrap do Stalwart em container de teste (portas altas)");
  let startRes: { status: { running: boolean; version: string | null } };
  try {
    startRes = await api<{ status: { running: boolean; version: string | null } }>(
      "POST",
      "/api/mail/server/start",
    );
  } catch (err) {
    const logs = await run("docker", ["logs", "--tail", "30", "paas-stalwart"]).catch(() => null);
    const ps = await run("docker", ["ps", "-a", "--filter", "name=paas-stalwart", "--format", "{{.Status}}"]);
    console.error("docker ps:", ps.stdout, "\nlogs:\n", logs?.stdout, logs?.stderr);
    throw err;
  }
  assert.equal(startRes.status.running, true, "servidor deveria estar rodando");
  ok(`container paas-stalwart rodando, versão ${startRes.status.version ?? "?"}`);

  const status = await api<{ running: boolean; ports: Record<string, number> }>("GET", "/api/mail/status");
  assert.equal(status.running, true);
  assert.equal(status.ports.submission, PORTS.submission);
  ok("GET /api/mail/status consistente");

  // -------------------------------------------------------------------------
  step("2. Domínio de exemplo → DKIM 2048 + postmaster@");
  await api("POST", "/api/mail/domains", { domain: DOMAIN });
  const dns = await api<{
    records: Array<{ id: string; type: string; name: string; expected: string }>;
    mailHostname: string;
    serverIp: string;
  }>("GET", `/api/mail/domains/${DOMAIN}/dns`);

  const dkim = dns.records.find((r) => r.id === "dkim");
  assert.ok(dkim, "checklist deve conter registro DKIM");
  assert.equal(dkim.type, "TXT");
  assert.match(dkim.name, /^paas\._domainkey\./);
  const pMatch = /p=([A-Za-z0-9+/=]+)/.exec(dkim.expected);
  assert.ok(pMatch?.[1], "DKIM deve conter p=");
  // RSA 2048 → chave pública PKCS1 DER ≈ 294 bytes → base64 ≈ 392 chars.
  assert.ok(pMatch[1].length >= 390, `chave p= curta demais para 2048 bits (${pMatch[1].length})`);
  ok(`DKIM RSA 2048 gerado (p= com ${pMatch[1].length} chars) no TXT ${dkim.name}`);

  const spf = dns.records.find((r) => r.id === "spf");
  assert.equal(spf?.expected, `v=spf1 ip4:${PUBLIC_IP} ~all`, "SPF do estágio inicial");
  const dmarc = dns.records.find((r) => r.id === "dmarc");
  assert.match(dmarc?.expected ?? "", /p=none/, "DMARC progressivo começa em p=none");
  assert.ok(dns.records.some((r) => r.id === "a" && r.expected === PUBLIC_IP));
  assert.ok(dns.records.some((r) => r.id === "mx" && r.expected.includes(`mail.${DOMAIN}`)));
  ok("checklist completo: A, MX, SPF (~all), DMARC (p=none)");

  const boxesAfterDomain = await api<{ mailboxes: Array<{ id: string; kind: string }> }>(
    "GET",
    `/api/mail/domains/${DOMAIN}/mailboxes`,
  );
  assert.ok(boxesAfterDomain.mailboxes.some((m) => m.id === `postmaster@${DOMAIN}` && m.kind === "system"));
  ok("caixa postmaster@ (com alias abuse@) provisionada automaticamente");

  // -------------------------------------------------------------------------
  step("3. Verificação DNS (domínio fake → missing; PTR → chamado; mock → found)");
  const verify = await api<{
    summary: { ok: number; total: number };
    records: Array<{ id: string; status: string }>;
    ptr: { status: string; ticketText: string | null };
  }>("POST", `/api/mail/domains/${DOMAIN}/verify`);
  for (const record of verify.records) {
    assert.equal(record.status, "missing", `${record.id} deveria estar missing (.invalid é NXDOMAIN)`);
  }
  assert.equal(verify.ptr.status, "action_required");
  assert.ok(verify.ptr.ticketText?.includes("reverse DNS"), "texto de chamado PTR");
  assert.equal(verify.summary.ok, 0);
  ok(`verify: ${verify.records.length} registros ❌ missing sem quebrar + PTR action_required com texto de chamado`);

  // Caminho ✅ com resolver mockado (domínio real indisponível no ambiente).
  const checklist = buildDnsChecklist({
    domain: DOMAIN,
    mailHostname: `mail.${DOMAIN}`,
    serverIp: PUBLIC_IP,
    dkimSelector: "paas",
    dkimPublicKey: "CHAVEPUBLICA",
    dmarcStage: "none",
  });
  const mockResolver: DnsResolverLike = {
    resolve4: async () => [PUBLIC_IP],
    resolve6: async () => [],
    resolveMx: async () => [{ exchange: `mail.${DOMAIN}.`, priority: 10 }],
    resolveTxt: async (name: string) => {
      if (name.startsWith("paas._domainkey")) return [["v=DKIM1; k=rsa; p=CHAVEPUBLICA"]];
      if (name.startsWith("_dmarc")) return [[`v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`]];
      return [[`v=spf1 ip4:${PUBLIC_IP} ~all`], ["v=spf1 include:outro.com -all"]];
    },
    reverse: async () => [`mail.${DOMAIN}.`],
  };
  const mocked = await verifyDnsRecords(checklist, mockResolver);
  assert.equal(mocked.summary.ok, mocked.summary.total, "mock: tudo deveria ser found");
  ok(`mock resolver: ${mocked.summary.ok}/${mocked.summary.total} ✅ found (inclui PTR)`);

  const badResolver: DnsResolverLike = { ...mockResolver, resolve4: async () => ["198.51.100.99"] };
  const mismatch = await verifyDnsRecords(checklist, badResolver);
  const aRecord = mismatch.records.find((r) => r.id === "a");
  assert.equal(aRecord?.status, "mismatch", "IP divergente deveria ser ⚠️ mismatch");
  ok("mock resolver: IP divergente → ⚠️ mismatch corretamente");

  // -------------------------------------------------------------------------
  step("4. Envio SMTP + recebimento IMAP end-to-end (interno)");
  await api("POST", `/api/mail/domains/${DOMAIN}/mailboxes`, { localPart: "caixa1" });
  const box2 = await api<{ password: string }>("POST", `/api/mail/domains/${DOMAIN}/mailboxes`, {
    localPart: "caixa2",
  });
  const cred1 = await api<{ credentials: { password: string } }>(
    "GET",
    `/api/mail/mailboxes/${encodeURIComponent(`caixa1@${DOMAIN}`)}/credentials`,
  );

  const subject = `fase3-e2e-${Date.now()}`;
  const smtp = nodemailer.createTransport({
    host: "127.0.0.1",
    port: PORTS.submission,
    secure: false,
    auth: { user: `caixa1@${DOMAIN}`, pass: cred1.credentials.password },
    tls: { rejectUnauthorized: false },
  });
  const sent = await smtp.sendMail({
    from: `caixa1@${DOMAIN}`,
    to: `caixa2@${DOMAIN}`,
    subject,
    text: "prova de envio e recebimento end-to-end",
  });
  assert.match(sent.response, /queued|2\.0\.0/i);
  ok(`SMTP (587 STARTTLS, cert autoassinado): mensagem aceita — ${sent.response}`);

  const imap = new ImapFlow({
    host: "127.0.0.1",
    port: PORTS.imaps,
    secure: true,
    auth: { user: `caixa2@${DOMAIN}`, pass: box2.password },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await imap.connect();
  let received: string | null = null;
  const lock = await imap.getMailboxLock("INBOX");
  try {
    for await (const msg of imap.fetch("1:*", { envelope: true })) {
      if (msg.envelope.subject === subject) received = msg.envelope.subject ?? null;
    }
  } finally {
    lock.release();
  }
  await imap.logout();
  assert.equal(received, subject, "mensagem deveria estar na INBOX da caixa2");
  ok(`IMAPS (993): mensagem "${subject}" lida na INBOX de caixa2@${DOMAIN}`);

  // -------------------------------------------------------------------------
  step("5. Endpoint de credenciais (bloco IMAP/SMTP para cliente externo)");
  const creds = await api<{
    credentials: {
      username: string;
      password: string;
      imap: { host: string; port: number; security: string };
      smtp: { host: string; port: number; security: string };
      smtpAlt: { port: number };
      notes: string[];
    };
  }>("GET", `/api/mail/mailboxes/${encodeURIComponent(`caixa1@${DOMAIN}`)}/credentials`);
  assert.equal(creds.credentials.username, `caixa1@${DOMAIN}`);
  assert.equal(creds.credentials.imap.host, `mail.${DOMAIN}`);
  assert.equal(creds.credentials.imap.port, PORTS.imaps);
  assert.equal(creds.credentials.smtp.port, PORTS.submission);
  assert.equal(creds.credentials.smtpAlt.port, PORTS.submissions);
  assert.ok(creds.credentials.password.length >= 16);
  ok(`credenciais completas: IMAP ${creds.credentials.imap.host}:${creds.credentials.imap.port} SSL, SMTP :${creds.credentials.smtp.port} STARTTLS`);

  // -------------------------------------------------------------------------
  step("6. Injeção SMTP em projeto da Fase 2 (compose adotado)");
  const created = await api<{ project: { id: string; slug: string } }>("POST", "/api/projects", {
    name: "App Email E2E",
    ingestMode: "existing",
    source: path.join(ROOT, "examples/compose-app"),
    domain: "app-email-e2e.localhost",
    proxyService: "api",
    proxyPort: 3000,
  });
  const project = created.project;
  await api("POST", `/api/projects/${project.id}/detect`);
  // O exemplo publica o Redis no host PROPOSITALMENTE (ver compose.yml) — o
  // guardrail db-port-exposed (block) deve exigir override explícito.
  {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/projects/${project.id}/deploy`, {
      method: "POST",
      headers: { "x-setup-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409, "deploy sem override deveria ser bloqueado");
    const body = (await res.json()) as { error: string; report: { blockers: number; findings: Array<{ rule: string }> } };
    assert.equal(body.error, "guardrail_blocked");
    assert.ok(body.report.findings.some((f) => f.rule === "db-port-exposed"), "bloqueio pela porta do Redis");
    ok("guardrail bloqueou o deploy sem override (porta do Redis exposta — proposital no exemplo)");
  }
  const dep1 = await api<{ job: { id: string } }>("POST", `/api/projects/${project.id}/deploy`, {
    guardrailOverride: true,
  });
  const job1 = await waitJob(project.id, dep1.job.id);
  assert.equal(job1.status, "success", `primeiro deploy falhou:\n${job1.log.slice(-1500)}`);
  ok("projeto de exemplo (compose-app) deployado");

  const emailCfg = await api<{ email: { enabled: boolean; mailbox: string; env: Record<string, string> } }>(
    "POST",
    `/api/projects/${project.id}/email`,
    { domain: DOMAIN },
  );
  assert.equal(emailCfg.email.enabled, true);
  assert.equal(emailCfg.email.mailbox, `app-email-e2e@${DOMAIN}`);
  assert.equal(emailCfg.email.env.SMTP_PASS, "••••••••••••", "senha mascarada na API");
  assert.equal(emailCfg.email.env.SMTP_HOST, "paas-stalwart");
  ok(`caixa técnica ${emailCfg.email.mailbox} criada; env vars retornadas mascaradas`);

  const dep2 = await api<{ job: { id: string } }>("POST", `/api/projects/${project.id}/deploy`, {
    guardrailOverride: true,
  });
  const job2 = await waitJob(project.id, dep2.job.id);
  assert.equal(job2.status, "success", `redeploy falhou:\n${job2.log.slice(-1500)}`);
  assert.match(job2.log, /Injetando 5 variável\(is\)/, "log deveria mencionar a injeção");
  ok("redeploy com injeção SMTP concluído");

  const containers = await run("docker", [
    "ps",
    "--filter",
    `label=com.docker.compose.project=paas-${project.slug}`,
    "--format",
    "{{.Names}}",
  ]);
  const apiContainer = containers.stdout.split("\n").find((n) => n.includes("-api-"));
  assert.ok(apiContainer, "container da API do projeto não encontrado");
  const envOut = await run("docker", ["exec", apiContainer, "printenv"]);
  const envMap = Object.fromEntries(
    envOut.stdout.split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  assert.equal(envMap.SMTP_HOST, "paas-stalwart");
  assert.equal(envMap.SMTP_PORT, "587");
  assert.equal(envMap.SMTP_USER, `app-email-e2e@${DOMAIN}`);
  assert.equal(envMap.MAIL_FROM, `app-email-e2e@${DOMAIN}`);
  assert.ok((envMap.SMTP_PASS ?? "").length >= 16, "SMTP_PASS real injetada");
  ok("docker exec env: SMTP_HOST/PORT/USER/PASS/MAIL_FROM presentes no container");

  // Conectividade SMTP a partir do container (rede paas-net).
  const probe = await run("docker", [
    "exec",
    apiContainer,
    "node",
    "-e",
    `const s=require("net").connect({host:"paas-stalwart",port:587,timeout:5000});s.on("data",d=>{console.log(d.toString().slice(0,3));process.exit(0)});s.on("timeout",()=>process.exit(2));s.on("error",e=>{console.error(e.message);process.exit(1)});`,
  ]);
  assert.match(probe.stdout, /^220/, `banner SMTP inesperado: ${probe.stdout} ${probe.stderr}`);
  ok("container alcança paas-stalwart:587 na rede paas-net (banner 220)");

  // -------------------------------------------------------------------------
  step("7. Limpeza");
  await api("DELETE", `/api/projects/${project.id}?deleteSource=false`);
  await api("POST", "/api/mail/server/stop");
  ok("projeto removido e servidor parado via API");
} finally {
  server?.kill("SIGTERM");
  // Limpeza de tudo que o teste criou no Docker (nada além disso).
  const cleanup = [
    ["rm", "-f", "paas-stalwart", "paas-caddy"],
    ["volume", "rm", "-f", "paas_stalwart_data", "paas_caddy_data", "paas_caddy_config"],
    ["network", "rm", "paas-net"],
  ];
  for (const args of cleanup) {
    await run("docker", args).catch(() => ({ stdout: "", stderr: "" }));
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log("\n\x1b[36m▶ Containers/volumes de teste removidos.\x1b[0m");
}

console.log(`\n\x1b[32m✔ FASE 3 OK — ${passed} verificações passaram.\x1b[0m`);
