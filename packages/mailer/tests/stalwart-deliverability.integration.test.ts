/**
 * Integração REAL com o Stalwart v0.11.8 em Docker: assinatura DKIM, cabeçalhos
 * que o servidor acrescenta, chave publicada que o painel consegue ler (2048
 * bits) e o diagnóstico de atraso a partir da fila verdadeira.
 *
 * Só roda com STALWART_INTEGRATION=1 (precisa de Docker e da imagem
 * stalwartlabs/mail-server:v0.11.8 e node:22-alpine já baixadas). Fora disso
 * é pulado, e a suíte comum continua sem Docker.
 *
 * Isolamento: o Stalwart fica numa rede `--internal` (sem saída para a
 * internet). Um proxy de TCP (node:22-alpine) é a única ponte: entra na rede
 * interna e numa rede comum que publica portas só em 127.0.0.1. Tudo que este
 * teste cria (2 contêineres, 2 redes, pasta temporária) é removido no fim; as
 * imagens ficam, porque já existiam.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StalwartClient } from "../src/client.js";
import { classifyDelay, evaluateHealth } from "../src/deliverability-health.js";
import { queueItemFromMessage } from "../src/queue-view.js";
import { renderConfigToml } from "../src/server.js";
import { sendSmtpMail } from "../src/smtp-send.js";
import type { DnsResolverLike } from "../src/dns-checklist.js";

const enabled = process.env.STALWART_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

// Pela tag (a imagem local já existe); o painel usa a referência com digest.
const STALWART_IMAGE = "stalwartlabs/mail-server:v0.11.8";
const ID = randomBytes(4).toString("hex");
const INTERNAL = `tws-it-int-${ID}`;
const EXTERNAL = `tws-it-ext-${ID}`;
const STALWART = `tws-it-stalwart-${ID}`;
const PROXY = `tws-it-proxy-${ID}`;
const ALIAS = "stalwart-it";
const SINK_ALIAS = "sink-it";
const SINK = `tws-it-sink-${ID}`;
const DEFER = `tws-it-defer-${ID}`;
const DEFER_ALIAS = "defer-it";
const DEFER_TEXT = "451 4.7.26 This mail is unauthenticated, which poses a security risk to the recipient";
const DOMAIN = "example.test";
/** Domínio cuja chave DKIM é criada SEM reiniciar o servidor (o controle do achado). */
const NORESTART = "semreinicio.test";
/** Destino cujo servidor recusa o destinatário com 4xx (falha de autenticação do Gmail): a mensagem fica adiada de verdade. */
const DOWN_DOMAIN = "adiado.test";
const HOST = `mail.${DOMAIN}`;
const SECRET = `it-${randomBytes(8).toString("hex")}`;
const PASSWORD = `Senha-${randomBytes(6).toString("hex")}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function mappedPort(container: string, port: number): number {
  const line = docker("port", container, `${port}/tcp`).split("\n")[0] ?? "";
  return Number(line.slice(line.lastIndexOf(":") + 1));
}

async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tempo esgotado: ${what}${last ? ` (${String(last)})` : ""}`);
}

/** Cabeçalhos da primeira mensagem da caixa, por IMAP (TLS implícito, certificado autoassinado). */
async function imapHeaders(port: number, user: string, password: string): Promise<string | null> {
  const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
  });
  const wait = async (re: RegExp): Promise<string> =>
    until(String(re), async () => {
      const m = re.exec(buffer);
      if (!m) return null;
      const out = buffer;
      buffer = "";
      return out;
    }, 10_000);
  try {
    await wait(/\* OK/);
    let tag = 0;
    const cmd = async (text: string): Promise<string> => {
      tag += 1;
      socket.write(`a${tag} ${text}\r\n`);
      return wait(new RegExp(`a${tag} (OK|NO|BAD)`));
    };
    if (!/a1 OK/.test(await cmd(`LOGIN "${user}" "${password}"`))) return null;
    const select = await cmd("SELECT INBOX");
    if (!/ [1-9][0-9]* EXISTS/.test(select)) return null;
    return await cmd("FETCH 1:* BODY.PEEK[HEADER]");
  } catch {
    return null;
  } finally {
    socket.destroy();
  }
}

suite("Stalwart v0.11.8 real (Docker, rede interna)", () => {
  let work = "";
  let client: StalwartClient;
  let smtpPort = 0;
  let imapPort = 0;
  let dkimPublicKey = "";

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), "tws-it-"));
    mkdirSync(path.join(work, "etc"));
    // Tudo que não é do domínio local vai para um receptor falso (SINK): é o jeito de ver a mensagem
    // como ela SAI do servidor, já assinada. TLS opcional só aqui, porque o receptor falso não tem TLS.
    const base = renderConfigToml(HOST, SECRET, [], { reportDomain: DOMAIN });
    const [first, ...rest] = base.split("\n");
    const config = [
      first,
      `queue.outbound.next-hop = [{if = "rcpt_domain == '${DOMAIN}'", then = "'local'"}, {if = "rcpt_domain == '${DOWN_DOMAIN}'", then = "'down'"}, {else = "'sink'"}]`,
      'queue.outbound.tls.starttls = "optional"',
      ...rest,
      "",
      "[remote.down]",
      `address = "${DEFER_ALIAS}"`,
      "port = 25",
      'protocol = "smtp"',
      "tls.implicit = false",
      "",
      "[remote.sink]",
      `address = "${SINK_ALIAS}"`,
      "port = 25",
      'protocol = "smtp"',
      "tls.implicit = false",
      "tls.allow-invalid-certs = true",
      "",
    ].join("\n");
    writeFileSync(path.join(work, "etc", "config.toml"), config, { mode: 0o600 });

    // Sub-redes explícitas: o Docker Desktop costuma ter os intervalos padrão esgotados.
    const octet = (i: number) => Number.parseInt(ID.slice(i * 2, i * 2 + 2), 16);
    docker("network", "create", "--internal", "--subnet", `10.${120 + (octet(0) % 60)}.${octet(1)}.0/24`, INTERNAL);
    docker("network", "create", "--subnet", `10.${180 + (octet(2) % 60)}.${octet(3)}.0/24`, EXTERNAL);

    const sinkScript = [
      "const net=require('net');",
      "net.createServer(c=>{let d=false,b='';const w=t=>c.write(t+'\\r\\n');w('220 sink ESMTP');",
      "c.on('data',x=>{b+=x.toString('latin1');",
      "if(d){if(b.endsWith('\\r\\n.\\r\\n')){console.log('MSG:'+Buffer.from(b,'latin1').toString('base64'));b='';d=false;w('250 ok');}return;}",
      "let i;while((i=b.indexOf('\\r\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+2);",
      "if(/^EHLO/i.test(l))w('250 sink');else if(/^DATA/i.test(l)){d=true;w('354 go');break;}else if(/^QUIT/i.test(l)){w('221 bye');c.end();}else w('250 ok');}",
      "});c.on('error',()=>{});}).listen(25,'0.0.0.0');",
    ].join("");
    docker("run", "-d", "--name", SINK, "--network", INTERNAL, "--network-alias", SINK_ALIAS, "node:22-alpine", "node", "-e", sinkScript);
    const deferScript = [
      "const net=require('net');",
      "net.createServer(c=>{c.write('220 defer ESMTP\\r\\n');let b='';c.on('data',x=>{b+=x.toString('latin1');let i;",
      "while((i=b.indexOf('\\r\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+2);",
      `if(/^RCPT/i.test(l))c.write('${DEFER_TEXT}\\r\\n');`,
      "else if(/^QUIT/i.test(l)){c.write('221 bye\\r\\n');c.end();}else if(/^EHLO/i.test(l))c.write('250 defer\\r\\n');else c.write('250 ok\\r\\n');}});c.on('error',()=>{});}).listen(25,'0.0.0.0');",
    ].join("");
    docker("run", "-d", "--name", DEFER, "--network", INTERNAL, "--network-alias", DEFER_ALIAS, "node:22-alpine", "node", "-e", deferScript);
    docker("create", "--name", STALWART, "--network", INTERNAL, "--network-alias", ALIAS, STALWART_IMAGE);
    docker("cp", path.join(work, "etc"), `${STALWART}:/opt/stalwart-mail/`);
    docker("start", STALWART);

    const proxyScript = [
      "const net=require('net');",
      `for (const p of [8080,465,993]) net.createServer(c=>{const u=net.connect(p,'${ALIAS}');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(p,'0.0.0.0');`,
    ].join("");
    docker(
      "run", "-d", "--name", PROXY, "--network", EXTERNAL,
      "-p", "127.0.0.1::8080", "-p", "127.0.0.1::465", "-p", "127.0.0.1::993",
      "node:22-alpine", "node", "-e", proxyScript,
    );
    docker("network", "connect", INTERNAL, PROXY);

    const apiPort = mappedPort(PROXY, 8080);
    smtpPort = mappedPort(PROXY, 465);
    imapPort = mappedPort(PROXY, 993);
    client = new StalwartClient(`http://127.0.0.1:${apiPort}`, "admin", SECRET);

    await until("API do Stalwart", async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/principal?limit=1`, {
        headers: { Authorization: `Basic ${Buffer.from(`admin:${SECRET}`).toString("base64")}` },
      });
      return res.status === 200;
    });

    await client.createDomain(DOMAIN);
    const signatureId = await client.createDkimSignature(DOMAIN);
    dkimPublicKey = await client.getDkimPublicKey(signatureId);
    // Como o painel faz ao cadastrar o domínio: sem reiniciar, o Stalwart v0.11.8 não assina com a chave
    // nova (nem com /api/reload) e a mensagem sai sem DKIM-Signature.
    docker("restart", STALWART);
    await until("API depois do reinício", async () => client.listQueue().then(() => true).catch(() => false));
    await client.createMailbox(`alice@${DOMAIN}`, PASSWORD);
    await client.createMailbox(`bob@${DOMAIN}`, PASSWORD);

    // Controle: segundo domínio com chave criada DEPOIS do último reinício e sem reiniciar de novo.
    await client.createDomain(NORESTART);
    await client.createDkimSignature(NORESTART);
    await client.createMailbox(`carol@${NORESTART}`, PASSWORD);
  }, 180_000);

  afterAll(() => {
    for (const args of [
      ["rm", "-f", "-v", PROXY],
      ["rm", "-f", "-v", SINK],
      ["rm", "-f", "-v", DEFER],
      ["rm", "-f", "-v", STALWART],
      ["network", "rm", INTERNAL],
      ["network", "rm", EXTERNAL],
    ]) {
      try {
        docker(...args);
      } catch {
        // já removido
      }
    }
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  async function send(to: string, subject: string, user = `alice@${DOMAIN}`): Promise<void> {
    await sendSmtpMail({
      host: "127.0.0.1",
      port: smtpPort,
      servername: HOST,
      username: user,
      password: PASSWORD,
      from: user,
      to,
      subject,
      text: "Mensagem de teste de entregabilidade.",
      envId: `it-${randomBytes(4).toString("hex")}`,
      // sem Message-ID do cliente de propósito: o servidor deve acrescentar o dele? (o buildTestMessage já traz um)
      messageId: `<it-${randomBytes(4).toString("hex")}@${user.split("@")[1]}>`,
    });
  }

  /** Mensagem que chegou ao receptor falso com este assunto (como o Stalwart a entregou). */
  async function sinkMessage(subject: string): Promise<string> {
    return until(`mensagem "${subject}" no receptor falso`, async () => {
      for (const line of docker("logs", SINK).split("\n")) {
        if (!line.startsWith("MSG:")) continue;
        const raw = Buffer.from(line.slice(4), "base64").toString("latin1");
        if (raw.includes(`Subject: ${subject}`)) return raw;
      }
      return null;
    }, 60_000);
  }

  it("a chave DKIM criada pelo painel tem 2048 bits e o verificador de saúde a lê", async () => {
    const zone: Record<string, string[]> = {
      [`paas._domainkey.${DOMAIN}`]: [`v=DKIM1; k=rsa; p=${dkimPublicKey}`],
    };
    const resolver: DnsResolverLike = {
      resolve4: async () => [],
      resolve6: async () => [],
      resolveMx: async () => [],
      resolveTxt: async (name) => (zone[name] ? [[zone[name]![0]!]] : Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }))),
      reverse: async () => [],
    };
    const report = await evaluateHealth({
      domain: DOMAIN,
      mailHostname: HOST,
      serverHostname: HOST,
      serverIp: "203.0.113.10",
      dkimSelector: "paas",
      dkimPublicKey,
      dmarcStage: "none",
      resolvers: [{ label: "falso", resolver }],
      ptr: { ip: "203.0.113.10", expected: HOST, status: "found", found: [HOST], ticketText: null },
      port25: { status: "open" },
      queue: [],
      serverRunning: true,
      tlsHosts: [],
      blacklist: null,
      fetchPolicy: async () => null,
      isProxyIp: () => false,
      now: Date.now(),
    });
    expect(report.checks.find((c) => c.id === "dkim")).toMatchObject({ level: "ok", params: { bits: 2048, selector: "paas" } });
  });

  it("mensagem entregue a uma caixa local tem Message-ID e Date (a assinatura DKIM é feita só na saída)", async () => {
    await send(`bob@${DOMAIN}`, "Teste de assinatura");
    const raw = await until("mensagem na caixa do bob", async () => {
      const out = await imapHeaders(imapPort, `bob@${DOMAIN}`, PASSWORD);
      return out && /Subject: Teste de assinatura/i.test(out) ? out : null;
    });
    const headers = raw.replace(/\r\n[ \t]+/g, " ");
    expect(headers).toMatch(/^Message-ID: <.+>/im);
    expect(headers).toMatch(/^Date: .+/im);
    // a chave privada nunca aparece
    expect(raw).not.toMatch(/PRIVATE KEY/);
  }, 120_000);

  it("sem o Message-ID do app, o servidor acrescenta um (submissão na 465)", async () => {
    const socket = tls.connect({ host: "127.0.0.1", port: smtpPort, servername: HOST, rejectUnauthorized: false });
    const lines: string[] = [];
    socket.on("data", (c) => lines.push(c.toString("utf8")));
    const wait = async (needle: string) => until(needle, async () => lines.join("").includes(needle));
    await wait("220");
    socket.write("EHLO it\r\n");
    await wait("250 ");
    socket.write(`AUTH PLAIN ${Buffer.from(`\0alice@${DOMAIN}\0${PASSWORD}`).toString("base64")}\r\n`);
    await wait("235");
    socket.write(`MAIL FROM:<alice@${DOMAIN}>\r\nRCPT TO:<bob@${DOMAIN}>\r\nDATA\r\n`);
    await wait("354");
    socket.write(`From: alice@${DOMAIN}\r\nTo: bob@${DOMAIN}\r\nSubject: Sem cabecalhos\r\n\r\ncorpo\r\n.\r\n`);
    await wait("250 2.0.0");
    socket.write("QUIT\r\n");
    socket.destroy();
    const raw = await until("mensagem sem cabeçalhos na caixa", async () => {
      const out = await imapHeaders(imapPort, `bob@${DOMAIN}`, PASSWORD);
      return out && /Subject: Sem cabecalhos/i.test(out) ? out : null;
    });
    expect(raw).toMatch(/^Message-ID: <.+>/im);
    expect(raw).toMatch(/^Date: .+/im);
  }, 120_000);

  it("mensagem para fora sai do servidor assinada com DKIM, pelo seletor e domínio do painel", async () => {
    await send("alguem@destino-externo.test", "Teste de saida");
    const raw = await until("mensagem chegar ao receptor falso", async () => {
      const line = docker("logs", SINK).split("\n").find((l) => l.startsWith("MSG:"));
      return line ? Buffer.from(line.slice(4), "base64").toString("latin1") : null;
    }, 60_000).catch(async (err: Error) => {
      const { items } = await client.listQueue();
      throw new Error(`${err.message}; fila: ${JSON.stringify(items.map(queueItemFromMessage))}`);
    });
    const headers = raw.replace(/\r\n[ \t]+/g, " ");
    const signature = /^DKIM-Signature: (.+)$/im.exec(headers)?.[1] ?? "";
    expect(signature).toMatch(/\bd=example\.test\b/);
    expect(signature).toMatch(/\bs=paas\b/);
    expect(signature).toMatch(/\ba=rsa-sha256\b/);
    expect(signature).toMatch(/\bc=relaxed\/relaxed\b/);
    const signed = /\bh=([^;]+)/.exec(signature)?.[1]?.toLowerCase().replace(/\s/g, "").split(":") ?? [];
    expect(signed).toEqual(expect.arrayContaining(["from", "to", "subject", "date", "message-id"]));
    expect(headers).toMatch(/^Message-ID: <.+>/im);
    expect(headers).toMatch(/^Date: .+/im);
    expect(raw).not.toMatch(/PRIVATE KEY/);
  }, 120_000);

  it("a fila verdadeira é lida pelo painel e a causa do atraso é classificada", async () => {
    const { items } = await client.listQueue();
    const views = items.map(queueItemFromMessage);
    // tudo já foi entregue ao receptor falso: a fila lida sem erro, sem nada preso
    expect(views.every((v) => v.recipients.every((r) => r.state !== "bounced"))).toBe(true);
    expect(classifyDelay("421-4.7.28 unusual rate of unsolicited mail")).toBe("rate_limited");
  });

  it("CONTROLE: chave DKIM criada sem reiniciar o servidor NÃO assina; depois do reinício, assina", async () => {
    await send("alguem@destino-externo.test", "Controle sem reinicio", `carol@${NORESTART}`);
    const before = await sinkMessage("Controle sem reinicio");
    expect(before).not.toMatch(/^DKIM-Signature:/im);
    // o que o painel passou a fazer ao cadastrar/adotar um domínio
    docker("restart", STALWART);
    await until("API depois do reinício", async () => client.listQueue().then(() => true).catch(() => false));
    await send("alguem@destino-externo.test", "Controle com reinicio", `carol@${NORESTART}`);
    const after = await sinkMessage("Controle com reinicio");
    expect(after).toMatch(/^DKIM-Signature: .*\bd=semreinicio\.test\b/ims);
  }, 240_000);

  it("adiamento REAL do Stalwart: a fila lida da API vira o item 'Fila de envio' com a causa em português", async () => {
    await send(`alguem@${DOWN_DOMAIN}`, "Para destino fora do ar");
    const views = await until("mensagem adiada na fila do Stalwart", async () => {
      const { items } = await client.listQueue();
      const deferred = items.map(queueItemFromMessage).filter((v) => v.recipients.some((r) => r.state === "deferred") && v.lastError);
      return deferred.length > 0 ? deferred : null;
    }, 90_000).catch(async (err: Error) => {
      const { items } = await client.listQueue();
      throw new Error(`${err.message}; fila: ${JSON.stringify(items)}`);
    });
    const reason = views[0]!.lastError!;
    // não é texto fixo do teste: é o que o Stalwart escreveu ao adiar (a recusa 4.7.26 do destino)
    expect(reason.length).toBeGreaterThan(5);
    expect(reason).toContain("4.7.26");
    expect(classifyDelay(reason)).toBe("auth");
    const report = await evaluateHealth({
      domain: DOMAIN,
      mailHostname: HOST,
      serverHostname: HOST,
      serverIp: "203.0.113.10",
      dkimSelector: "paas",
      dkimPublicKey,
      dmarcStage: "none",
      resolvers: [{ label: "falso", resolver: { resolve4: async () => [], resolve6: async () => [], resolveMx: async () => [], resolveTxt: async () => [], reverse: async () => [] } }],
      ptr: { ip: "203.0.113.10", expected: HOST, status: "found", found: [HOST], ticketText: null },
      port25: { status: "open" },
      queue: views,
      serverRunning: true,
      tlsHosts: [],
      blacklist: null,
      fetchPolicy: async () => null,
      isProxyIp: () => false,
      now: Date.now(),
    });
    const queue = report.checks.find((c) => c.id === "queue")!;
    expect(queue).toMatchObject({ code: "deferred_auth", level: "critical" });
    expect(queue.params.count).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
