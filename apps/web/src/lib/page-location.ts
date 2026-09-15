/**
 * Endereço com que a página foi aberta. Isolado num módulo próprio para que
 * os testes possam simular acesso por IP/http (o jsdom sempre roda em
 * http://localhost e não deixa trocar window.location).
 */
import type { PageLocationLike } from "@/lib/terminal-info";

export function pageLocation(): PageLocationLike {
  return { protocol: window.location.protocol, hostname: window.location.hostname };
}
