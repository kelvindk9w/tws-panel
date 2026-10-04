/**
 * compose-override.test.ts — o arquivo complementar que o painel gera para o
 * compose adotado (paas.override.yml): rede do painel, env injetada e, para
 * app comum, a retirada das portas 80/443 (`ports: !override`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeOverrideYaml } from "../src/compose-override.js";

const APP = `services:
  web:
    image: nginx:1.27
    ports:
      - "80:80"
      - "127.0.0.1:8010:8010"
  worker:
    image: app:1
`;

describe("composeOverrideYaml", () => {
  it("liga o serviço web à rede do painel com o slug como alias", () => {
    const doc = parse(composeOverrideYaml({ compose: APP, proxyService: "web", slug: "loja", network: "paas-net" }));
    expect(doc.networks).toEqual({ "paas-net": { external: true } });
    expect(doc.services.web.networks).toEqual({ default: null, "paas-net": { aliases: ["loja"] } });
  });

  it("app comum: troca a lista de portas por uma sem 80/443 (tag !override)", () => {
    const out = composeOverrideYaml({ compose: APP, proxyService: "web", slug: "loja", network: "paas-net" });
    expect(out).toMatch(/ports: !override\n\s+- 127\.0\.0\.1:8010:8010/);
    expect(out).not.toMatch(/"?80:80/);
  });

  it("projeto com proxy HTTPS próprio: não mexe nas portas (o guardrail bloqueia)", () => {
    const compose = `services:\n  edge:\n    image: caddy:2\n    ports: ["80:80", "443:443"]\n`;
    const out = composeOverrideYaml({ compose, proxyService: "edge", slug: "x", network: "paas-net" });
    expect(out).not.toMatch(/!override/);
  });

  it("injeta a env extra nos serviços indicados, sem perder a rede do web", () => {
    const doc = parse(
      composeOverrideYaml({
        compose: APP,
        proxyService: "web",
        slug: "loja",
        network: "paas-net",
        env: { SMTP_HOST: "mail" },
        envServices: ["web", "worker"],
      }),
    );
    expect(doc.services.worker.environment).toEqual({ SMTP_HOST: "mail" });
    expect(doc.services.web.environment).toEqual({ SMTP_HOST: "mail" });
    expect(doc.services.web.networks["paas-net"]).toEqual({ aliases: ["loja"] });
  });

  it("aplica as trocas de porta do painel junto com a retirada de 80/443", () => {
    const out = composeOverrideYaml({
      compose: APP,
      proxyService: "web",
      slug: "loja",
      network: "paas-net",
      portOverrides: { web: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" }] },
    });
    expect(out).toMatch(/ports: !override\n\s+- 0\.0\.0\.0:18010:8010/);
    expect(out).not.toContain("127.0.0.1:8010:8010");
  });

  it("publicação removida vira lista vazia com !override", () => {
    const compose = `services:\n  web:\n    image: a\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n`;
    const out = composeOverrideYaml({
      compose,
      proxyService: "web",
      slug: "loja",
      network: "paas-net",
      portOverrides: { db: [{ original: "5432:5432", hostPort: null, hostIp: null }] },
    });
    expect(out).toMatch(/db:\n\s+ports: !override \[\]/);
  });

  it("o docker compose aceita o resultado e fica só com a porta local", () => {
    let hasCompose = true;
    try {
      execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    } catch {
      hasCompose = false;
    }
    if (!hasCompose) return;
    const dir = mkdtempSync(path.join(tmpdir(), "paas-ovr-"));
    writeFileSync(path.join(dir, "compose.yml"), APP);
    writeFileSync(
      path.join(dir, "o.yml"),
      composeOverrideYaml({ compose: APP, proxyService: "web", slug: "loja", network: "paas-net" }),
    );
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "o.yml", "config", "--format", "json"], {
      cwd: dir,
      env: { ...process.env, DOCKER_CONFIG: dir },
    }).toString();
    const ports = JSON.parse(out).services.web.ports as Array<{ published: string; target: number }>;
    expect(ports.map((p) => `${p.published}:${p.target}`)).toEqual(["8010:8010"]);
  });
});
