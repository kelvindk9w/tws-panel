/**
 * compose-override.docker-real.test.ts — o arquivo complementar (paas.override.yml) passado pelo `docker compose
 * config` de verdade: o compose aceita o resultado como o painel o gera. Integração: só com PAAS_TEST_REAL_DOCKER=1
 * (docs/processo/testes-e-docker.md) e onde há `docker compose` (`config` não cria nada). Sem a variável, nem o
 * `docker compose version` é chamado. As regras do arquivo, sem Docker, estão em compose-override.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

const VITRINE = `services:
  db:
    image: postgres:16
  redis:
    image: redis:7
  ledger:
    image: ledger:1
    networks: [backend]
  web:
    image: web:1
    network_mode: service:ledger
  caddy:
    image: caddy:2
    network_mode: service:ledger
networks:
  backend: {}
`;

function dockerComposeDisponivel(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const DOCKER = process.env.PAAS_TEST_REAL_DOCKER === "1" && dockerComposeDisponivel();

function configJson(dir: string, files: string[]): Record<string, { network_mode?: string; networks?: Record<string, unknown> }> {
  const args = ["compose", ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"];
  const out = execFileSync("docker", args, { cwd: dir, env: { ...process.env, DOCKER_CONFIG: dir } }).toString();
  return JSON.parse(out).services;
}

const BASE_EXTENDS = { proxyService: "ledger", slug: "c", network: "paas-proxy-loja", mailNetwork: "paas-mail" };
const BASE_VITRINE = { compose: VITRINE, proxyService: "ledger", slug: "vitrine", network: "paas-proxy-loja", mailNetwork: "paas-mail" };

describe.skipIf(!DOCKER)("composeOverrideYaml pelo docker compose config real", () => {
  it("o docker compose aceita o resultado e fica só com a porta local", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paas-ovr-"));
    writeFileSync(path.join(dir, "compose.yml"), APP);
    writeFileSync(
      path.join(dir, "o.yml"),
      composeOverrideYaml({ compose: APP, proxyService: "web", slug: "loja", network: "paas-proxy-loja" }),
    );
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "o.yml", "config", "--format", "json"], {
      cwd: dir,
      env: { ...process.env, DOCKER_CONFIG: dir },
    }).toString();
    const ports = JSON.parse(out).services.web.ports as Array<{ published: string; target: number }>;
    expect(ports.map((p) => `${p.published}:${p.target}`)).toEqual(["8010:8010"]);
  });

  it("docker compose config real aceita âncora, extends e extends de outro arquivo com e-mail", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paas-ext-"));
    writeFileSync(path.join(dir, "outro.yml"), "services:\n  base:\n    image: b:1\n    network_mode: service:ledger\n");
    const compose = `x-modo: &modo\n  network_mode: service:ledger\nservices:\n  ledger:\n    image: w:1\n  a:\n    image: a:1\n    <<: *modo\n  b:\n    image: b:1\n    network_mode: service:ledger\n  c:\n    extends:\n      file: outro.yml\n      service: base\n  d:\n    extends: b\n`;
    writeFileSync(path.join(dir, "compose.yml"), compose);
    const resolved = { services: configJson(dir, ["compose.yml"]) };
    writeFileSync(
      path.join(dir, "o.yml"),
      composeOverrideYaml({ ...BASE_EXTENDS, compose, resolved, mailServices: ["ledger", "a", "b", "c", "d"] }),
    );
    const svc = configJson(dir, ["compose.yml", "o.yml"]);
    for (const n of ["a", "b", "c", "d"]) {
      expect(svc[n]!.network_mode, n).toBe("service:ledger");
      expect(svc[n]!.networks, n).toBeUndefined();
    }
    expect(Object.keys(svc.ledger!.networks!)).toContain("paas-mail");
  });

  it("o docker compose config aceita o override com e-mail habilitado", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paas-netmode-"));
    writeFileSync(path.join(dir, "compose.yml"), VITRINE);
    writeFileSync(
      path.join(dir, "o.yml"),
      composeOverrideYaml({ ...BASE_VITRINE, mailServices: ["db", "redis", "ledger", "web", "caddy"] }),
    );
    const out = execFileSync("docker", ["compose", "-f", "compose.yml", "-f", "o.yml", "config", "--format", "json"], {
      cwd: dir,
      env: { ...process.env, DOCKER_CONFIG: dir },
    }).toString();
    const svc = JSON.parse(out).services;
    expect(svc.web.network_mode).toBe("service:ledger");
    expect(svc.web.networks).toBeUndefined();
    expect(Object.keys(svc.ledger.networks)).toContain("paas-mail");
  });
});
