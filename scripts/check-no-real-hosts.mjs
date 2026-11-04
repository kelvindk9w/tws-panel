#!/usr/bin/env node
/**
 * check-no-real-hosts.mjs — falha se domínios ou IPs reais voltarem ao repositório.
 *
 * Varre os arquivos do repositório e reprova:
 *   - qualquer coisa.tws.tec.br (subdomínio, curinga, sublinhado);
 *   - e-mails @tws.tec.br que não sejam o contato oficial;
 *   - IPv4 público que não esteja na lista de exceções abaixo, inclusive embutido
 *     em nomes sslip.io/nip.io (203.0.113.10.sslip.io e 203-0-113-10.sslip.io);
 *   - hostnames de provedor de VPS no formato vmiNNNNN;
 *   - IPv6 que não seja de documentação, loopback, link-local, ULA nem das faixas da Cloudflare;
 *   - padrões EXTERNOS (outros domínios do dono, nomes de cliente...): ficam fora do repositório, para a
 *     lista não ser publicada. Vêm da variável de ambiente CHECK_REAL_HOSTS_PATTERNS (um regex por linha,
 *     ou separados por ";;") e/ou do arquivo apontado por CHECK_REAL_HOSTS_FILE (padrão:
 *     .check-real-hosts.local na raiz, ignorado pelo Git; um regex por linha, `#` comenta). Valem para o
 *     conteúdo e para o caminho dos arquivos, sem diferenciar maiúsculas. A saída cita o número do padrão
 *     e o lugar, nunca o valor encontrado. Use regex que peguem o termo colado em outras palavras (sem \b).
 *     No CI a lista vem do secret de Actions CHECK_REAL_HOSTS_PATTERNS (veja o CONTRIBUTING); PR de fork não
 *     recebe o secret e roda sem esses padrões, sem falhar por isso.
 *
 * Imagens (png/jpg/gif/webp) novas ou trocadas só geram AVISO, porque o verificador não lê pixels: uma
 * captura de tela pode mostrar IP, hostname ou nome de cliente. Depois de olhar a imagem, registre o hash dela
 * em scripts/imagens-revisadas.txt (linha "sha256  caminho"); `node scripts/check-no-real-hosts.mjs
 * --hash-imagens` imprime as linhas das que faltam.
 *
 * Uso: node scripts/check-no-real-hosts.mjs   (sai com código 1 se achar algo)
 * CI: roda como teste em packages/core/tests/no-real-hosts.test.ts e como etapa própria do workflow.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESTE_ARQUIVO = "scripts/check-no-real-hosts.mjs";
const ARQUIVO_IMAGENS_REVISADAS = "scripts/imagens-revisadas.txt";
const ARQUIVO_PADROES_EXTERNOS = ".check-real-hosts.local"; // ignorado pelo Git
const IGNORADOS = new Set(["pnpm-lock.yaml", ESTE_ARQUIVO]);
const IMAGENS = /\.(png|jpe?g|gif|webp)$/i;

/** E-mails da empresa permitidos de propósito. */
const EMAILS_PERMITIDOS = new Set(["contato@tws.tec.br"]);

/** IPs públicos que aparecem como configuração (DNS públicos) ou como valor fictício de teste. */
const IPS_PERMITIDOS = new Set([
  "1.1.1.1", "8.8.8.8", "9.9.9.9", "1.2.3.4", "6.7.8.9", "2.2.2.2", "3.3.3.3", "4.3.2.1", "2.0.0.127",
]);

/** Faixas IPv4 da Cloudflare, as mesmas de apps/server/src/routes/domains.ts (CLOUDFLARE_V4). */
const CIDRS_PERMITIDOS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  // faixas reservadas (nunca de uma VPS real): protocolo, 6to4, benchmark, multicast e reservado/broadcast
  "192.0.0.0/24", "192.88.99.0/24", "198.18.0.0/15", "224.0.0.0/3",
];

/** Faixas IPv6 aceitas: documentação, loopback, ULA, link-local, multicast, 6to4 e as da Cloudflare. */
const CIDRS_V6_PERMITIDOS = [
  "::/128", "::1/128", "2001:db8::/32", "3fff::/20", "fc00::/7", "fe80::/10", "ff00::/8", "2002::/16",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
  // reservadas: NAT64, descarte, site-local obsoleto e Teredo
  "64:ff9b::/32", "100::/64", "fec0::/10", "2001::/32",
  // endereços exatos que os testes usam como "IPv6 público qualquer" (não aceite o bloco inteiro)
  "2a00:1450::1/128", "2804:14c::1/128",
];

/** Hostnames fictícios de provedor usados nos testes e na documentação. */
const VMI_PERMITIDOS = new Set(["vmi1234567", "vmi0000000", "vmi9999999"]);

// Um IPv4 isolado: sem dígito colado nos lados e sem um quinto grupo (versões como 1.2.3.4.5).
// Ponto final de frase ("o IP é X.Y.Z.W.") e reticências ("...X.Y.Z.W") não impedem a detecção.
const RE_IPV4 = /(?<!\d|\d\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
// DNS curinga que embute o IP com hífens (203-0-113-10.sslip.io), com ou sem prefixo
// (app-203-0-113-10.nip.io, www.app-203-0-113-10.traefik.me).
const RE_IPV4_HIFEN = /(?<!\d)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?=\.(?:(?:sslip|nip)\.io|traefik\.me)\b)/gi;
// Qualquer coisa antes de ".tws.tec.br": subdomínio, curinga (*), sublinhado, ou nada.
const RE_SUBDOMINIO = /[\w*.-]*\.tws\.tec\.br\b/gi;
const RE_EMAIL = /\b[\w.+-]+@tws\.tec\.br\b/gi;
// Hostname padrão de provedor de VPS: vmi seguido de dígitos.
const RE_VMI = /(?<![\w-])vmi\d{5,}\b/gi;
// Candidato a IPv6: oito grupos completos ou forma com "::" (horas como 12:30:45 e MACs não entram).
const RE_IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:]|\.\d)/gi;

function ipToInt(o) {
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function noCidr(o, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = (~0 << (32 - Number(bits))) >>> 0;
  const b = base.split(".").map(Number);
  return (ipToInt(o) & mask) === (ipToInt(b) & mask);
}

function ipPermitido(ip, o) {
  if (IPS_PERMITIDOS.has(ip)) return true;
  if (o.some((n) => n > 255)) return true; // não é IP (ex.: versão)
  const [a, b, c] = o;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return CIDRS_PERMITIDOS.some((cidr) => noCidr(o, cidr));
}

/** Expande um IPv6 em oito grupos de 16 bits; devolve null se não for um IPv6 válido. */
function expandirIpv6(txt) {
  if ((txt.match(/::/g) ?? []).length > 1) return null;
  const [cabeca, cauda] = txt.split("::");
  const a = cabeca ? cabeca.split(":") : [];
  const b = cauda ? cauda.split(":") : [];
  let grupos;
  if (cauda === undefined) grupos = a;
  else {
    const falta = 8 - a.length - b.length;
    if (falta < 1) return null;
    grupos = [...a, ...Array(falta).fill("0"), ...b];
  }
  if (grupos.length !== 8 || grupos.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return grupos.map((g) => parseInt(g, 16));
}

function dentroDaFaixaV6(g, cidr) {
  const [base, bits] = cidr.split("/");
  const b = expandirIpv6(base);
  let resto = Number(bits);
  for (let i = 0; i < 8 && resto > 0; i++, resto -= 16) {
    const mask = resto >= 16 ? 0xffff : (0xffff << (16 - resto)) & 0xffff;
    if ((g[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

function ipv6Permitido(txt) {
  const g = expandirIpv6(txt);
  if (!g) return true; // não é um IPv6
  // IPv4 mapeado (::ffff:a.b.c.d em hexadecimal): vale a regra do IPv4 embutido
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const o = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    return ipPermitido(o.join("."), o);
  }
  // ::/80 (loopback, "::a.b.c.d" em desuso, sintaxe de portas do Docker "ip::porta"): nunca é um host real
  if (g.slice(0, 5).every((n) => n === 0)) return true;
  return CIDRS_V6_PERMITIDOS.some((c) => dentroDaFaixaV6(g, c));
}

/**
 * Lê os padrões externos (variável de ambiente e arquivo ignorado). Um regex inválido é erro, para a
 * checagem não deixar de funcionar em silêncio.
 */
export function carregarPadroesExternos(raiz = RAIZ, env = process.env) {
  const linhas = [];
  if (env.CHECK_REAL_HOSTS_PATTERNS) linhas.push(...env.CHECK_REAL_HOSTS_PATTERNS.split(/\n|;;/));
  const arquivo = env.CHECK_REAL_HOSTS_FILE ? resolve(env.CHECK_REAL_HOSTS_FILE) : resolve(raiz, ARQUIVO_PADROES_EXTERNOS);
  if (existsSync(arquivo)) linhas.push(...readFileSync(arquivo, "utf8").split("\n"));
  return linhas
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l, i) => {
      try {
        return new RegExp(l, "i");
      } catch {
        // sem repetir a mensagem do V8: ela inclui o regex inteiro, que não pode ir para um log público
        throw new Error(`check-no-real-hosts: padrão externo ${i + 1} inválido`);
      }
    });
}

/** Procura violações em um texto. `padroes` são os regex externos. Exportada para o teste. */
export function acharViolacoes(texto, arquivo = "", padroes = []) {
  const out = [];
  texto.split("\n").forEach((linha, i) => {
    const onde = `${arquivo}:${i + 1}`;
    for (const m of linha.matchAll(RE_SUBDOMINIO)) out.push(`${onde}  subdomínio real: ${m[0]}`);
    for (const m of linha.matchAll(RE_EMAIL)) {
      if (!EMAILS_PERMITIDOS.has(m[0].toLowerCase())) out.push(`${onde}  e-mail real: ${m[0]}`);
    }
    for (const m of linha.matchAll(RE_VMI)) if (!VMI_PERMITIDOS.has(m[0].toLowerCase())) out.push(`${onde}  hostname de provedor: ${m[0]}`);
    for (const m of linha.matchAll(RE_IPV6)) {
      if (!ipv6Permitido(m[0])) out.push(`${onde}  IPv6 público: ${m[0]}`);
    }
    padroes.forEach((re, n) => {
      if (re.test(linha)) out.push(`${onde}  padrão externo nº ${n + 1}`);
    });
    for (const re of [RE_IPV4, RE_IPV4_HIFEN]) {
      for (const m of linha.matchAll(re)) {
        const o = [m[1], m[2], m[3], m[4]].map(Number);
        if (!ipPermitido(o.join("."), o)) out.push(`${onde}  IPv4 público: ${m[0]}`);
      }
    }
  });
  return out;
}

const PASTAS_IGNORADAS = new Set([".git", "node_modules", "dist", "coverage", "build", ".astro", ".turbo"]);

function listarPorGit(raiz) {
  // num worktree o hook herda GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE: o git olharia outro repositório
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY)$/.test(k)) delete env[k];
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: raiz,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);
}

function listarPorArvore(raiz, rel = "") {
  const out = [];
  for (const e of readdirSync(resolve(raiz, rel), { withFileTypes: true })) {
    const caminho = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!PASTAS_IGNORADAS.has(e.name)) out.push(...listarPorArvore(raiz, caminho));
    } else if (e.isFile()) out.push(caminho);
  }
  return out;
}

/** Lista de arquivos do repositório; no CI, a ausência do git é erro, para a checagem não sumir em silêncio. */
function listarArquivos(raiz, ci) {
  try {
    return listarPorGit(raiz);
  } catch (err) {
    if (ci) throw new Error(`check-no-real-hosts: git indisponível no CI (${err.message})`);
    return listarPorArvore(raiz);
  }
}

/**
 * Varre os arquivos do repositório. Usa a lista de arquivos rastreados; sem git/.git (tarball, ZIP do
 * GitHub, container) percorre a árvore ignorando node_modules, dist, coverage e .git. No CI
 * (`ci: true`, por padrão process.env.CI) a ausência do git é erro, para a checagem não sumir em silêncio.
 */
export function varrerRepositorio(raiz = RAIZ, { ci = Boolean(process.env.CI), padroes = carregarPadroesExternos(raiz) } = {}) {
  const lista = listarArquivos(raiz, ci);
  const out = [];
  for (const f of lista) {
    if (IGNORADOS.has(f)) continue;
    if (padroes.length) {
      // o caminho também conta (nome de arquivo com o nome de um cliente)
      padroes.forEach((re, n) => {
        if (re.test(f)) out.push(`${f}  nome do arquivo: padrão externo nº ${n + 1}`);
      });
    }
    let buf;
    try {
      buf = readFileSync(resolve(raiz, f));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binário
    out.push(...acharViolacoes(buf.toString("utf8"), f, padroes));
  }
  return out;
}

/**
 * Imagens versionadas cujo hash não está em scripts/imagens-revisadas.txt: ninguém marcou que olhou o
 * conteúdo. Devolve { caminho, hash }. Não reprova; é só aviso.
 */
export function imagensSemRevisao(raiz = RAIZ, { ci = Boolean(process.env.CI) } = {}) {
  const arquivo = resolve(raiz, ARQUIVO_IMAGENS_REVISADAS);
  const revisados = new Set(
    existsSync(arquivo)
      ? readFileSync(arquivo, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split(/\s+/)[0])
      : [],
  );
  const out = [];
  for (const f of listarArquivos(raiz, ci).filter((x) => IMAGENS.test(x))) {
    let hash;
    try {
      hash = createHash("sha256").update(readFileSync(resolve(raiz, f))).digest("hex");
    } catch {
      continue;
    }
    if (!revisados.has(hash)) out.push({ caminho: f, hash });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let v;
  let imgs;
  try {
    v = varrerRepositorio();
    imgs = imagensSemRevisao();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (process.argv.includes("--hash-imagens")) {
    for (const i of imgs) console.log(`${i.hash}  ${i.caminho}`);
    process.exit(0);
  }
  for (const i of imgs) {
    const msg = `imagem sem marcação de revisão: ${i.caminho} (confira se não mostra IP, hostname ou nome de cliente e registre o hash em ${ARQUIVO_IMAGENS_REVISADAS})`;
    console.warn(process.env.GITHUB_ACTIONS ? `::warning file=${i.caminho}::${msg}` : `aviso: ${msg}`);
  }
  if (v.length) {
    console.error(`Domínios, IPs ou nomes reais encontrados (${v.length}):\n` + v.join("\n"));
    process.exit(1);
  }
  console.log("check-no-real-hosts: ok");
}
