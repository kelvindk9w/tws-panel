#!/usr/bin/env node
/**
 * check-no-real-hosts.mjs — falha se domínios ou IPs reais voltarem ao repositório.
 *
 * Varre os arquivos do repositório e reprova:
 *   - qualquer coisa.tws.tec.br (subdomínio, curinga, sublinhado);
 *   - e-mails @tws.tec.br que não sejam o contato oficial;
 *   - IPv4 público que não esteja na lista de exceções abaixo, inclusive embutido
 *     em nomes sslip.io/nip.io (203.0.113.10.sslip.io e 203-0-113-10.sslip.io).
 *
 * Uso: node scripts/check-no-real-hosts.mjs   (sai com código 1 se achar algo)
 * CI: adicionar a etapa `node scripts/check-no-real-hosts.mjs` ao workflow.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESTE_ARQUIVO = "scripts/check-no-real-hosts.mjs";
const IGNORADOS = new Set(["pnpm-lock.yaml", ESTE_ARQUIVO]);

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

// Um IPv4 isolado: sem dígito colado nos lados e sem um quinto grupo (versões como 1.2.3.4.5).
// Ponto final de frase ("o IP é X.Y.Z.W.") e reticências ("...X.Y.Z.W") não impedem a detecção.
const RE_IPV4 = /(?<!\d|\d\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
// DNS curinga que embute o IP com hífens (203-0-113-10.sslip.io), com ou sem prefixo
// (app-203-0-113-10.nip.io, www.app-203-0-113-10.traefik.me).
const RE_IPV4_HIFEN = /(?<!\d)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?=\.(?:(?:sslip|nip)\.io|traefik\.me)\b)/gi;
// Qualquer coisa antes de ".tws.tec.br": subdomínio, curinga (*), sublinhado, ou nada.
const RE_SUBDOMINIO = /[\w*.-]*\.tws\.tec\.br\b/gi;
const RE_EMAIL = /\b[\w.+-]+@tws\.tec\.br\b/gi;

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

/** Procura violações em um texto. Exportada para o teste. */
export function acharViolacoes(texto, arquivo = "") {
  const out = [];
  texto.split("\n").forEach((linha, i) => {
    const onde = `${arquivo}:${i + 1}`;
    for (const m of linha.matchAll(RE_SUBDOMINIO)) out.push(`${onde}  subdomínio real: ${m[0]}`);
    for (const m of linha.matchAll(RE_EMAIL)) {
      if (!EMAILS_PERMITIDOS.has(m[0].toLowerCase())) out.push(`${onde}  e-mail real: ${m[0]}`);
    }
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

/**
 * Varre os arquivos do repositório. Usa a lista de arquivos rastreados; sem git/.git (tarball, ZIP do
 * GitHub, container) percorre a árvore ignorando node_modules, dist, coverage e .git. No CI
 * (`ci: true`, por padrão process.env.CI) a ausência do git é erro, para a checagem não sumir em silêncio.
 */
export function varrerRepositorio(raiz = RAIZ, { ci = Boolean(process.env.CI) } = {}) {
  let lista;
  try {
    lista = listarPorGit(raiz);
  } catch (err) {
    if (ci) throw new Error(`check-no-real-hosts: git indisponível no CI (${err.message})`);
    lista = listarPorArvore(raiz);
  }
  const out = [];
  for (const f of lista) {
    if (IGNORADOS.has(f)) continue;
    let buf;
    try {
      buf = readFileSync(resolve(raiz, f));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binário
    out.push(...acharViolacoes(buf.toString("utf8"), f));
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let v;
  try {
    v = varrerRepositorio();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (v.length) {
    console.error(`Domínios ou IPs reais encontrados (${v.length}):\n` + v.join("\n"));
    process.exit(1);
  }
  console.log("check-no-real-hosts: ok");
}
