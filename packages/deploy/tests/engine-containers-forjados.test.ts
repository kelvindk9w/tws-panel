/**
 * DeployEngine.projectContainers — labels forjadas (M9). Uma imagem com
 * `LABEL paas.project=vitima` gera um container que o compose do atacante
 * marca como dele (`com.docker.compose.project=paas-atacante`): parar,
 * remover ou iniciar a "vítima" não pode alcançá-lo, e o inverso também não.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.clearAllMocks());

function projeto(slug: string): Project {
  return {
    id: slug,
    name: slug,
    slug,
    ingestMode: "existing",
    source: "/x",
    branch: null,
    domain: `${slug}.localhost`,
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
  };
}

const engine = () =>
  new DeployEngine({ projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 });

describe("projectContainers", () => {
  it("container com label paas.project=vitima mas do compose do atacante NÃO é da vítima", async () => {
    respostas = (args) => {
      if (args.includes("label=com.docker.compose.project=paas-vitima")) return { code: 0, stdout: "aaa111\n", stderr: "" };
      // candidatos pela label paas.project: o forjado carrega o projeto do compose dele
      if (args.includes("label=paas.project=vitima")) {
        return { code: 0, stdout: "bbb222 paas-x-1 paas-atacante\nccc333 paas-vitima-app \n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    expect((await engine().projectContainers(projeto("vitima"))).sort()).toEqual(["aaa111", "ccc333"]);
  });

  it("o `-previous` (versão antiga do deploy do Next.js) fica fora da lista: Iniciar não o sobe junto com o novo", async () => {
    respostas = (args) =>
      args.includes("label=paas.project=vitima")
        ? { code: 0, stdout: "ccc333 paas-vitima-app \nddd444 paas-vitima-app-previous \n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    expect(await engine().projectContainers(projeto("vitima"))).toEqual(["ccc333"]);
  });

  it("só considera containers que o painel marcou (paas.managed=true) na busca por paas.project", async () => {
    respostas = () => ({ code: 0, stdout: "", stderr: "" });
    await engine().projectContainers(projeto("vitima"));
    const busca = calls.find((a) => a.includes("label=paas.project=vitima"))!;
    expect(busca).toContain("label=paas.managed=true");
  });

  it("falha do docker ps não vira exceção (lista vazia)", async () => {
    respostas = () => ({ code: 1, stdout: "", stderr: "daemon fora do ar" });
    await expect(engine().projectContainers(projeto("vitima"))).resolves.toEqual([]);
  });
});
