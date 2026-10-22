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
import { STALWART_IMAGE_REF } from "@paas/core";
import { StalwartClient, renderConfigToml } from "@paas/mailer";

const run = promisify(execFile);
const docker = (...args: string[]) => run("docker", args, { maxBuffer: 8 * 1024 * 1024 });

const suffix = randomBytes(4).toString("hex");
const NAME = `tws-dn-test-${suffix}`;
const NETWORK = `${NAME}-net`;
const VOLUME = `${NAME}-data`;
const ADMIN_SECRET = randomBytes(18).toString("base64url");
const DOMAIN = "example.com";
const BOX = `contato@${DOMAIN}`;
const PASSWORD = `Aa1-${randomBytes(12).toString("base64url")}`;
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
  await docker("network", "create", "--internal", NETWORK);
  await docker("volume", "create", VOLUME);
  await docker(
    "create", "--name", NAME, "--network", NETWORK,
    "-v", `${VOLUME}:/opt/stalwart-mail/data`, "--label", "tws.test=display-name",
    STALWART_IMAGE_REF,
  );
  // config.toml entregue por docker cp (como o painel faz)
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "tws-dn-"));
  try {
    writeFileSync(path.join(dir, "config.toml"), renderConfigToml(`mail.${DOMAIN}`, ADMIN_SECRET, [], { reportDomain: null }), { mode: 0o600 });
    await docker("cp", path.join(dir, "config.toml"), `${NAME}:/opt/stalwart-mail/etc/config.toml`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await docker("start", NAME);
  const ip = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, NAME)).stdout.trim();
  const base = `http://${ip}:8080`;
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
  const secretsBefore = (await rawPrincipal(base, BOX)).secrets;
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

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
