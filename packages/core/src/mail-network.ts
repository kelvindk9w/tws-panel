/**
 * Rede de e-mail de cada projeto e quais serviços dele entram nela (e recebem o SMTP_*).
 *
 * Cada projeto com e-mail tem a SUA rede de e-mail (`paas-mail-<slug>`, interna, sem saída, com sub-rede pequena tirada
 * da faixa reservada do painel), criada pelo painel no deploy. O servidor de e-mail (Stalwart) entra em todas elas com
 * os mesmos nomes (paas-stalwart e mail.<domínio>), então o SMTP_HOST injetado não muda; os serviços de um projeto só
 * entram na dele. Dois projetos nunca dividem uma rede de e-mail: um container comprometido num projeto não alcança o
 * php-fpm, o nginx ou os workers de outro por ela. A `paas-mail` fica só com o Stalwart (instalações antigas tinham
 * nela os serviços de todos os projetos; a migração a esvazia) e o webmail tem a dele (`paas-mailweb`). A caixa de
 * teste (Mailpit) já tinha uma rede por projeto (`paas-mailtest-<slug>`).
 *
 * Banco e cache não enviam e-mail: mesmo na rede do próprio projeto, ficam de fora os serviços de imagem de banco/cache
 * reconhecida (ou cujo Dockerfile parte de uma), para o banco não ficar ao alcance do servidor de e-mail.
 *
 * Saída de emergência, por serviço, com a label `tws.mail` (no compose: `labels: ["tws.mail=true"]`):
 *  - `true`: entra mesmo sendo de imagem de banco (um serviço que de fato envia e-mail);
 *  - `false`: nunca entra, mesmo não sendo de banco.
 */
import { PAAS_MAIL_ADMIN_NETWORK, PAAS_MAIL_NETWORK } from "./deploy";
import { isDatabaseImage } from "./timezone";

export const TWS_LABEL_MAIL = "tws.mail";

/** Prefixo da rede de e-mail de cada projeto (`paas-mail-<slug>`). */
export const PAAS_MAIL_PROJECT_NETWORK_PREFIX = "paas-mail-";
/** Label que o painel grava na rede de e-mail de um projeto (valor = slug): é por ela que o Stalwart acha as redes. */
export const PAAS_LABEL_MAIL_PROJECT = "paas.mail.project";

const MAIL_PROJECT_SLUG = /^[a-z0-9-]{1,63}$/;
/** Sufixos de redes fixas do painel com o mesmo prefixo (paas-mail-admin): o slug igual ganha `--` (slugify nunca gera). */
const PANEL_MAIL_SUFFIXES = new Set([PAAS_MAIL_ADMIN_NETWORK.slice(PAAS_MAIL_PROJECT_NETWORK_PREFIX.length)]);

/**
 * Nome da rede de e-mail do projeto. O slug vira argumento do docker (sem shell): só passa a allowlist estrita
 * (minúsculas, dígitos e hífen). Um slug que formaria o nome de uma rede fixa do painel (`admin` → paas-mail-admin, a
 * da administração do Stalwart) ganha um hífen a mais (`paas-mail--admin`): o slugify do painel nunca gera `--`, então
 * nenhum outro projeto forma esse nome.
 */
export function projectMailNetworkName(slug: string): string {
  if (!MAIL_PROJECT_SLUG.test(slug)) throw new Error("slug inválido para a rede de e-mail do projeto");
  return PANEL_MAIL_SUFFIXES.has(slug) ? `${PAAS_MAIL_PROJECT_NETWORK_PREFIX}-${slug}` : `${PAAS_MAIL_PROJECT_NETWORK_PREFIX}${slug}`;
}

/** É o nome de uma rede de e-mail de projeto (`paas-mail-<slug>`; nunca a paas-mail-admin nem rede de compose, que tem `_`). */
export function isProjectMailNetworkName(name: string): boolean {
  if (!name.startsWith(PAAS_MAIL_PROJECT_NETWORK_PREFIX) || name === PAAS_MAIL_ADMIN_NETWORK) return false;
  return /^-?[a-z0-9-]{1,63}$/.test(name.slice(PAAS_MAIL_PROJECT_NETWORK_PREFIX.length));
}

/**
 * Rede de e-mail do painel, de qualquer tipo: a paas-mail, a da administração, a do webmail, a de cada projeto e as da
 * caixa de teste (`paas-mailtest*`). Nenhum compose de projeto declara nem liga um serviço a uma delas: só o override
 * do painel liga os serviços do próprio projeto à rede dele. Rede criada por compose sempre tem `_`
 * (`paas-mailer_default`, de um projeto de slug "mailer") e nunca é do painel.
 */
export function isPanelMailNetworkName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.startsWith(PAAS_MAIL_NETWORK) && /^[a-z0-9-]+$/.test(n);
}

// ---------------------------------------------------------------------------
// Sub-rede da rede de e-mail de cada projeto
// ---------------------------------------------------------------------------

/**
 * Faixa reservada do painel para as redes de e-mail dos projetos. Cada rede ganha um bloco /26 dela (62 endereços:
 * gateway, Stalwart e até 60 containers do projeto — réplicas e a troca sem queda contam) — 1024 blocos numa /16. Um bloco
 * pequeno demais faria o `compose up` de um projeto grande parar no meio por falta de endereço. Sem sub-rede explícita, cada rede comeria
 * um bloco do espaço padrão do Docker, que acaba por volta de 30 redes (e aí nenhum `docker network create` nem
 * `compose up` de projeto novo sobe). Trocável por `PAAS_MAIL_SUBNET_POOL` (ex.: a VPS já usa essa faixa).
 */
export const MAIL_SUBNET_POOL_DEFAULT = "10.213.0.0/16";
export const MAIL_SUBNET_PREFIX = 26;

/** CIDR IPv4 → base (inteiro sem sinal, já alinhado) e tamanho; null = não é IPv4 válido. */
export function parseIpv4Cidr(cidr: string): { base: number; bits: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const ip = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits };
}

const formatIpv4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** Duas faixas IPv4 se sobrepõem (texto que não é CIDR IPv4 nunca sobrepõe). */
export function ipv4CidrsOverlap(a: string, b: string): boolean {
  const x = parseIpv4Cidr(a);
  const y = parseIpv4Cidr(b);
  if (!x || !y) return false;
  const size = (c: { bits: number }) => 2 ** (32 - c.bits);
  return x.base < y.base + size(y) && y.base < x.base + size(x);
}

/** Faixa privada (10/8, 172.16/12, 192.168/16) e grande o bastante para um bloco /26. */
function isUsablePool(c: { base: number; bits: number }): boolean {
  if (c.bits > MAIL_SUBNET_PREFIX) return false;
  const inside = (net: string) => {
    const p = parseIpv4Cidr(net)!;
    return c.bits >= p.bits && ipv4CidrsOverlap(`${formatIpv4(c.base)}/${c.bits}`, net);
  };
  return inside("10.0.0.0/8") || inside("172.16.0.0/12") || inside("192.168.0.0/16");
}

/** Faixa das redes de e-mail dos projetos: a de `PAAS_MAIL_SUBNET_POOL` se for IPv4 privada e /26 ou maior; senão a padrão. */
export function mailSubnetPool(raw?: string | null): string {
  const c = raw ? parseIpv4Cidr(raw) : null;
  return c && isUsablePool(c) ? `${formatIpv4(c.base)}/${c.bits}` : MAIL_SUBNET_POOL_DEFAULT;
}

/**
 * Bloco /26 da rede de e-mail de um projeto: começa num bloco tirado do slug (o mesmo projeto tende a cair no mesmo
 * bloco, de instalação em instalação) e anda até o primeiro que não se sobrepõe a nenhuma sub-rede já usada por uma
 * rede Docker (`used`). null = faixa cheia.
 */
export function allocateMailSubnet(slug: string, used: readonly string[], pool: string = MAIL_SUBNET_POOL_DEFAULT): string | null {
  const range = parseIpv4Cidr(mailSubnetPool(pool))!;
  const count = 2 ** (MAIL_SUBNET_PREFIX - range.bits);
  const size = 2 ** (32 - MAIL_SUBNET_PREFIX);
  let hash = 0x811c9dc5;
  for (const ch of slug) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const start = hash % count;
  for (let i = 0; i < count; i++) {
    const block = `${formatIpv4((range.base + ((start + i) % count) * size) >>> 0)}/${MAIL_SUBNET_PREFIX}`;
    if (!used.some((u) => ipv4CidrsOverlap(block, u))) return block;
  }
  return null;
}
/**
 * Carimbo que o painel grava (pelo override) em cada serviço de um projeto com e-mail: `in` = ligado à rede de e-mail,
 * `out` = deixado de fora. É o que decide o que fazer com o container já rodando, sem recalcular a regra.
 */
export const TWS_LABEL_MAIL_DECIDED = "tws.mail.decided";

/** Valor reconhecido da label `tws.mail` (true/false, sem diferenciar maiúsculas); null = outro valor. */
export function mailLabelValue(label: string | null | undefined): "true" | "false" | null {
  const v = label?.trim().toLowerCase();
  return v === "true" || v === "false" ? v : null;
}

export type MailExclusionReason = "database-image" | "database-build" | "label" | "shared-network";

export interface MailServiceDecision {
  include: boolean;
  /** Presente só quando excluído. */
  reason?: MailExclusionReason;
  /** A label `tws.mail=true` incluiu um serviço que seria excluído. */
  forced?: boolean;
  /** Imagem (ou imagem-base do Dockerfile) que causou a exclusão. */
  image?: string;
}

export interface MailServiceInput {
  image?: string | null;
  /** Imagem do estágio final do Dockerfile do serviço (serviço com `build:`). */
  buildBase?: string | null;
  /** Valor da label `tws.mail`. */
  label?: string | null;
}

export function mailServiceDecision(input: MailServiceInput): MailServiceDecision {
  const label = mailLabelValue(input.label);
  if (label === "false") return { include: false, reason: "label" };
  const isDb = isDatabaseImage(input.image);
  const isDbBuild = !isDb && isDatabaseImage(input.buildBase);
  if (!isDb && !isDbBuild) return { include: true };
  if (label === "true") return { include: true, forced: true };
  return isDb
    ? { include: false, reason: "database-image", image: input.image!.trim() }
    : { include: false, reason: "database-build", image: input.buildBase!.trim() };
}

/** Texto do motivo para o log de deploy. */
export function mailExclusionText(d: MailServiceDecision): string {
  if (d.reason === "label") return `label ${TWS_LABEL_MAIL}=false`;
  if (d.reason === "shared-network") return `usa a rede de ${d.image} (network_mode), que fica fora da rede de e-mail; ponha ${TWS_LABEL_MAIL}=true em ${d.image} para ligar os dois`;
  if (d.reason === "database-build") return `Dockerfile parte da imagem de banco/cache ${d.image}`;
  return `imagem de banco/cache ${d.image}`;
}
