/**
 * proxy-ports.test.ts — portas 80/443 publicadas pelo projeto (validação real).
 *
 * O painel não escreve no repositório (só leitura), mas o arquivo complementar
 * que ele gera pode TROCAR a lista de portas de um serviço (`ports: !override`,
 * docker compose ≥ 2.24): o app comum que publica "80:80" passa a receber pela
 * rede interna. Projeto com proxy HTTPS PRÓPRIO (Caddy/Traefik) continua
 * bloqueado: sem as portas, o HTTPS dele brigaria com o do painel.
 */
import { describe, expect, it } from "vitest";
import { hasOwnHttpsProxy, portsWithoutProxyPorts } from "../src/proxy-ports.js";

const APP = `services:
  web:
    image: nginx:1.27
    ports:
      - "80:80"
      - "443:443"
      - "127.0.0.1:8010:8010"
  api:
    image: app:1
    ports:
      - target: 80
        published: 80
  outro:
    image: app:1
    ports:
      - "8081:80"
`;

describe("portsWithoutProxyPorts", () => {
  it("devolve, por serviço, a lista de portas sem 80/443 do host (o resto fica)", () => {
    expect(portsWithoutProxyPorts(APP)).toEqual({
      web: ["127.0.0.1:8010:8010"],
      api: [],
    });
  });
});

describe("hasOwnHttpsProxy", () => {
  it("Caddy/Traefik no próprio serviço ou no namespace dele → proxy HTTPS próprio", () => {
    expect(hasOwnHttpsProxy(`services:\n  edge:\n    image: caddy:2-alpine\n    ports: ["80:80"]\n`, "edge")).toBe(true);
    expect(
      hasOwnHttpsProxy(
        `services:\n  wallet:\n    build: .\n    ports: ["80:80"]\n  caddy:\n    image: caddy:2\n    network_mode: service:wallet\n`,
        "wallet",
      ),
    ).toBe(true);
    expect(hasOwnHttpsProxy(APP, "web")).toBe(false);
  });
});
