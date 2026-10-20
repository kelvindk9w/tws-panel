// Gera os prints do README com a API simulada (dados fictícios).
// Uso: node capturar.mjs <pasta-de-saida> [base-url]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "./out";
const BASE = process.argv[3] ?? "http://localhost:5199";
mkdirSync(OUT, { recursive: true });

const IP = "203.0.113.10";
const AUTO = "203-0-113-10.sslip.io";
const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();
const ahead = (min) => new Date(now + min * 60_000).toISOString();

// ---------------------------------------------------------------- projetos
const detectionCompose = {
  type: "compose", composeFile: "docker-compose.yml", outputDir: null, packageManager: null, buildCommand: null,
  proxyService: "app", proxyPort: 3000, warnings: [], details: ["docker-compose.yml adotado sem reescrever."],
  services: [
    { name: "app", image: null, build: { context: ".", dockerfile: "Dockerfile" }, publishedPorts: [], internalPorts: [{ port: 3000, source: "expose" }], networkMode: null, dependsOn: [{ service: "db", condition: "service_healthy" }], healthcheck: null, profiles: [] },
    { name: "db", image: "postgres:16-alpine", build: null, publishedPorts: [], internalPorts: [{ port: 5432, source: "dockerfile" }], networkMode: null, dependsOn: [], healthcheck: "compose", profiles: [] },
  ],
};
function project(id, name, slug, domain, extra = {}) {
  return {
    id, name, slug, ingestMode: "git", source: `https://github.com/exemplo/${slug}`, branch: "main", domain,
    aliases: [], websocket: false, detection: detectionCompose, proxyService: null, proxyPort: null,
    createdAt: ago(60 * 24 * 12), updatedAt: ago(60 * 5), lastDeployAt: ago(42), lastDeployStatus: "success",
    deployedBranch: "main", deployedSource: `https://github.com/exemplo/${slug}`, ...extra,
  };
}
function container(slug, service, image, extra = {}) {
  return {
    id: `${slug}-${service}`.padEnd(12, "0"), name: `paas-${slug}-${service}-1`, image, state: "running",
    status: "Up 42 minutes (healthy)", managed: true, projectSlug: slug, composeProject: `paas-${slug}`,
    service, health: "healthy", ports: [], ...extra,
  };
}
const LOJA = project("p1", "Loja", "loja", "loja.exemplo.com.br", { aliases: [`loja.${AUTO}`] });
const LOJA_CONTAINERS = [container("loja", "app", "paas-loja-app:latest"), container("loja", "db", "postgres:16-alpine")];
const SITE = project("p2", "Site institucional", "site", "exemplo.com.br", {
  detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
});
const SITE_CONTAINERS = [container("site", "web", "caddy:2-alpine", { composeProject: null, service: null, health: null, status: "Up 3 days" })];
const BLOG = project("p3", "Blog", "blog", "blog.exemplo.com.br", { ingestMode: "git", lastDeployAt: ago(60 * 26) });
const BLOG_CONTAINERS = [container("blog", "app", "ghost:5-alpine", { health: null, status: "Up 26 hours" })];
const cred = { configured: false, hint: null, username: null, updatedAt: null };
const PROJECTS = [
  { project: LOJA, status: "running", containers: LOJA_CONTAINERS, url: "https://loja.exemplo.com.br", credential: cred },
  { project: SITE, status: "running", containers: SITE_CONTAINERS, url: "https://exemplo.com.br", credential: cred },
  { project: BLOG, status: "running", containers: BLOG_CONTAINERS, url: "https://blog.exemplo.com.br", credential: cred },
];
const ALL_CONTAINERS = [
  ...LOJA_CONTAINERS, ...SITE_CONTAINERS, ...BLOG_CONTAINERS,
  { id: "caddy0000000", name: "paas-caddy", image: "caddy:2", state: "running", status: "Up 3 days", managed: true, projectSlug: null, composeProject: null, service: null, health: null, ports: ["0.0.0.0:80->80/tcp", "0.0.0.0:443->443/tcp"] },
  { id: "stalwart0000", name: "paas-stalwart", image: "stalwartlabs/mail-server:v0.11.8", state: "running", status: "Up 3 days", managed: true, projectSlug: null, composeProject: null, service: null, health: null, ports: [] },
];
const JOBS = [
  { id: "j3", projectId: "p1", status: "success", createdAt: ago(43), startedAt: ago(43), finishedAt: ago(42), steps: [{ name: "clone", status: "done" }, { name: "build", status: "done" }, { name: "up", status: "done" }, { name: "health", status: "done" }], log: "", error: null },
  { id: "j2", projectId: "p1", status: "success", createdAt: ago(60 * 26), startedAt: ago(60 * 26), finishedAt: ago(60 * 26 - 2), steps: [], log: "", error: null },
];

// ---------------------------------------------------------------- roteiro
const ONBOARDING = {
  steps: [
    { id: "hardening", status: "done", optional: false, detail: "8 de 8 fases resolvidas · nota do Lynis 81" },
    { id: "two-factor", status: "done", optional: false, detail: "Ligada na sua conta." },
    { id: "panel-domain", status: "in_progress", optional: false, detail: "DNS conferido; falta o certificado de painel.exemplo.com.br." },
    { id: "email", status: "done", optional: true, detail: "Ligado · envio.exemplo.com.br com o DNS certo." },
    { id: "notifications", status: "pending", optional: true, detail: "Nenhum canal conectado." },
    { id: "backups", status: "pending", optional: true, detail: "Armazenamento externo ainda não conectado." },
  ],
  started: false, complete: false, hidden: false, projectsDir: "/opt/tws-projects",
};

// ---------------------------------------------------------------- e-mail
const MAIL_DOMAIN = "envio.exemplo.com.br";
const MAILHOST = `mail.${MAIL_DOMAIN}`;
const rec = (id, type, name, expected, purpose) => ({ id, type, name, expected, purpose, status: "found", found: [expected], note: null });
const DKIM = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3mPq8Tz1exemploFicticio0aZ9bQ7rL2vN4kW8sY1fH6jD3uE5tG0cR";
const CHECKLIST = {
  domain: MAIL_DOMAIN, mailHostname: MAILHOST, serverIp: IP,
  records: [
    rec("a", "A", MAILHOST, IP, "Aponta o nome do servidor de e-mail para o IP da VPS."),
    rec("mx", "MX", MAIL_DOMAIN, `10 ${MAILHOST}`, "Diz para onde vão os e-mails enviados a este domínio."),
    rec("spf", "TXT", MAIL_DOMAIN, `v=spf1 ip4:${IP} -all`, "Autoriza só esta VPS a enviar em nome do domínio."),
    rec("dkim", "TXT", `rsa._domainkey.${MAIL_DOMAIN}`, DKIM, "Assinatura digital que prova que a mensagem saiu daqui."),
    rec("dmarc", "TXT", `_dmarc.${MAIL_DOMAIN}`, `v=DMARC1; p=quarantine; rua=mailto:dmarc@${MAIL_DOMAIN}`, "Diz o que fazer com mensagens que falham no SPF/DKIM."),
  ],
  ptr: { ip: IP, expected: MAILHOST, status: "found", found: [MAILHOST], forwardConfirmed: true, provider: null, ticketText: null },
  suggestion: "Quando os relatórios estiverem limpos, evolua o DMARC para p=reject.",
};
const VERIFY = { ...CHECKLIST, verifiedAt: new Date(now).toISOString(), summary: { ok: 6, total: 6 } };
const MAILBOXES = {
  mailboxes: [
    { id: `contato@${MAIL_DOMAIN}`, localPart: "contato", domain: MAIL_DOMAIN, kind: "user", createdAt: ago(60 * 24 * 5) },
    { id: `loja@${MAIL_DOMAIN}`, localPart: "loja", domain: MAIL_DOMAIN, kind: "project", createdAt: ago(60 * 24 * 4), projectId: "p1" },
    { id: `postmaster@${MAIL_DOMAIN}`, localPart: "postmaster", domain: MAIL_DOMAIN, kind: "system", createdAt: ago(60 * 24 * 6) },
  ],
};
const WEBMAIL = {
  enabled: true, installed: true, running: true, image: "roundcube/roundcubemail:1.7.4-apache", containerName: "paas-webmail",
  mailServerRunning: true, tlsVerified: true,
  links: [{ domain: MAIL_DOMAIN, host: MAILHOST, url: `https://${MAILHOST}/` }], blockedIps: 0, message: null,
};

// ---------------------------------------------------------------- backups
function target(id, kind, name, partial = {}) {
  return {
    id, kind, name, folder: id, enabled: true, frequencyHours: 24, localKeep: 2, remoteKeep: 5,
    lastBackup: null, lastSuccessAt: ago(60 * 9), lastRemoteVerifiedAt: ago(60 * 9 - 2), nextRunAt: ahead(60 * 15), available: true, ...partial,
  };
}
function brec(id, targetId, targetName, minAgo, sizeBytes, partial = {}) {
  return {
    id, target: targetId, targetName, operation: "backup", trigger: "schedule", status: "success",
    queuedAt: ago(minAgo), startedAt: ago(minAgo), finishedAt: ago(minAgo - 1),
    fileName: "2026-10-15_03-00.7z", sizeBytes, local: true, remote: "verified", remoteEncrypted: true,
    remoteDetail: null, steps: [], warnings: [], error: null, ...partial,
  };
}
const H1 = brec("b1", "panel", "Painel", 60 * 9, 1_830_000);
const H2 = brec("b2", "email", "E-mail", 60 * 9 - 3, 24_600_000);
const H3 = brec("b3", "project:p1", "Loja", 60 * 9 - 6, 58_400_000);
const BACKUPS = {
  destination: {
    type: "s3", provider: "r2", endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com", region: "auto",
    bucket: "tws-backups", accessKeyHint: "…7f3a", connectedAt: ago(60 * 24 * 3), testedAt: ago(60 * 24 * 3),
  },
  encryption: { enabled: true, passwordSet: true, passwordSetAt: ago(60 * 24 * 3), acknowledgedAt: ago(60 * 24 * 3), lastTestAt: ago(60 * 24), lastTestOk: true },
  targets: [
    target("panel", "panel", "Painel", { lastBackup: H1 }),
    target("email", "email", "E-mail", { lastBackup: H2 }),
    target("project:p1", "project", "Loja", { lastBackup: H3, folder: "loja" }),
    target("project:p3", "project", "Blog", { lastBackup: brec("b4", "project:p3", "Blog", 60 * 9 - 8, 12_100_000), folder: "blog" }),
  ],
  running: null, queued: [], history: [H3, H2, H1],
  timezone: "UTC-03:00", backupHour: 3, archiverAvailable: true,
  localPath: "/var/lib/docker/volumes/paas_data/_data/backups",
};

// ---------------------------------------------------------------- roteador
const ME = { user: { id: "u1", username: "admin", createdAt: ago(60 * 24 * 14) }, session: { expiresAt: ahead(60 * 12) }, preferences: { navLayout: "top" } };
const unknown = new Set();
function handle(method, path, search) {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/auth/me": return ME;
    case "GET /api/auth/2fa": return { enabled: true, recoveryCodesLeft: 10 };
    case "GET /api/alerts": return { alerts: [], total: 0, openCount: 0, page: 1, perPage: 1 };
    case "GET /api/onboarding": return ONBOARDING;
    case "GET /api/projects": return { projects: PROJECTS };
    case "GET /api/docker/containers": return { containers: ALL_CONTAINERS };
    case "GET /api/projects/p1": return PROJECTS[0];
    case "GET /api/projects/p1/jobs": return { jobs: JOBS };
    case "GET /api/projects/p1/https": return { domains: [
      { domain: "loja.exemplo.com.br", ok: true, issuer: "Let's Encrypt", validTo: ahead(60 * 24 * 71), error: null },
      { domain: `loja.${AUTO}`, ok: true, issuer: "Let's Encrypt", validTo: ahead(60 * 24 * 64), error: null },
    ] };
    case "GET /api/projects/p1/repo-visibility": return { visibility: "public" };
    case "GET /api/projects/p1/env": return { vars: [] };
    case "GET /api/projects/p1/email": return { email: {
      enabled: true, domain: MAIL_DOMAIN, mailbox: `loja@${MAIL_DOMAIN}`, mailFrom: `loja@${MAIL_DOMAIN}`, fromName: "Loja Exemplo",
      env: { SMTP_HOST: MAILHOST, SMTP_PORT: "587", SMTP_USER: `loja@${MAIL_DOMAIN}`, SMTP_PASS: "••••••••", MAIL_FROM: `loja@${MAIL_DOMAIN}`, MAIL_FROM_NAME: "Loja Exemplo" },
      envLinks: {},
    } };
    case `GET /api/mail/domains/${MAIL_DOMAIN}/dns`: return CHECKLIST;
    case `POST /api/mail/domains/${MAIL_DOMAIN}/verify`: return VERIFY;
    case `GET /api/mail/domains/${MAIL_DOMAIN}/mailboxes`: return MAILBOXES;
    case "GET /api/mail/webmail": return WEBMAIL;
    case "GET /api/backups": return BACKUPS;
  }
  if (path.startsWith("/api/domains/suggest")) return { auto: `loja.${AUTO}`, publicIp: IP };
  unknown.add(key);
  return null;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") console.log("  console:", m.text().slice(0, 300)); });
await page.route("**/api/**", async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const body = handle(req.method(), u.pathname, u.search);
  if (body === null) return route.fulfill({ status: 404, json: { error: "not_found", message: "simulado" } });
  return route.fulfill({ json: body });
});

// maxHeight: corta a página inteira nessa altura (prints longos demais pesam e não ajudam).
async function shot(name, path, prepare, fullPage = false, maxHeight = 0) {
  console.log("PAGE", name, path);
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  if (prepare) await prepare();
  await page.waitForTimeout(600);
  const opts = { path: `${OUT}/${name}.png`, fullPage };
  if (maxHeight) opts.clip = { x: 0, y: 0, width: 1400, height: maxHeight };
  await page.screenshot(opts);
}

await shot("dashboard", "/", null, true);
await shot("projeto", "/projects/p1", null, true);
await shot("email-dns", `/mail/${MAIL_DOMAIN}`, async () => {
  await page.getByRole("button", { name: /Checklist DNS/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /verificar agora/i }).first().click();
  await page.waitForTimeout(1000);
}, true);
await shot("backups", "/settings/backups", null, true, 1460);

console.log("Endpoints sem simulação:", [...unknown].join(", ") || "nenhum");
await browser.close();
