/**
 * DeployService × cofre de credenciais.
 *
 * A credencial de leitura é um segredo com o mesmo ciclo de vida do projeto:
 * apagar o projeto tem que apagar a credencial junto — segredo órfão em disco
 * é passivo, não recurso.
 *
 * Também cobre o contrato "a credencial nunca sai do serviço em claro" no que
 * o serviço expõe para a camada de API.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

const TOKEN = "tok-fake-de-teste-segredo-777";

let dataDir: string;
let service: DeployService;

async function criarProjeto() {
  return service.createProject({
    name: "Loja",
    ingestMode: "git",
    source: "https://github.com/usuario/repo.git",
    branch: "main",
    domain: "loja.localhost",
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-cred-"));
  service = new DeployService({
    dataDir,
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  } as unknown as ServerConfig);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("credencial de leitura por projeto", () => {
  it("define a credencial e reporta apenas existência + dica", async () => {
    const project = await criarProjeto();
    const info = await service.setCredential(project.id, { token: TOKEN });
    expect(info).toEqual({
      configured: true,
      hint: TOKEN.slice(-4),
      username: "x-access-token",
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it("recusa token vazio com erro 400 de domínio", async () => {
    const project = await criarProjeto();
    await expect(service.setCredential(project.id, { token: "   " })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_credential",
    });
  });

  it("recusa credencial para projeto inexistente (404)", async () => {
    await expect(service.setCredential("nao-existe", { token: TOKEN })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("remove a credencial e informa se havia alguma", async () => {
    const project = await criarProjeto();
    await service.setCredential(project.id, { token: TOKEN });
    expect(await service.removeCredential(project.id)).toBe(true);
    expect(await service.removeCredential(project.id)).toBe(false);
    expect((await service.credentialInfo(project)).configured).toBe(false);
  });

  it("apagar o projeto apaga a credencial dele", async () => {
    const project = await criarProjeto();
    await service.setCredential(project.id, { token: TOKEN });
    // engine.remove()/syncCaddy() falam com o Docker e com o Caddy; aqui só
    // interessa o efeito da remoção sobre o cofre.
    Object.assign(service, {
      engine: { remove: async () => undefined, syncCaddy: async () => undefined },
    });

    await service.deleteProject(project.id, false, () => {});

    const bruto = await readFile(path.join(dataDir, "credentials.json"), "utf8");
    expect(JSON.parse(bruto).credentials).toEqual([]);
  });

  it("o token nunca é gravado em texto puro nos arquivos de dados", async () => {
    const project = await criarProjeto();
    await service.setCredential(project.id, { token: TOKEN });
    for (const arquivo of ["projects.json", "credentials.json"]) {
      const bruto = await readFile(path.join(dataDir, arquivo), "utf8");
      expect(bruto, arquivo).not.toContain(TOKEN);
    }
  });
});
