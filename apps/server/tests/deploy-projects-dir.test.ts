/**
 * DeployService × diretório dos projetos.
 *
 * O caminho onde o código dos projetos vive é configuração de INSTALAÇÃO
 * (config.projectsDir), não mais um `<dataDir>/projects` fixo: em produção ele
 * é um caminho real do host montado com o MESMO caminho dentro do container,
 * para que os bind mounts declarados no compose do usuário — que o daemon
 * Docker resolve no host — apontem para um diretório que existe de verdade.
 *
 * Este teste trava o contrato: o serviço lê o valor da configuração.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let projectsDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-projdir-data-"));
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-projdir-host-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectsDir, { recursive: true, force: true });
});

function novoServico(): DeployService {
  return new DeployService({
    dataDir,
    projectsDir,
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  } as unknown as ServerConfig);
}

describe("diretório dos projetos vem da configuração", () => {
  it("procura o código do projeto em config.projectsDir, não em <dataDir>/projects", async () => {
    const service = novoServico();
    const project = await service.createProject({
      name: "Loja",
      ingestMode: "git",
      source: "https://github.com/usuario/repo.git",
      branch: "main",
      domain: "loja.localhost",
    });

    // Sem código em lugar nenhum, o serviço reporta "ainda não ingerido".
    const antes = await service.guardrailsForProject(project.id);
    expect(antes.report).toBeNull();

    // Colocando o código no diretório CONFIGURADO, ele passa a ser encontrado.
    const src = path.join(projectsDir, project.slug, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "package.json"), '{"name":"loja"}\n', "utf8");

    const depois = await service.guardrailsForProject(project.id);
    expect(depois.report).not.toBeNull();
  });
});
