/**
 * test-mail-send-log.mts — teste de integração REAL do registro de envios por
 * SMTP: Stalwart v0.11.8 em Docker, em rede --internal (sem saída), com a
 * configuração gerada pelo painel (renderConfigToml com o aviso de envio), e o
 * código do painel (scripts/mail-send-log-harness.mts) rodando num container
 * da mesma rede.
 *
 * Mostra:
 *  1. envio autenticado pela caixa de um projeto aparece, com projeto, de, para,
 *     assunto e corpo (só pela rota de revelar), anexo (nome e tamanho);
 *  2. entrega local = "entregue"; domínio inexistente = falha com motivo (sem MX);
 *  3. mensagem recebida de fora (porta 25, sem login), até com o remetente forjado da caixa do projeto, NÃO é registrada;
 *  4. painel parado: o envio é aceito sem demora e, depois, o painel reconstrói o
 *     registro (só metadados) pelo registro de entrega do Stalwart;
 *  5. listagem nunca traz assunto nem corpo.
 *
 * Uso: node_modules/.bin/tsx scripts/test-mail-send-log.mts
 * Cria e remove: containers paas-sendlog-*, a rede paas-sendlog-it e uma pasta temporária.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { renderConfigToml } from "../packages/mailer/src/server.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NET = "paas-sendlog-it";
const STALWART = "paas-sendlog-stalwart";
const PANEL = "paas-sendlog-panel";
const IMAGE = "stalwartlabs/mail-server:v0.11.8";
const NODE_IMAGE = "node:22-alpine";
const ADMIN = "admin-secret-teste";
const HOOK_SECRET = "cd".repeat(32);
const WORK = mkdtempSync(path.join(tmpdir(), "paas-sendlog-"));

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
/** `docker logs` escreve o stdout e o stderr do container em saídas separadas: junta as duas. */
async function logs(name: string, ...extra: string[]): Promise<string> {
  const { stdout, stderr } = await run("docker", ["logs", ...extra, name], { maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: "", stderr: "" }));
  return stdout + stderr;
}
const quiet = (...args: string[]) => docker(...args).catch(() => "");

async function cleanup() {
  await quiet("rm", "-f", "-v", STALWART, PANEL, "paas-sendlog-sender");
  await quiet("network", "rm", NET);
  rmSync(WORK, { recursive: true, force: true });
}

async function control(pathAndQuery: string, body?: unknown, container = PANEL): Promise<any> {
  const args = ["exec", container, "node", "-e", `
    fetch('http://127.0.0.1:9101${pathAndQuery}', { method: 'POST', body: process.argv[1] })
      .then(r => r.text()).then(t => process.stdout.write(t));`, JSON.stringify(body ?? {})];
  const out = await docker(...args);
  return JSON.parse(out);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (msg: string) => console.log(`  \x1b[32m✔ ${msg}\x1b[0m`, ++passed && "");

async function startPanel(name = PANEL, alias: string | null = "tws-panel") {
  await quiet("rm", "-f", name);
  await docker(
    "run", "-d", "--name", name, "--network", NET, ...(alias ? ["--network-alias", alias] : []),
    "-v", `${WORK}/app:/app:ro`, "-e", `HOOK_SECRET=${HOOK_SECRET}`, "-e", `ADMIN_SECRET=${ADMIN}`, "-e", "DATA_DIR=/data",
    NODE_IMAGE, "node", "/app/harness.mjs",
  );
  for (let i = 0; i < 30; i++) {
    if ((await logs(name)).includes("harness pronto")) return;
    await sleep(500);
  }
  throw new Error("o painel de teste não subiu: " + (await logs(name)));
}

try {
  await cleanup();
  mkdirSync(path.join(WORK, "app"), { recursive: true });

  console.log("\n▶ empacotando o código do painel (esbuild)");
  const esbuildBin = (await run("sh", ["-c", `ls -d ${ROOT}/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1`])).stdout.trim();
  await run(esbuildBin, [
    path.join(ROOT, "scripts/mail-send-log-harness.mts"), "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${WORK}/app/harness.mjs`,
    "--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  ], { cwd: ROOT });

  console.log("▶ rede --internal e Stalwart real com a configuração do painel");
  await docker("network", "create", "--internal", "--subnet", "10.213.78.0/24", NET);
  const toml = renderConfigToml("mail.example.com", ADMIN, [], { sendHook: { url: "http://tws-panel:9100/mail-hook/send", secret: HOOK_SECRET } });
  mkdirSync(path.join(WORK, "etc"), { recursive: true });
  writeFileSync(path.join(WORK, "etc", "config.toml"), toml);
  await docker("create", "--name", STALWART, "--network", NET, "--network-alias", "paas-stalwart", "--network-alias", "mail.example.com", IMAGE);
  await docker("cp", path.join(WORK, "etc"), `${STALWART}:/opt/stalwart-mail/`);
  await docker("start", STALWART);
  await startPanel();
  for (let i = 0; i < 40; i++) {
    if ((await logs(STALWART)).includes("listener started")) break;
    await sleep(500);
  }
  await sleep(2000);
  await control("/provision");
  ok("Stalwart e painel de teste no ar; domínio e caixas criados");

  console.log("▶ 1/2. envios autenticados pela caixa do projeto");
  const sent1 = await control("/send", { user: "loja@example.com", pass: "senha-da-caixa-123", from: "loja@example.com", to: "cliente@dominio-que-nao-existe.example.org", subject: "Seu pedido #123 (açaí)", text: "Olá! Corpo secreto do pedido 123." });
  const sent2 = await control("/send", { user: "loja@example.com", pass: "senha-da-caixa-123", from: "loja@example.com", to: "postmaster@example.com", subject: "Cópia local", text: "Corpo da cópia local." });
  assert.match(sent1.response, /queued/i);
  assert.match(sent2.response, /queued/i);
  ok(`aceitos pelo Stalwart (${sent1.ms} ms e ${sent2.ms} ms, com o aviso ao painel no meio)`);

  console.log("▶ 3. mensagem de fora (porta 25, sem login) com remetente forjado do projeto não é registrada");
  await control("/inbound");

  await sleep(4000);
  const lines = (await logs(STALWART)).split("\n");
  const collected = await control("/collect", { lines });
  assert.ok(collected.added >= 2, `eventos de entrega lidos: ${JSON.stringify(collected)}`);
  const list = await control("/list");
  console.log(JSON.stringify(list.items.map((i: any) => ({ id: i.id, state: i.state, project: i.projectName, origin: i.origin, from: i.from, to: i.recipients.map((r: any) => `${r.address}=${r.state}:${r.error?.kind ?? ""}`), attachments: i.attachments, hasContent: i.hasContent })), null, 1));
  assert.equal(list.total, 2, "só os dois envios autenticados; o recebido de fora não entra");
  const failed = list.items.find((i: any) => i.recipients[0].address.startsWith("cliente@"));
  const delivered = list.items.find((i: any) => i.recipients[0].address.startsWith("postmaster@"));
  assert.equal(failed.projectName, "Loja");
  assert.equal(failed.origin, "project");
  assert.equal(failed.state, "failed");
  assert.equal(failed.recipients[0].error.kind, "no_mx");
  assert.ok(failed.recipients[0].error.technical.length > 0);
  assert.deepEqual(failed.attachments, [{ name: "relatorio.csv", size: 8 }]);
  assert.equal(delivered.state, "delivered");
  ok("entregue (local) e falha 'sem servidor de e-mail no domínio' com o motivo original guardado");

  assert.ok(!JSON.stringify(list).includes("secreto"), "a listagem não pode trazer assunto nem corpo");
  assert.ok(!JSON.stringify(list).includes("açaí"));
  ok("a listagem não traz assunto nem corpo");
  const shown = await control(`/reveal?id=${failed.id}`);
  assert.equal(shown.subject, "Seu pedido #123 (açaí)");
  assert.match(shown.body, /Corpo secreto do pedido 123/);
  ok("Exibir devolve assunto (codificado em MIME no envio) e corpo de uma mensagem");

  console.log("▶ 4. painel parado durante o envio (o envio não pode depender do registro)");
  await docker("stop", PANEL);
  // segundo container com o mesmo código, SEM o nome tws-panel: serve só para submeter o e-mail
  await startPanel("paas-sendlog-sender", null);
  const sentDown = await control("/send", { user: "loja@example.com", pass: "senha-da-caixa-123", from: "loja@example.com", to: "cliente2@dominio-que-nao-existe.example.org", subject: "Enviado com o painel parado", text: "Corpo secreto 2." }, "paas-sendlog-sender");
  assert.match(sentDown.response, /queued/i);
  assert.ok(sentDown.ms < 1500, `o envio com o painel parado demorou ${sentDown.ms} ms`);
  ok(`painel parado: envio aceito em ${sentDown.ms} ms (conexão recusada não atrasa nada)`);
  await sleep(3000);
  await quiet("rm", "-f", "paas-sendlog-sender");
  await docker("start", PANEL);
  for (let i = 0; i < 30; i++) {
    if ((await logs(PANEL)).split("harness pronto").length > 2) break;
    await sleep(500);
  }
  const lines2 = (await logs(STALWART)).split("\n");
  await control("/collect", { lines: lines2 });
  const list2 = await control("/list");
  const stub = list2.items.find((i: any) => i.recipients[0].address.startsWith("cliente2@"));
  assert.ok(stub, "a mensagem enviada com o painel parado aparece pelo registro de entrega");
  assert.equal(stub.captured, false);
  assert.equal(stub.hasContent, false);
  assert.equal(stub.projectName, "Loja");
  assert.equal(stub.state, "failed");
  ok("reconciliação: o envio feito com o painel parado aparece só com metadados, atribuído ao projeto, com o motivo");
  assert.ok(!JSON.stringify(list2).includes("secreto"));

  console.log("\nTudo certo (%d verificações).", passed);
} catch (err) {
  console.error("\nFALHOU:", err);
  console.error(await logs(PANEL, "--tail", "60"));
  process.exitCode = 1;
} finally {
  await cleanup();
}
