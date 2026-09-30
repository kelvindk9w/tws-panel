/**
 * health-check-target.test.ts — onde o deploy confere se o site respondeu.
 *
 * Validação real (30/09/2026): o site estava no ar, mas o deploy saiu como
 * "falhou": o health check batia em 127.0.0.1:80 DE DENTRO do container do
 * painel, onde não há proxy nenhum (o Caddy escuta nas portas da VPS). Com o
 * painel em container, o caminho é a rede interna: paas-caddy:80 e :443.
 */
import { describe, expect, it } from "vitest";
import { healthCheckTarget, type EngineContext } from "../src/engine.js";

const base = { caddyHttpPort: 8080, caddyHttpsPort: 8443 } as EngineContext;

describe("healthCheckTarget", () => {
  it("painel em container: fala com o Caddy pela rede interna, nas portas internas dele", () => {
    expect(healthCheckTarget({ ...base, panelContainer: "tws-panel" })).toEqual({
      host: "paas-caddy",
      httpPort: 80,
      httpsPort: 443,
    });
  });

  it("painel fora de container (desenvolvimento): portas do Caddy nesta máquina", () => {
    expect(healthCheckTarget(base)).toEqual({ host: "127.0.0.1", httpPort: 8080, httpsPort: 8443 });
  });
});
