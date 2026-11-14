/**
 * Rede do proxy de cada projeto.
 *
 * Antes, todo projeto que recebe tráfego tinha o serviço web na `paas-net`, a rede do Caddy, dividida por todos: por
 * ela um projeto alcançava o container web de qualquer outro (o nginx/php-fpm do vizinho, sem passar pelo Caddy).
 * Agora cada projeto tem a SUA rede do proxy (`paas-proxy-<slug>`), com uma sub-rede pequena da faixa reservada do
 * painel; nela ficam só o serviço web do projeto (com o apelido `<slug>`, que é o upstream do Caddy) e o Caddy, que
 * entra em todas. A `paas-net` fica só com o Caddy (instalações antigas tinham nela os projetos; a migração a esvazia).
 *
 * NÃO é interna (`--internal`): nos projetos de um container só (site estático, Dockerfile, Next.js com servidor) ela é
 * a única rede do container, e é por ela que o app sai para a internet (APIs, banco externo). Isolamento entre
 * projetos não depende disso: o Docker não encaminha tráfego entre redes bridge diferentes.
 */
import { MAIL_SUBNET_PREFIX, allocateProjectSubnet, parseIpv4Cidr, projectSubnetPool } from "./mail-network";

/** Prefixo da rede do proxy de cada projeto (`paas-proxy-<slug>`). */
export const PAAS_PROXY_PROJECT_NETWORK_PREFIX = "paas-proxy-";
/** Label que o painel grava na rede do proxy de um projeto (valor = slug): é por ela que o Caddy acha as redes. */
export const PAAS_LABEL_PROXY_PROJECT = "paas.proxy.project";

const PROXY_PROJECT_SLUG = /^[a-z0-9-]{1,63}$/;

/**
 * Nome da rede do proxy do projeto. O slug vira argumento do docker (sem shell): só passa a allowlist estrita
 * (minúsculas, dígitos e hífen). Nenhuma rede fixa do painel começa com `paas-proxy-`, e rede criada por compose
 * sempre tem `_` (`paas-proxy-x_default`, de um projeto de slug "proxy-x"): nenhum outro nome colide.
 */
export function projectProxyNetworkName(slug: string): string {
  if (!PROXY_PROJECT_SLUG.test(slug)) throw new Error("slug inválido para a rede do proxy do projeto");
  return `${PAAS_PROXY_PROJECT_NETWORK_PREFIX}${slug}`;
}

/** É o nome de uma rede do proxy de projeto (`paas-proxy-<slug>`; nunca rede de compose, que tem `_`). */
export function isProjectProxyNetworkName(name: string): boolean {
  return name.startsWith(PAAS_PROXY_PROJECT_NETWORK_PREFIX) && PROXY_PROJECT_SLUG.test(name.slice(PAAS_PROXY_PROJECT_NETWORK_PREFIX.length));
}

/**
 * Faixa reservada do painel para as redes do proxy dos projetos: cada rede ganha um bloco /26 (62 endereços: gateway,
 * Caddy, o serviço web e as réplicas dele, a versão nova da troca sem queda e a anterior guardada) — 1024 blocos numa
 * /16. Sem sub-rede explícita cada rede comeria um bloco do espaço padrão do Docker, que acaba por volta de 30 redes
 * (e aí nenhum `docker network create` nem `compose up` de projeto novo sobe). Fica ao lado da faixa do e-mail
 * (10.213.0.0/16), fora das faixas que o Docker usa por padrão (172.17–31, 192.168). Trocável por
 * `PAAS_PROXY_SUBNET_POOL` (ex.: a VPS já usa essa faixa).
 */
export const PROXY_SUBNET_POOL_DEFAULT = "10.214.0.0/16";
export const PROXY_SUBNET_PREFIX = MAIL_SUBNET_PREFIX;

/** Faixa das redes do proxy: a de `PAAS_PROXY_SUBNET_POOL` se for IPv4 privada e /26 ou maior; senão a padrão. */
export function proxySubnetPool(raw?: string | null): string {
  return projectSubnetPool(raw, PROXY_SUBNET_POOL_DEFAULT);
}

/** Bloco /26 da rede do proxy de um projeto, sem colidir com nenhuma sub-rede já usada (`used`). null = faixa cheia. */
export function allocateProxySubnet(slug: string, used: readonly string[], pool: string = PROXY_SUBNET_POOL_DEFAULT): string | null {
  return allocateProjectSubnet(slug, used, proxySubnetPool(pool));
}

const formatIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * Endereço FIXO do Caddy na rede do proxy de um projeto: o base+2 do bloco (base+1 é o gateway), na metade de baixo,
 * fora da faixa dos endereços automáticos (proxyIpRange). Fixo para PAAS_PROXY_IP não mudar quando o Caddy é
 * recriado. null = sub-rede que não se lê ou pequena demais (menor que /29).
 */
export function proxyCaddyAddress(subnet: string): string | null {
  const c = parseIpv4Cidr(subnet);
  if (!c || c.bits > 29) return null;
  return formatIp((c.base + 2) >>> 0);
}

/**
 * Faixa de onde o Docker tira os endereços automáticos da rede do proxy (`--ip-range`): a metade de cima da
 * sub-rede. A metade de baixo fica para o gateway e o endereço fixo do Caddy, que assim nunca é tomado por um
 * container do projeto (nem quando o Caddy sai e volta). Limite: num bloco /26 sobram ~30 endereços automáticos
 * por rede do proxy — o bastante para o serviço web, as réplicas dele e os containers da troca sem queda (só o
 * serviço web de cada projeto entra nessa rede). null = sub-rede que não se lê ou pequena demais.
 */
export function proxyIpRange(subnet: string): string | null {
  const c = parseIpv4Cidr(subnet);
  if (!c || c.bits > 29) return null;
  const half = 2 ** (32 - c.bits - 1);
  return `${formatIp((c.base + half) >>> 0)}/${c.bits + 1}`;
}
