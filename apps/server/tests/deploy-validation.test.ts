/**
 * Validação da fonte de código, do branch e do domínio de projetos.
 *
 * Motivação de segurança: `source` e `branch` chegam ao `git` como argumentos
 * (ingest.ts) e `domain` é escrito no Caddyfile (caddy.ts). Sem allowlist, o
 * transporte `ext::` do git executa comando arbitrário e um domínio com `{`
 * ou quebra de linha injeta diretivas no Caddyfile.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import {
  DeployService,
  normalizeDomain,
  validateBranch,
  validateGitSource,
} from "../src/services/deploy-service.js";

describe("validateGitSource", () => {
  it("aceita URL https de repositório", () => {
    expect(validateGitSource("https://github.com/usuario/repo.git")).toBe(
      "https://github.com/usuario/repo.git",
    );
  });

  it("aceita URL ssh no formato scp (git@host:caminho)", () => {
    expect(validateGitSource("git@github.com:usuario/repo.git")).toBe(
      "git@github.com:usuario/repo.git",
    );
  });

  it("aceita URL ssh:// explícita", () => {
    expect(validateGitSource("ssh://git@github.com/usuario/repo.git")).toBe(
      "ssh://git@github.com/usuario/repo.git",
    );
  });

  it("rejeita o transporte ext:: (execução de comando arbitrário)", () => {
    expect(() => validateGitSource("ext::sh -c touch$IFS/tmp/pwned")).toThrow(
      /fonte de código inválida/i,
    );
  });

  it("rejeita fonte iniciada por hífen (injeção de argumento no git)", () => {
    expect(() => validateGitSource("--upload-pack=/bin/sh")).toThrow(/fonte de código inválida/i);
  });

  it("rejeita esquema file://", () => {
    expect(() => validateGitSource("file:///etc/passwd")).toThrow(/fonte de código inválida/i);
  });
});

describe("validateBranch", () => {
  it("aceita nomes de branch usuais", () => {
    expect(validateBranch("main")).toBe("main");
    expect(validateBranch("feature/nova-tela")).toBe("feature/nova-tela");
    expect(validateBranch("release-1.2.3")).toBe("release-1.2.3");
  });

  it("devolve null quando não há branch", () => {
    expect(validateBranch(null)).toBeNull();
    expect(validateBranch("  ")).toBeNull();
  });

  it("rejeita branch iniciado por hífen (injeção de argumento)", () => {
    expect(() => validateBranch("--upload-pack=/bin/sh")).toThrow(/branch inválido/i);
  });

  it("rejeita branch com caracteres de shell", () => {
    expect(() => validateBranch("main; rm -rf /")).toThrow(/branch inválido/i);
    expect(() => validateBranch("main$(id)")).toThrow(/branch inválido/i);
  });
});

describe("normalizeDomain", () => {
  it("normaliza domínio válido removendo esquema e caminho", () => {
    expect(normalizeDomain("https://Loja.example.com/caminho")).toBe("loja.example.com");
  });

  it("rejeita domínio com chaves (injeção de bloco no Caddyfile)", () => {
    expect(normalizeDomain("loja.com { respond \"x\" }")).toBe("");
  });

  it("rejeita domínio com quebra de linha (injeção de diretiva no Caddyfile)", () => {
    expect(normalizeDomain("loja.com\nadmin.com")).toBe("");
  });

  it("rejeita domínio com espaço", () => {
    expect(normalizeDomain("loja.com outro.com")).toBe("");
  });
});

describe("DeployService.createProject — validação da fonte", () => {
  let dataDir: string;
  let service: DeployService;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-test-"));
    service = new DeployService({
      dataDir,
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    } as unknown as ServerConfig);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("cria projeto com URL de repositório válida", async () => {
    const project = await service.createProject({
      name: "Loja",
      ingestMode: "git",
      source: "https://github.com/usuario/repo.git",
      branch: "main",
      domain: "loja.localhost",
    });
    expect(project.source).toBe("https://github.com/usuario/repo.git");
    expect(project.branch).toBe("main");
  });

  it("recusa fonte com transporte ext:: antes de persistir o projeto", async () => {
    await expect(
      service.createProject({
        name: "Malicioso",
        ingestMode: "git",
        source: "ext::sh -c touch$IFS/tmp/pwned",
        domain: "mal.localhost",
      }),
    ).rejects.toMatchObject({ code: "invalid_source" });

    expect(await service.listProjects()).toHaveLength(0);
  });

  it("recusa branch iniciado por hífen", async () => {
    await expect(
      service.createProject({
        name: "Malicioso",
        ingestMode: "git",
        source: "https://github.com/usuario/repo.git",
        branch: "--upload-pack=/bin/sh",
        domain: "mal2.localhost",
      }),
    ).rejects.toMatchObject({ code: "invalid_branch" });
  });

  it("não valida esquema de URL nos modos upload/existing (são caminhos locais)", async () => {
    const project = await service.createProject({
      name: "Local",
      ingestMode: "existing",
      source: dataDir,
      domain: "local.localhost",
    });
    expect(project.source).toBe(dataDir);
  });
});

describe("dois ambientes do mesmo repositório (produção + sandbox)", () => {
  // Teste de caracterização: documenta e protege um caso de uso que já
  // funciona. O isolamento do painel é por slug do projeto — diretório de
  // clone, compose project, imagem e alias de rede derivam dele —, então o
  // mesmo repositório pode ser hospedado duas vezes em branches diferentes.
  let dataDir: string;
  let service: DeployService;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-multibranch-test-"));
    service = new DeployService({
      dataDir,
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    } as unknown as ServerConfig);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const REPO = "https://github.com/usuario/minha-app.git";

  it("aceita o mesmo repositório em dois projetos com branches diferentes", async () => {
    const prod = await service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: REPO,
      branch: "main",
      domain: "app.exemplo.com",
    });
    const sandbox = await service.createProject({
      name: "Minha App Sandbox",
      ingestMode: "git",
      source: REPO,
      branch: "sandbox",
      domain: "sandbox.exemplo.com",
    });

    expect(prod.source).toBe(sandbox.source);
    expect(prod.branch).toBe("main");
    expect(sandbox.branch).toBe("sandbox");
  });

  it("dá slugs distintos aos dois, garantindo clones e containers separados", async () => {
    const prod = await service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: REPO,
      branch: "main",
      domain: "app.exemplo.com",
    });
    const sandbox = await service.createProject({
      name: "Minha App Sandbox",
      ingestMode: "git",
      source: REPO,
      branch: "sandbox",
      domain: "sandbox.exemplo.com",
    });

    expect(prod.slug).not.toBe(sandbox.slug);
    expect(prod.id).not.toBe(sandbox.id);
  });

  it("dá slugs distintos mesmo quando os dois projetos têm o mesmo nome", async () => {
    const a = await service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: REPO,
      branch: "main",
      domain: "app.exemplo.com",
    });
    const b = await service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: REPO,
      branch: "sandbox",
      domain: "sandbox.exemplo.com",
    });
    expect(a.slug).not.toBe(b.slug);
  });

  it("continua recusando dois projetos no mesmo domínio", async () => {
    await service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: REPO,
      branch: "main",
      domain: "app.exemplo.com",
    });
    await expect(
      service.createProject({
        name: "Outra",
        ingestMode: "git",
        source: REPO,
        branch: "sandbox",
        domain: "app.exemplo.com",
      }),
    ).rejects.toMatchObject({ code: "domain_in_use" });
  });
});

describe("DeployService.updateProject — editar configuração do projeto", () => {
  let dataDir: string;
  let service: DeployService;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-update-test-"));
    service = new DeployService({
      dataDir,
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    } as unknown as ServerConfig);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function criar() {
    return service.createProject({
      name: "Minha App",
      ingestMode: "git",
      source: "https://github.com/usuario/app.git",
      branch: "main",
      domain: "app.exemplo.com",
    });
  }

  it("troca a branch de um projeto existente", async () => {
    const p = await criar();
    const atualizado = await service.updateProject(p.id, { branch: "sandbox" });
    expect(atualizado.branch).toBe("sandbox");
  });

  it("recusa branch inválida na edição, com a mesma regra da criação", async () => {
    const p = await criar();
    await expect(
      service.updateProject(p.id, { branch: "--upload-pack=/bin/sh" }),
    ).rejects.toMatchObject({ code: "invalid_branch" });
  });

  it("troca a URL do repositório", async () => {
    const p = await criar();
    const atualizado = await service.updateProject(p.id, {
      source: "https://github.com/usuario/outro.git",
    });
    expect(atualizado.source).toBe("https://github.com/usuario/outro.git");
  });

  it("recusa fonte inválida na edição (mesmo vetor ext:: da criação)", async () => {
    const p = await criar();
    await expect(
      service.updateProject(p.id, { source: "ext::sh -c touch$IFS/tmp/pwned" }),
    ).rejects.toMatchObject({ code: "invalid_source" });
  });

  it("troca o nome de exibição do projeto", async () => {
    const p = await criar();
    const atualizado = await service.updateProject(p.id, { name: "Minha App — Produção" });
    expect(atualizado.name).toBe("Minha App — Produção");
  });

  it("NUNCA altera o slug ao renomear — ele nomeia diretórios, imagens e containers", async () => {
    const p = await criar();
    const slugOriginal = p.slug;
    const atualizado = await service.updateProject(p.id, { name: "Nome Completamente Diferente" });
    expect(atualizado.slug).toBe(slugOriginal);
  });

  it("recusa nome vazio", async () => {
    const p = await criar();
    await expect(service.updateProject(p.id, { name: "   " })).rejects.toMatchObject({
      code: "invalid_name",
    });
  });

  it("mantém a branch quando a edição não a menciona", async () => {
    const p = await criar();
    const atualizado = await service.updateProject(p.id, { websocket: true });
    expect(atualizado.branch).toBe("main");
    expect(atualizado.websocket).toBe(true);
  });

  it("projeto recém-criado ainda não tem nada publicado", async () => {
    const p = await criar();
    expect(p.deployedBranch).toBeNull();
    expect(p.deployedSource).toBeNull();
  });
});
