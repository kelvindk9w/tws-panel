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

  it("container que compartilha a rede de outro (container:/host) não recebe network connect e não conta", async () => {
    respostas = (a) => {
      if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: "c1\nc2\nc3\n", stderr: "" };
      if (a[0] === "inspect" && a.includes("c2")) return { code: 0, stdout: "container:c1\n", stderr: "" };
      if (a[0] === "inspect" && a.includes("c3")) return { code: 0, stdout: "host\n", stderr: "" };
      return { code: 0, stdout: a[0] === "inspect" ? "paas-loja_default\n" : "", stderr: "" };
    };
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
    expect(calls).not.toContainEqual(["network", "connect", "paas-mail", "c2"]);
    expect(calls).not.toContainEqual(["network", "connect", "paas-mail", "c3"]);
  });
});

describe("DeployEngine.joinMailNetwork com a caixa de teste de e-mail", () => {
  const engineComCaixa = (network: string | null) =>
    new DeployEngine({
      projectsDir: "/tmp/x",
      caddyDir: "/tmp/x/caddy",
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      mailTestForProject: async () => (network ? { network } : null),
    });

  it("liga os containers à rede INTERNA do Mailpit, nunca à do servidor de e-mail real", async () => {
    respostas = (a) => {
      if (a[0] === "network" && a[1] === "inspect") return { code: 1, stdout: "", stderr: "no" };
      if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: "c1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mailtest-loja", "c1"]);
    expect(calls.some((c) => c.includes("paas-mail"))).toBe(false);
  });

  it("caixa desligada (null): segue na paas-mail de sempre", async () => {
    respostas = (a) => (a[0] === "ps" && a.includes("-q") ? { code: 0, stdout: "c1\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    await engineComCaixa(null).joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
  });

  it("REVISÃO: rede do Mailpit que já existe e TEM saída é recriada como interna; interna é reaproveitada", async () => {
    const containers = (a: string[]) => (a[0] === "ps" && a.includes("-q") ? { code: 0, stdout: "c1\n", stderr: "" } : undefined);
    respostas = (a) => (a[0] === "network" && a[1] === "inspect" ? { code: 0, stdout: "false\n", stderr: "" } : (containers(a) ?? { code: 0, stdout: "", stderr: "" }));
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "rm", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);

    calls.length = 0;
    respostas = (a) => (a[0] === "network" && a[1] === "inspect" ? { code: 0, stdout: "true\n", stderr: "" } : (containers(a) ?? { code: 0, stdout: "", stderr: "" }));
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls.some((c) => c[0] === "network" && (c[1] === "rm" || c[1] === "create"))).toBe(false);
  });

  it("REVISÃO: não conseguiu recriar a rede com saída: o erro sobe (nunca liga o app a uma rede com saída)", async () => {
    respostas = (a) => {
      if (a[0] === "network" && a[1] === "inspect") return { code: 0, stdout: "false\n", stderr: "" };
      if (a[0] === "network" && a[1] === "rm") return { code: 1, stdout: "", stderr: "has active endpoints" };
      return a[0] === "ps" && a.includes("-q") ? { code: 0, stdout: "c1\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    };
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).rejects.toThrow(/não é interna.*has active endpoints/);
    expect(calls.some((c) => c[0] === "network" && c[1] === "connect")).toBe(false);
  });
});
