/**
 * Aviso da subida sobre o limite do log: quem ainda está sem ele (o painel não recria nada aqui). Sem Docker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containersWithoutLogLimits, logLimitsWarnings } from "../src/services/container-log-limits.js";

type Result = { code: number; stdout: string; stderr: string };
const SEM = JSON.stringify({ Type: "json-file", Config: {} });
const COM = JSON.stringify({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
const LIMITS = { maxSize: "10m", maxFile: 3 };

function docker(lines: string[], opts: { ps?: Result; inspect?: Result } = {}) {
  const calls: string[][] = [];
  const run = async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    if (args[0] === "ps") return opts.ps ?? { code: 0, stdout: lines.map((_, i) => `id${i}`).join("\n") + "\n", stderr: "" };
    return opts.inspect ?? { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  };
  return { run, calls };
}

// o limite padrão vale aqui, seja qual for o .env de quem roda os testes
beforeEach(() => {
  vi.stubEnv("PAAS_LOG_MAX_SIZE", "");
  vi.stubEnv("PAAS_LOG_MAX_FILE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("containersWithoutLogLimits", () => {
  it("separa o painel, o Caddy/Stalwart e os containers de projeto; ignora o webmail, os de fora e os já limitados", async () => {
    const { run, calls } = docker([
      `/tws-panel||||${SEM}`,
      `/paas-caddy|true|||${SEM}`,
      `/paas-stalwart|true|||${COM}`,
      `/paas-webmail|true|||${SEM}`,
      `/paas-loja-web|true|||${SEM}`,
      `/paas-blog-db-1||paas-blog||${SEM}`,
      `/paas-blog-app-1||paas-blog||${JSON.stringify({ Type: "journald", Config: {} })}`,
      // compose declara logging: próprio (json-file sem max-size): respeitado, não é acusado
      `/paas-blog-fila-1||paas-blog|true|${SEM}`,
      `/outro-do-dono||outro||${SEM}`,
      "linha estranha",
      "/curta|true||{}",
    ]);
    const report = await containersWithoutLogLimits(run, "tws-panel", LIMITS);
    expect(report).toEqual({ own: ["paas-caddy"], panel: true, projects: ["paas-loja-web", "paas-blog-db-1"] });
    expect(calls[0]).toEqual(["ps", "-aq"]);
    expect(calls[1]![0]).toBe("inspect");
  });

  it("limite desligado, Docker fora do ar ou nenhum container: relatório vazio", async () => {
    const vazio = { own: [], panel: false, projects: [] };
    expect(await containersWithoutLogLimits(docker([`/paas-caddy||||${SEM}`]).run, "tws-panel", null)).toEqual(vazio);
    expect(await containersWithoutLogLimits(docker([], { ps: { code: 1, stdout: "", stderr: "x" } }).run, "tws-panel", LIMITS)).toEqual(vazio);
    expect(await containersWithoutLogLimits(docker([`/paas-caddy||||${SEM}`], { inspect: { code: 1, stdout: "", stderr: "x" } }).run, "tws-panel", LIMITS)).toEqual(vazio);
  });

  it("inspect com erro parcial (container sumiu no meio): usa o que veio", async () => {
    const { run } = docker([], { ps: { code: 0, stdout: "a\nb\n", stderr: "" }, inspect: { code: 1, stdout: `/paas-caddy|true|||${SEM}\n`, stderr: "No such object: b" } });
    expect((await containersWithoutLogLimits(run, "tws-panel", LIMITS)).own).toEqual(["paas-caddy"]);
  });

  it("sem argumento de limite: usa o do ambiente (padrão ligado)", async () => {
    const { run } = docker([`/tws-panel||||${SEM}`]);
    expect((await containersWithoutLogLimits(run, "tws-panel")).panel).toBe(true);
  });
});

describe("logLimitsWarnings", () => {
  it("nada a dizer: nenhuma linha", () => {
    expect(logLimitsWarnings({ own: [], panel: false, projects: [] })).toEqual([]);
  });

  it("uma linha por grupo, dizendo quando cada um ganha o limite", () => {
    const lines = logLimitsWarnings({ own: ["paas-caddy", "paas-stalwart"], panel: true, projects: ["paas-loja-web"] });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("paas-caddy, paas-stalwart");
    expect(lines[0]).toContain("não os recria sozinho");
    expect(lines[1]).toContain("docker compose up -d");
    expect(lines[2]).toContain("1 container(s) de projeto ainda sem o limite (paas-loja-web)");
    expect(lines[2]).toContain("menos site estático, que só no deploy");
    expect(lines[2]).toContain("logging: próprio é respeitado");
  });

  it("muitos containers de projeto: mostra 10 e conta o resto", () => {
    const projects = Array.from({ length: 12 }, (_, i) => `paas-p${i}`);
    const [line] = logLimitsWarnings({ own: [], panel: false, projects });
    expect(line).toContain("12 container(s)");
    expect(line).toContain("paas-p9 e mais 2");
    expect(line).not.toContain("paas-p10");
  });
});
