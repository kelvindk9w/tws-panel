/**
 * proxy-ports.ts — portas 80/443 do servidor publicadas pelo compose adotado.
 *
 * 80 e 443 são do proxy do painel (Caddy central). O painel só LÊ o
 * repositório, mas o arquivo complementar que ele gera pode trocar a lista de
 * portas de um serviço (tag `!override`, docker compose ≥ 2.24): o app comum
 * que publica "80:80" deixa de disputar a porta e recebe o tráfego pela rede
 * interna. Projeto com proxy HTTPS PRÓPRIO (Caddy/Traefik) não entra nessa
 * retirada: sem as portas, o HTTPS dele e o do painel brigariam pelo mesmo
 * domínio — esse caso continua bloqueado (rules.ts) e pede um compose.paas.
 */
import { parse } from "yaml";
import { publishedPorts } from "./compose-ports.js";

interface Service {
  image?: unknown;
  ports?: unknown;
  network_mode?: unknown;
}

function servicesOf(content: string): Record<string, Service> {
  const doc = parse(content) as { services?: Record<string, Service> } | null;
  return doc?.services && typeof doc.services === "object" ? doc.services : {};
}

const HTTPS_PROXY_IMAGE = /^(?:[^/]+\/)*(caddy|traefik)(?::|@|$)/i;

function isHttpsProxy(svc: Service | undefined): boolean {
  return typeof svc?.image === "string" && HTTPS_PROXY_IMAGE.test(svc.image);
}

function isProxyPortEntry(entry: unknown): boolean {
  return publishedPorts([entry]).some((p) => p.host.kind === "fixed" && (p.host.port === 80 || p.host.port === 443));
}

/**
 * O serviço é (ou divide a rede com) um proxy HTTPS próprio: a imagem dele é
 * Caddy/Traefik, ou um Caddy/Traefik roda no namespace de rede dele
 * (`network_mode: service:<nome>`), ou ele roda no namespace de um.
 */
export function hasOwnHttpsProxy(content: string, service: string): boolean {
  const services = servicesOf(content);
  const svc = services[service];
  if (isHttpsProxy(svc)) return true;
  const owner = typeof svc?.network_mode === "string" ? /^service:(.+)$/.exec(svc.network_mode)?.[1] : undefined;
  if (owner && isHttpsProxy(services[owner])) return true;
  return Object.values(services).some((s) => s?.network_mode === `service:${service}` && isHttpsProxy(s));
}

/**
 * Por serviço que publica 80/443 fixas no host: a lista de portas sem elas
 * (entradas como escritas no compose). Serviços sem 80/443 não aparecem.
 */
export function portsWithoutProxyPorts(content: string): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [name, svc] of Object.entries(servicesOf(content))) {
    const ports = Array.isArray(svc?.ports) ? svc.ports : [];
    if (!ports.some(isProxyPortEntry)) continue;
    result[name] = ports.filter((p) => !isProxyPortEntry(p));
  }
  return result;
}
