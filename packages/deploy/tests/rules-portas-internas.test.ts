/**
 * Portas internas (PHP-FPM, Memcached, RabbitMQ, Mailpit, API do Docker...) publicadas em interface
 * pública bloqueiam o deploy; em loopback passam. Outras portas em todas as interfaces só avisam.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCompose } from "../src/guardrails.js";
import { bindScope } from "../src/compose-ports.js";
import { runGuardrails } from "../src/rules.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-portas-internas-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function achados(body: string) {
  await writeFile(path.join(dir, "compose.yml"), `services:\n${body}\n`);
  const report = await runGuardrails(dir);
  return {
    bloqueios: report.findings.filter((f) => f.rule === "internal-port-exposed" && f.level === "block"),
    avisosInternos: report.findings.filter((f) => f.rule === "internal-port-exposed" && f.level === "warn"),
    avisosPublicos: report.findings.filter((f) => f.rule === "public-port-published"),
  };
}

describe("internal-port-exposed", () => {
  it.each([
    ["9000:9000", "PHP-FPM"],
    ["11211:11211", "Memcached"],
    ["5672:5672", "RabbitMQ"],
    ["15672:15672", "RabbitMQ"],
    ["8025:8025", "Mailpit"],
    ["1025:1025", "Mailpit"],
    ["2375:2375", "Docker"],
    ["2376:2376", "Docker"],
    ["9300:9300", "Elasticsearch"],
    ["9000", "PHP-FPM"],
    ["0.0.0.0:9000:9000", "PHP-FPM"],
    ["[::]:9000:9000", "PHP-FPM"],
    ["::9000:9000", "PHP-FPM"],
    ["8080:9000", "PHP-FPM"],
    ["192.0.2.10:11211:11211", "Memcached"],
    ["9000:9000/tcp", "PHP-FPM"],
  ])("bloqueia %s", async (porta, nome) => {
    const r = await achados(`  svc:\n    image: app:1\n    ports: ["${porta}"]`);
    expect(r.bloqueios).toHaveLength(1);
    expect(r.bloqueios[0]!.title).toContain(nome);
    expect(r.bloqueios[0]!.service).toBe("svc");
    // diz exatamente o que trocar
    expect(r.bloqueios[0]!.fix).toContain("Remova a entrada de `ports`");
    expect(r.bloqueios[0]!.fix).toContain("127.0.0.1:");
  });

  it.each(["127.0.0.1:9000:9000", "[::1]:9000:9000", "::1:9000:9000", "127.0.0.2:11211:11211", "localhost:5672:5672"])(
    "permite em loopback: %s",
    async (porta) => {
      const r = await achados(`  svc:\n    image: app:1\n    ports: ["${porta}"]`);
      expect(r.bloqueios).toHaveLength(0);
      expect(r.avisosInternos).toHaveLength(0);
      expect(r.avisosPublicos).toHaveLength(0);
    },
  );

  it("forma longa: sem host_ip ou 0.0.0.0 bloqueia; 127.0.0.1 passa", async () => {
    const semIp = await achados("  svc:\n    image: app:1\n    ports:\n      - target: 9000\n        published: 9000");
    expect(semIp.bloqueios).toHaveLength(1);
    const publico = await achados("  svc:\n    image: app:1\n    ports:\n      - target: 5672\n        published: 5672\n        host_ip: 0.0.0.0");
    expect(publico.bloqueios).toHaveLength(1);
    const v6 = await achados("  svc:\n    image: app:1\n    ports:\n      - target: 5672\n        published: 5672\n        host_ip: '::'");
    expect(v6.bloqueios).toHaveLength(1);
    const local = await achados("  svc:\n    image: app:1\n    ports:\n      - target: 9000\n        published: 9000\n        host_ip: 127.0.0.1");
    expect(local.bloqueios).toHaveLength(0);
    const localV6 = await achados("  svc:\n    image: app:1\n    ports:\n      - target: 9000\n        published: 9000\n        host_ip: '::1'");
    expect(localV6.bloqueios).toHaveLength(0);
  });

  it("endereço vindo de variável só avisa (não dá para saber)", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["${BIND_IP}:9000:9000"]');
    expect(r.bloqueios).toHaveLength(0);
    expect(r.avisosInternos).toHaveLength(1);
  });

  it("faixa que inclui a porta interna bloqueia só a porta perigosa", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["8999-9001:8999-9001"]');
    expect(r.bloqueios).toHaveLength(1);
    expect(r.bloqueios[0]!.evidence).toContain("9000");
  });

  it("portas de banco continuam na regra de banco (sem duplicar)", async () => {
    await writeFile(path.join(dir, "compose.yml"), 'services:\n  c:\n    image: redis:8\n    ports: ["6379:6379", "9200:9200", "27017:27017"]\n');
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "db-port-exposed")).toHaveLength(3);
    expect(report.findings.filter((f) => f.rule === "internal-port-exposed")).toHaveLength(0);
  });

  it("expose não publica: passa", async () => {
    const r = await achados('  svc:\n    image: app:1\n    expose: ["9000"]');
    expect(r.bloqueios).toHaveLength(0);
  });

  it("o relatório conta o bloqueio", async () => {
    await writeFile(path.join(dir, "compose.yml"), 'services:\n  svc:\n    image: app:1\n    ports: ["9000:9000"]\n');
    const report = await runGuardrails(dir);
    expect(report.blockers).toBeGreaterThanOrEqual(1);
  });
});

describe("public-port-published (aviso)", () => {
  it("porta qualquer em todas as interfaces avisa, sem bloquear", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["3000:3000", "[::]:4000:4000", "0.0.0.0:5000:5000"]');
    expect(r.avisosPublicos).toHaveLength(3);
    expect(r.avisosPublicos.every((f) => f.level === "warn")).toBe(true);
    expect(r.bloqueios).toHaveLength(0);
    expect(r.avisosPublicos[0]!.fix).toContain("127.0.0.1:3000:3000");
  });

  it("loopback não avisa", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["127.0.0.1:3000:3000"]');
    expect(r.avisosPublicos).toHaveLength(0);
  });

  it("80 e 443 do host ficam com a regra do proxy (sem aviso duplicado)", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["80:80", "443:443"]');
    expect(r.avisosPublicos).toHaveLength(0);
  });

  it("porta de banco não vira aviso extra", async () => {
    const r = await achados('  db:\n    image: postgres:16\n    ports: ["5432:5432"]');
    expect(r.avisosPublicos).toHaveLength(0);
  });

  it("endereço de variável não vira aviso de porta pública", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["${BIND_IP}:3000:3000"]');
    expect(r.avisosPublicos).toHaveLength(0);
  });

  it("publicação feita pelo painel (modal Portas) é escolha do dono: não avisa", async () => {
    await writeFile(path.join(dir, "compose.yml"), "services:\n  svc:\n    image: app:1\n");
    const report = await runGuardrails(dir, null, {
      svc: [{ original: "+0.0.0.0:3000:3000", hostPort: 3000, hostIp: "0.0.0.0", added: { containerPort: 3000, protocol: "tcp" } }],
    });
    expect(report.findings.filter((f) => f.rule === "public-port-published")).toHaveLength(0);
  });
});

describe("bindScope", () => {
  it("classifica endereços", () => {
    expect(bindScope(null)).toBe("public");
    expect(bindScope("")).toBe("public");
    expect(bindScope("0.0.0.0")).toBe("public");
    expect(bindScope("::")).toBe("public");
    expect(bindScope("[::]")).toBe("public");
    expect(bindScope("192.0.2.1")).toBe("public");
    expect(bindScope("127.0.0.1")).toBe("loopback");
    expect(bindScope("::1")).toBe("loopback");
    expect(bindScope("[::1]")).toBe("loopback");
    expect(bindScope("0:0:0:0:0:0:0:1")).toBe("loopback");
    expect(bindScope("::ffff:127.0.0.1")).toBe("loopback");
    expect(bindScope("LOCALHOST")).toBe("loopback");
    expect(bindScope("${IP}")).toBe("unknown");
  });
});

describe("prévia do wizard (analyzeCompose)", () => {
  it("avisa crítico para porta interna pública e cala em loopback", () => {
    const publico = analyzeCompose('services:\n  svc:\n    image: app:1\n    ports: ["11211:11211"]\n', "compose.yml");
    expect(publico.some((w) => w.id === "compose.internal-port-exposed" && w.severity === "critical")).toBe(true);
    const local = analyzeCompose('services:\n  svc:\n    image: app:1\n    ports: ["127.0.0.1:11211:11211"]\n', "compose.yml");
    expect(local.some((w) => w.id === "compose.internal-port-exposed")).toBe(false);
    const banco = analyzeCompose('services:\n  svc:\n    image: redis:8\n    ports: ["6379:6379"]\n', "compose.yml");
    expect(banco.some((w) => w.id === "compose.internal-port-exposed")).toBe(false);
  });
});

describe("reciprocidade de nomes (serviço web × slug de outro projeto)", () => {
  it("deploy com serviço web chamado como o slug de OUTRO projeto é recusado", async () => {
    await writeFile(path.join(dir, "compose.yml"), "services:\n  site:\n    image: app:1\n");
    const report = await runGuardrails(dir, null, undefined, {
      projectName: "paas-projeto-a",
      slug: "projeto-a",
      proxyService: "site",
      otherSlugs: ["site"],
    });
    expect(report.findings.some((f) => f.rule === "reserved-name" && f.service === "site")).toBe(true);
  });
});
