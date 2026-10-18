/**
 * Guardrails contra um docker-compose.yml HOSTIL (achado A1 da auditoria).
 *
 * Os guardrails antigos só barravam `privileged: true` literal e o texto
 * "/var/run/docker.sock": todos os compose abaixo passavam com 0 bloqueios e
 * davam root na VPS a quem controla o repositório. Os fixtures vêm da prova
 * da auditoria (tests/fixtures/hostil/<caso>/docker-compose.yml).
 *
 * Aqui: a checagem sobre o YAML cru (pré-checagem da tela). O que depende de
 * interpolação, include e extends só o `docker compose config` resolve — isso
 * é coberto em compose-hostil-docker.test.ts (Docker real) e no engine.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGuardrails } from "../src/rules.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hostil");

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-hostil-"));
  src = path.join(root, "projeto");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Roda os guardrails sobre uma cópia do fixture. */
async function guardar(caso: string) {
  await cp(path.join(FIXTURES, caso), src, { recursive: true });
  return runGuardrails(src, "docker-compose.yml", undefined, { projectName: "paas-atacante" });
}

function bloqueios(report: Awaited<ReturnType<typeof guardar>>, rule: string) {
  return report.findings.filter((f) => f.level === "block" && f.rule === rule);
}

describe("compose hostil — o que passava com 0 bloqueios agora é barrado", () => {
  it("privileged: \"true\" (texto) é barrado", async () => {
    const r = await guardar("strpriv");
    expect(bloqueios(r, "privileged-container").map((f) => f.title)).toContain("Container privilegiado");
  });

  it("privileged: !!bool \"true\" é barrado", async () => {
    const r = await guardar("reset");
    expect(bloqueios(r, "privileged-container")).not.toHaveLength(0);
  });

  it("merge <<: *evil herda privileged e docker.sock — barrado", async () => {
    const r = await guardar("merge");
    const titulos = bloqueios(r, "privileged-container").map((f) => f.title);
    expect(titulos).toContain("Container privilegiado");
    expect(titulos).toContain("Socket do Docker montado no container");
  });

  it("volume /:/host, /run/docker.sock, cap_add, devices, security_opt, pid: host e network_mode: host", async () => {
    const r = await guardar("rootmount");
    const priv = bloqueios(r, "privileged-container").map((f) => f.title);
    expect(priv).toEqual(
      expect.arrayContaining([
        "Socket do Docker montado no container",
        "Capabilities extras no container (cap_add)",
        "Acesso a dispositivos do host (devices)",
        "Proteções do container desligadas (security_opt)",
      ]),
    );
    const mounts = bloqueios(r, "host-mount");
    expect(mounts.map((f) => f.evidence).join("\n")).toContain("monta / de fora da pasta do projeto");
    const ns = bloqueios(r, "host-namespace").map((f) => f.evidence).join("\n");
    expect(ns).toContain("pid: host");
    expect(ns).toContain("network_mode: host");
  });

  it("pid/network_mode apontando para container de OUTRO projeto (container:tws-panel) é barrado", async () => {
    const r = await guardar("pidcont");
    const ns = bloqueios(r, "host-namespace").map((f) => f.evidence).join("\n");
    expect(ns).toContain("pid: container:tws-panel");
    expect(ns).toContain("network_mode: container:paas-stalwart");
  });

  it("bind que sobe vários níveis (../../../../) e /var/run em forma longa é barrado", async () => {
    const r = await guardar("bindlong");
    expect(bloqueios(r, "host-mount").length).toBeGreaterThanOrEqual(2);
  });

  it("volume externo paas_data (o /data do painel) e rede externa de outro projeto são barrados", async () => {
    const r = await guardar("namedvol");
    const shared = bloqueios(r, "shared-resource").map((f) => f.evidence).join("\n");
    expect(shared).toContain('o volume "paas_data"');
    expect(shared).toContain('a rede "other"');
  });

  it("build.context: /, dockerfile e env_file de fora da pasta do projeto são barrados", async () => {
    const r = await guardar("dockerfile_ctx");
    const fora = bloqueios(r, "build-outside-src").map((f) => f.evidence).join("\n");
    expect(fora).toContain("o contexto de build /");
    expect(fora).toContain("env_file /data/vault.key");
    expect(fora).toContain("env_file ../../../etc/shadow");
  });

  it("valores só resolvidos pela interpolação (${PRIV:-true}) não dá para ver no YAML cru: quem decide é o docker compose config", async () => {
    const r = await guardar("interp");
    expect(bloqueios(r, "privileged-container")).toHaveLength(0);
  });
});

describe("compose legítimo — nada disso atrapalha apps comuns", () => {
  it("web + banco com volume nomeado, portas, env e pasta ./dados do próprio projeto: sem bloqueios", async () => {
    await cp(path.join(FIXTURES, "legitimo"), src, { recursive: true });
    const r = await runGuardrails(src, "docker-compose.yml", undefined, { projectName: "paas-atacante" });
    expect(r.findings.filter((f) => f.level === "block")).toEqual([]);
  });
});
