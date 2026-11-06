/**
 * Slug novo não pode ser igual ao nome do serviço web de outro projeto: todos ficam na rede comum do
 * proxy com o nome do serviço como apelido, e o upstream do Caddy (`<slug>:<porta>`) teria dois containers.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let projectsDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-slug-svc-data-"));
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-slug-svc-host-"));
});
afterEach(async () => {
  await removeDir(dataDir);
  await removeDir(projectsDir);
});

function novoServico(): DeployService {
  const svc = new DeployService({ dataDir, projectsDir, caddyHttpPort: 80, caddyHttpsPort: 443 } as unknown as ServerConfig);
  const engine = (svc as unknown as { engine: { remove: unknown; syncCaddy: unknown } }).engine;
  engine.remove = vi.fn(async () => undefined);
  engine.syncCaddy = vi.fn(async () => undefined);
  return svc;
}

const git = (name: string) => ({ name, ingestMode: "git" as const, source: "https://example.com/k/r.git", branch: "main", domain: `${name.toLowerCase().replace(/ /g, "-")}.example.com` });
const comServico = (svc: DeployService, nome: string, servico: { manual?: string; detectado?: string }) => {
  const projetos = (svc as unknown as { projects: Array<Record<string, unknown>> }).projects;
  const p = projetos.find((x) => x.name === nome)!;
  if (servico.manual) p.proxyService = servico.manual;
  if (servico.detectado) p.detection = { type: "compose", proxyService: servico.detectado, warnings: [], details: [] };
};

describe("slug × serviço web de outro projeto", () => {
  it("recusa (409) slug igual ao serviço web escolhido à mão, explicando o motivo e a saída", async () => {
    const svc = novoServico();
    await svc.createProject(git("Projeto A"));
    comServico(svc, "Projeto A", { manual: "site" });
    const erro = await svc.createProject(git("Site")).catch((e: unknown) => e as { statusCode: number; code: string; message: string });
    expect(erro).toMatchObject({ statusCode: 409, code: "slug_service_name_taken" });
    expect((erro as { message: string }).message).toContain("Projeto A");
    expect((erro as { message: string }).message).toContain("Escolha outro nome");
  });

  it("recusa também quando o serviço web vem da detecção (sem diferença de maiúsculas)", async () => {
    const svc = novoServico();
    await svc.createProject(git("Projeto A"));
    comServico(svc, "Projeto A", { detectado: "Site" });
    await expect(svc.createProject(git("site"))).rejects.toMatchObject({ code: "slug_service_name_taken" });
  });

  it("aceita quando nenhum projeto tem serviço web com esse nome", async () => {
    const svc = novoServico();
    await svc.createProject(git("Projeto A"));
    comServico(svc, "Projeto A", { detectado: "web" });
    expect((await svc.createProject(git("Site"))).slug).toBe("site");
  });
});
