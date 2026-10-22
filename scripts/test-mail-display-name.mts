/**
 * test-mail-display-name.mts — teste REAL do nome de exibição das caixas contra o Stalwart.
 *
 * Sobe o Stalwart da versão fixada pelo painel (STALWART_IMAGE_REF) num container descartável, numa rede
 * Docker --internal (sem saída para a internet), e confere com o StalwartClient de verdade que:
 *  1. o nome de exibição é gravado ao criar a caixa (campo `description` do principal);
 *  2. alterar o nome muda só ele: a senha continua a mesma, assim como 2FA/senhas de app (secrets) e aliases;
 *  3. remover o nome (vazio) limpa o campo;
 *  4. a listagem traz o nome (é de onde a sincronização o adota depois de restaurar);
 *  5. nome com acento, emoji, aspas simples e texto longo faz a ida e volta sem perda (o JSON leva o valor).
 *
 * Tudo o que cria (container, rede, volume) é removido no fim, mesmo com falha. A imagem não é baixada nem
 * removida: precisa já existir localmente (`docker pull` do STALWART_IMAGE_REF).
 *
 * Uso: pnpm exec tsx scripts/test-mail-display-name.mts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { STALWART_IMAGE_REF } from "../packages/core/src/index.js";
import { StalwartClient, renderConfigToml } from "../packages/mailer/src/index.js";

const run = promisify(execFile);
const docker = (...args: string[]) => run("docker", args, { maxBuffer: 8 * 1024 * 1024 });

// Modo "dentro": roda dentro de um container na rede interna (o host não alcança o IP de uma rede --internal).
const INSIDE = process.env.TWS_DN_INSIDE_BASE ?? null;
const suffix = randomBytes(4).toString("hex");
const NAME = `tws-dn-test-${suffix}`;
const NETWORK = `${NAME}-net`;
const VOLUME = `${NAME}-data`;
const ADMIN_SECRET = process.env.TWS_DN_ADMIN_SECRET ?? randomBytes(18).toString("base64url");
const DOMAIN = "example.com";
const BOX = `contato@${DOMAIN}`;
const PASSWORD = process.env.TWS_DN_BOX_SECRET ?? `Aa1-${randomBytes(12).toString("base64url")}`;
let passed = 0;

function ok(msg: string): void {
  passed += 1;
  console.log(`  ok  ${msg}`);
}

async function rawPrincipal(base: string, email: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/principal/${encodeURIComponent(email)}`, {
    headers: { authorization: `Basic ${Buffer.from(`admin:${ADMIN_SECRET}`).toString("base64")}` },
  });
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

async function cleanup(): Promise<void> {
  await docker("rm", "-f", "-v", NAME).catch(() => undefined);
  await docker("network", "rm", NETWORK).catch(() => undefined);
  await docker("volume", "rm", "-f", VOLUME).catch(() => undefined);
}

async function main(): Promise<void> {
  // sub-rede explícita: com muitas redes no host o Docker pode ficar sem faixas livres (TWS_DN_SUBNET troca a faixa)
  await docker("network", "create", "--internal", "--subnet", process.env.TWS_DN_SUBNET ?? "10.250.37.0/24", NETWORK);
  await docker("volume", "create", VOLUME);
  await docker(
    "create", "--name", NAME, "--network", NETWORK,
    "-v", `${VOLUME}:/opt/stalwart-mail/data`, "--label", "tws.test=display-name",
    STALWART_IMAGE_REF,
  );
  // config.toml entregue por docker cp (como o painel faz)
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "tws-dn-"));
  try {
    mkdirSync(path.join(dir, "etc"));
    writeFileSync(path.join(dir, "etc", "config.toml"), renderConfigToml(`mail.${DOMAIN}`, ADMIN_SECRET, [], { reportDomain: null }), { mode: 0o600 });
    await docker("cp", `${dir}/.`, `${NAME}:/opt/stalwart-mail`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await docker("start", NAME);
  const ip = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, NAME)).stdout.trim();
  // O host não alcança uma rede --internal: os testes rodam num container Node na mesma rede, com o repositório
  // montado só para leitura.
  const out = await docker(
    "run", "--rm", "--network", NETWORK, "--label", "tws.test=display-name", "-v", `${process.cwd()}:/work:ro`, "-w", "/work",
    "-e", `TWS_DN_INSIDE_BASE=http://${ip}:8080`, "-e", `TWS_DN_ADMIN_SECRET=${ADMIN_SECRET}`, "-e", `TWS_DN_BOX_SECRET=${PASSWORD}`,
    "node:22-alpine", "node_modules/.bin/tsx", "scripts/test-mail-display-name.mts",
  );
  console.log(out.stdout);
}

async function checks(base: string): Promise<void> {
  const client = new StalwartClient(base, "admin", ADMIN_SECRET);

  for (let i = 0; ; i += 1) {
    try {
      await client.createDomain(DOMAIN);
      break;
    } catch (err) {
      if (i >= 60) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log("Nome de exibição contra o Stalwart real");
  await client.createMailbox(BOX, PASSWORD, [], "Contato - Loja Exemplo");
  assert.equal((await rawPrincipal(base, BOX)).description, "Contato - Loja Exemplo");
  ok("criar a caixa grava o nome em description");

  assert.equal(await client.mailboxPasswordMatches(BOX, PASSWORD), true);
  // 2FA (otpauth://) e senha de app ($app$) dividem o campo secrets com a senha
  await fetch(`${base}/api/principal/${encodeURIComponent(BOX)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`admin:${ADMIN_SECRET}`).toString("base64")}` },
    body: JSON.stringify([
      { action: "addItem", field: "secrets", value: "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP" },
      { action: "addItem", field: "secrets", value: "$app$celular$not-a-real-hash" },
    ]),
  });
  const secretsBefore = (await rawPrincipal(base, BOX)).secrets;
  assert.ok(Array.isArray(secretsBefore) && secretsBefore.length === 3);
  await client.addMailboxAlias(BOX, `alias@${DOMAIN}`);

  await client.setMailboxDisplayName(BOX, "Atendimento Ação 日本 😀 O'Neil");
  const after = await rawPrincipal(base, BOX);
  assert.equal(after.description, "Atendimento Ação 日本 😀 O'Neil");
  ok("alterar o nome grava o texto com acento, CJK, emoji e aspas simples sem perda");

  assert.equal(await client.mailboxPasswordMatches(BOX, PASSWORD), true);
  assert.deepEqual(after.secrets, secretsBefore);
  ok("a senha e os secrets (senha, 2FA, senhas de app) continuam exatamente os mesmos");
  assert.deepEqual((await client.mailboxEmails(BOX)).sort(), [`alias@${DOMAIN}`, BOX].sort());
  ok("os endereços (aliases) continuam os mesmos");

  const listed = (await client.listPrincipals("individual")).find((p) => p.name === BOX);
  assert.equal(listed?.description, "Atendimento Ação 日本 😀 O'Neil");
  ok("a listagem traz o nome (a sincronização o adota depois de restaurar)");

  const long = "N".repeat(80);
  await client.setMailboxDisplayName(BOX, long);
  assert.equal((await rawPrincipal(base, BOX)).description, long);
  ok("nome no limite de 80 caracteres");

  await client.setMailboxDisplayName(BOX, "");
  const cleared = await rawPrincipal(base, BOX);
  assert.ok(cleared.description === undefined || cleared.description === "" || cleared.description === null);
  assert.equal(await client.mailboxPasswordMatches(BOX, PASSWORD), true);
  ok("nome vazio remove o campo e a senha continua valendo");

  await client.createMailbox(`sem-nome@${DOMAIN}`, PASSWORD);
  const bare = await rawPrincipal(base, `sem-nome@${DOMAIN}`);
  assert.ok(bare.description === undefined || bare.description === "");
  ok("caixa criada sem nome fica sem description");

  console.log(`\n${passed} verificações passaram.`);
}

(INSIDE ? checks(INSIDE) : main().finally(cleanup))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
