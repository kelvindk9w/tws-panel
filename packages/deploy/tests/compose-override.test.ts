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
import { composeOverrideYaml, mailNetworkTargets } from "../src/compose-override.js";

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

  it("publicação adicionada no painel: entra na lista !override do serviço, mesmo sem ports no compose", () => {
    const compose = `services:\n  web:\n    image: a\n  db:\n    image: postgres:16\n`;
    const doc = parse(
      composeOverrideYaml({
        compose,
        proxyService: "web",
        slug: "loja",
        network: "paas-net",
        portOverrides: {
          db: [{ original: "+127.0.0.1:15432:5432", hostPort: 15432, hostIp: "127.0.0.1", added: { containerPort: 5432, protocol: "tcp" } }],
        },
      }),
    );
    expect(doc.services.db.ports).toEqual(["127.0.0.1:15432:5432"]);
  });

  it("lote: trocas, remoção e adicionadas de vários serviços no mesmo arquivo", () => {
    const out = composeOverrideYaml({
      compose: APP,
      proxyService: "web",
      slug: "loja",
      network: "paas-net",
      portOverrides: {
        web: [
          { original: "127.0.0.1:8010:8010", hostPort: null, hostIp: null },
          { original: "+0.0.0.0:18080:8080", hostPort: 18080, hostIp: "0.0.0.0", added: { containerPort: 8080, protocol: "tcp" } },
        ],
        worker: [{ original: "+127.0.0.1:19000:9000", hostPort: 19000, hostIp: "127.0.0.1", added: { containerPort: 9000, protocol: "tcp" } }],
      },
    });
    expect(out).toMatch(/web:[\s\S]*ports: !override\n\s+- 0\.0\.0\.0:18080:8080\n/);
    expect(out).toMatch(/worker:\n\s+ports: !override\n\s+- 127\.0\.0\.1:19000:9000/);
    expect(out).not.toContain("8010:8010");
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

  it("projeto com e-mail: os serviços de mailServices entram na rede de e-mail, sem alias, e o web segue na rede do proxy", () => {
    const doc = parse(
      composeOverrideYaml({
        compose: APP,
        proxyService: "web",
        slug: "loja",
        network: "paas-net",
        mailNetwork: "paas-mail",
        mailServices: ["web", "worker"],
      }),
    );
    expect(doc.networks).toEqual({ "paas-net": { external: true }, "paas-mail": { external: true } });
    expect(doc.services.web.networks).toEqual({ default: null, "paas-net": { aliases: ["loja"] }, "paas-mail": null });
    expect(doc.services.worker.networks).toEqual({ default: null, "paas-mail": null });
  });

  it("sem e-mail habilitado: a rede de e-mail nem é declarada", () => {
    const doc = parse(composeOverrideYaml({ compose: APP, proxyService: "web", slug: "loja", network: "paas-net", mailNetwork: "paas-mail", mailServices: [] }));
    expect(doc.networks).toEqual({ "paas-net": { external: true } });
    expect(doc.services.worker).toBeUndefined();
  });
});

const CASSINO = `services:
  db:
    image: postgres:16
  redis:
    image: redis:7
  wallet:
    image: wallet:1
    networks: [backend]
  web:
    image: web:1
    network_mode: service:wallet
  caddy:
    image: caddy:2
    network_mode: service:wallet
networks:
  backend: {}
`;

describe("serviços com network_mode (formato do cassino)", () => {
  const base = { compose: CASSINO, proxyService: "wallet", slug: "cassino", network: "paas-net", mailNetwork: "paas-mail" };

  it("o dono do namespace entra na rede de e-mail; quem usa network_mode nunca recebe networks", () => {
    const doc = parse(composeOverrideYaml({ ...base, mailServices: ["db", "redis", "wallet", "web", "caddy"] }));
    expect(doc.services.web?.networks).toBeUndefined();
    expect(doc.services.caddy?.networks).toBeUndefined();
    expect(doc.services.wallet.networks).toEqual({ default: null, "paas-net": { aliases: ["cassino"] }, "paas-mail": null });
    expect(doc.services.db.networks).toEqual({ default: null, "paas-mail": null });
  });

  it("o dono entra mesmo que não esteja em mailServices", () => {
    const doc = parse(composeOverrideYaml({ ...base, proxyService: "db", mailServices: ["web"] }));
    expect(doc.services.wallet.networks).toEqual({ default: null, "paas-mail": null });
    expect(doc.services.web?.networks).toBeUndefined();
  });

  it("proxyService com network_mode: a rede do proxy vai para o dono", () => {
    const doc = parse(composeOverrideYaml({ ...base, proxyService: "web" }));
    expect(doc.services.web?.networks).toBeUndefined();
    expect(doc.services.wallet.networks).toEqual({ default: null, "paas-net": { aliases: ["cassino"] } });
  });

  it("proxyService com network_mode host/none não gera networks", () => {
    const compose = "services:\n  a:\n    image: x\n    network_mode: host\n";
    const doc = parse(composeOverrideYaml({ compose, proxyService: "a", slug: "s", network: "paas-net" }));
    expect(doc.services?.a?.networks).toBeUndefined();
  });

  it("o docker compose config aceita o override com e-mail habilitado", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paas-netmode-"));
    writeFileSync(path.join(dir, "compose.yml"), CASSINO);
    writeFileSync(
      path.join(dir, "o.yml"),
      composeOverrideYaml({ ...base, mailServices: ["db", "redis", "wallet", "web", "caddy"] }),
    );
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "o.yml", "config", "--format", "json"], {
      cwd: dir,
      env: { ...process.env, DOCKER_CONFIG: dir },
    }).toString();
    const svc = JSON.parse(out).services;
    expect(svc.web.network_mode).toBe("service:wallet");
    expect(svc.web.networks).toBeUndefined();
    expect(Object.keys(svc.wallet.networks)).toContain("paas-mail");
  });
});

describe("mailNetworkTargets", () => {
  const c = (body: string) => `services:\n${body}`;
  it("sem network_mode: devolve os mesmos serviços", () => {
    expect(mailNetworkTargets(APP, ["web", "worker"])).toEqual({ targets: ["web", "worker"], delegated: {}, skipped: [] });
  });
  it("service:X: delega ao dono, inclusive quando o dono não estava na lista", () => {
    const r = mailNetworkTargets(c("  a:\n    image: x\n  b:\n    image: x\n    network_mode: service:a\n"), ["b"]);
    expect(r).toEqual({ targets: ["a"], delegated: { b: "a" }, skipped: [] });
  });
  it("cadeia service:A onde A tem service:B: chega ao final", () => {
    const r = mailNetworkTargets(c("  a:\n    image: x\n    network_mode: service:b\n  b:\n    image: x\n  d:\n    image: x\n    network_mode: service:a\n"), ["d", "a", "b"]);
    expect(r.targets).toEqual(["b"]);
    expect(r.delegated).toEqual({ d: "b", a: "b" });
  });
  it.each(["host", "none", "bridge", "container:abc"])("network_mode %s: sem dono, ignorado", (mode) => {
    const r = mailNetworkTargets(c(`  a:\n    image: x\n    network_mode: ${mode}\n  b:\n    image: x\n`), ["a", "b"]);
    expect(r).toEqual({ targets: ["b"], delegated: {}, skipped: ["a"] });
  });
  it("dono inexistente e ciclo: ignorados, sem override inválido", () => {
    const r = mailNetworkTargets(c("  a:\n    image: x\n    network_mode: service:zzz\n  b:\n    image: x\n    network_mode: service:c\n  c:\n    image: x\n    network_mode: service:b\n"), ["a", "b", "c"]);
    expect(r).toEqual({ targets: [], delegated: {}, skipped: ["a", "b", "c"] });
  });
  it("compose ilegível ou serviço desconhecido: mantém o nome", () => {
    expect(mailNetworkTargets(": : [", ["x"]).targets).toEqual(["x"]);
    expect(mailNetworkTargets(APP, ["x"]).targets).toEqual(["x"]);
  });
  it("deduplica", () => {
    expect(mailNetworkTargets(APP, ["web", "web"]).targets).toEqual(["web"]);
  });
});
