/**
 * Caixa de teste de e-mail + compose com `include:`/`extends`: o conjunto de variáveis do Mailpit tem de chegar a TODOS os
 * serviços do modelo resolvido (inclusive os que só existem nos arquivos incluídos). Sem o modelo, a caixa ligada recusa o deploy.
 * Sem Docker: `run` e `runStream` são dublês.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { mailTestEnv, type Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
let model: Result = { code: 0, stdout: "{}", stderr: "" };

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => (args.includes("config") ? model : { code: 0, stdout: "", stderr: "" })),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");
const { projectWorkDir } = await import("../src/ingest.js");

let root: string;
let src: string;
const ENV = mailTestEnv({ host: "paas-mailtest-site", password: "senha" });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-mt-include-"));
  src = path.join(root, "codigo");
  await mkdir(path.join(src, "worker"), { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "include:\n  - ./worker/compose.yml\nservices:\n  web:\n    image: app:1\n");
  await writeFile(path.join(src, "worker", "compose.yml"), "services:\n  worker:\n    image: app:1\n    environment:\n      MAIL_HOST: smtp.real.example.com\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const project = {
  id: "p1", name: "Site", slug: "site", ingestMode: "existing", source: "", branch: null, domain: "site.localhost", websocket: false,
  detection: { type: "compose", composeFile: "compose.yml", proxyService: "web", proxyPort: 3000, warnings: [], details: [] },
  proxyService: null, proxyPort: null, createdAt: "", updatedAt: "", lastDeployAt: null, lastDeployStatus: null, deployedBranch: null, deployedSource: null,
} as unknown as Project;

function engine(network: string | null) {
  return new DeployEngine({
    projectsDir: path.join(root, "projects"),
    caddyDir: path.join(root, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    mailTestForProject: async () => (network ? { network } : null),
  });
}

type Privado = { writeComposeFiles: (p: Project, src: string, log: () => void, dotenv: Record<string, string>, extra: Record<string, string>, tz: string | null) => Promise<unknown> };

describe("writeComposeFiles com a caixa de teste", () => {
  it("REVISÃO R2-B2: o serviço que vem de include: também recebe o conjunto do Mailpit", async () => {
    project.source = src;
    model = { code: 0, stdout: JSON.stringify({ services: { web: {}, worker: {} } }), stderr: "" };
    await (engine("paas-mailtest-site") as unknown as Privado).writeComposeFiles(project, src, () => undefined, {}, ENV, null);
    const override = parse(await readFile(path.join(projectWorkDir({ projectsDir: path.join(root, "projects") }, project), "paas.override.yml"), "utf8"));
    for (const service of ["web", "worker"]) {
      expect(override.services[service].environment).toMatchObject({ MAIL_HOST: "paas-mailtest-site", SMTP_URL: "smtp://mailtest:senha@paas-mailtest-site:1025" });
    }
  });

  it("sem o modelo resolvido, a caixa ligada recusa o deploy (nunca usa só o arquivo cru)", async () => {
    project.source = src;
    model = { code: 1, stdout: "", stderr: "yaml: invalid\nmais" };
    await expect((engine("paas-mailtest-site") as unknown as Privado).writeComposeFiles(project, src, () => undefined, {}, ENV, null)).rejects.toThrow(
      /caixa de teste de e-mail está ligada.*yaml: invalid.*interrompido/s,
    );
  });

  it("caixa desligada: o comportamento de sempre (modelo ausente não impede)", async () => {
    project.source = src;
    model = { code: 1, stdout: "", stderr: "yaml: invalid" };
    await expect((engine(null) as unknown as Privado).writeComposeFiles(project, src, () => undefined, {}, {}, null)).resolves.toBeDefined();
  });
});
