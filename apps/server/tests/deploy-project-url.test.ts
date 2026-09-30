/**
 * deploy-project-url.test.ts — o link "Abrir site" do projeto. Validação real:
 * o link saía como http:// mesmo com o Caddy servindo HTTPS automático.
 */
import { describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

function svc(http: number, https: number) {
  return new DeployService({ dataDir: "/tmp/nao-usado", projectsDir: "/tmp/nao-usado/p", caddyHttpPort: http, caddyHttpsPort: https, panelDomain: null, port: 9000 } as unknown as ServerConfig);
}

const p = (domain: string) => ({ domain }) as Project;

describe("DeployService.projectUrl", () => {
  it("domínio público → https", () => {
    expect(svc(80, 443).projectUrl(p("devlink.203-0-113-10.sslip.io"))).toBe("https://devlink.203-0-113-10.sslip.io");
  });
  it("porta HTTPS diferente de 443 entra no link", () => {
    expect(svc(8080, 8443).projectUrl(p("loja.exemplo.com"))).toBe("https://loja.exemplo.com:8443");
  });
  it(".localhost (desenvolvimento) continua em http, com a porta quando não é 80", () => {
    expect(svc(80, 443).projectUrl(p("site.localhost"))).toBe("http://site.localhost");
    expect(svc(8080, 8443).projectUrl(p("site.localhost"))).toBe("http://site.localhost:8080");
  });
});
