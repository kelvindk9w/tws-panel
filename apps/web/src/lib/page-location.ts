/**
 * Endereço com que a página foi aberta. Isolado num módulo próprio para que
 * os testes possam simular acesso por IP/http (o jsdom sempre roda em
 * http://localhost e não deixa trocar window.location).
 */
import type { PageLocationLike } from "@/lib/terminal-info";

export function pageLocation(): PageLocationLike {
  return {
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    port: window.location.port,
    pathname: window.location.pathname,
    // A query carrega o setup token: o endereço equivalente em localhost
    // precisa mantê-la, senão o painel abre no túnel sem token nenhum.
    search: window.location.search,
  };
}
