/**
 * Migração do e-mail para a rede paas-mail (A4): projetos que JÁ têm e-mail
 * habilitado alcançavam o Stalwart pela paas-net. Quando o Stalwart sai dela,
 * os containers que estão rodando entram na paas-mail na hora, sem esperar o
 * próximo deploy (que passa a ligar pelo override).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let respostas: (args: string[]) => Result;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    return respostas(args);
  }),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");

beforeEach(() => {
  calls.length = 0;
});

const projeto = (slug: string) => ({ id: slug, name: slug, slug }) as unknown as Project;
const engine = () =>
  new DeployEngine({ projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 });

describe("DeployEngine.joinMailNetwork", () => {
  it("liga os containers do projeto à paas-mail (criando a rede se faltar)", async () => {
    respostas = (a) => {
      if (a[0] === "network" && a[1] === "inspect") return { code: 1, stdout: "", stderr: "no" };
      if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: "c1\nc2\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(2);
    expect(calls).toContainEqual(["network", "create", "--label", "paas.managed=true", "paas-mail"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c2"]);
  });

  it("container que já está na rede não é erro; outra falha é", async () => {
    respostas = (a) => {
      if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: "c1\n", stderr: "" };
      if (a[0] === "network" && a[1] === "connect") return { code: 1, stdout: "", stderr: "endpoint with name x already exists in network paas-mail" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    respostas = (a) => {
      if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: "c1\n", stderr: "" };
      if (a[0] === "network" && a[1] === "connect") return { code: 1, stdout: "", stderr: "daemon fora" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ligar c1 à rede paas-mail: daemon fora/);
  });

  it("falha ao criar a rede é erro claro", async () => {
    respostas = (a) =>
      a[0] === "network"
        ? { code: 1, stdout: "", stderr: "sem endereços" }
        : { code: 0, stdout: a[0] === "ps" && a.includes("-q") ? "c1\n" : "", stderr: "" };
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao criar a rede paas-mail: sem endereços/);
  });

  it("projeto sem containers: nada a ligar", async () => {
    respostas = () => ({ code: 0, stdout: "", stderr: "" });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
  });
});
