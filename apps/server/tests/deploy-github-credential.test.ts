/**
 * deploy-github-credential.test.ts — com a conta do GitHub conectada, um
 * repositório privado do github.com clona sem token próprio: a credencial do
 * projeto vence; sem ela, vale a da conta; outro provedor não recebe o token.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-gh-cred-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ login: "kelvin" }), { status: 200 })),
  );
  svc = new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: null,
    port: 9000,
  } as unknown as ServerConfig);
  await svc.github.connect("github_pat_CONTA1234");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

async function projeto(source: string, ingestMode: "git" | "existing" = "git") {
  return svc.createProject({ name: `p-${Math.random().toString(16).slice(2, 6)}`, ingestMode, source, branch: "main", domain: `${Math.random().toString(16).slice(2, 8)}.localhost` });
}

describe("credencial de clone com a conta do GitHub conectada", () => {
  it("repositório do github.com sem token próprio → usa o token da conta", async () => {
    const p = await projeto("https://github.com/kelvin/api-privada.git");
    expect(await svc.credentialFor(p)).toMatchObject({ token: "github_pat_CONTA1234" });
  });

  it("o token próprio do projeto vence o da conta", async () => {
    const p = await projeto("https://github.com/kelvin/outro.git");
    await svc.setCredential(p.id, { token: "github_pat_PROPRIO" });
    expect(await svc.credentialFor(p)).toMatchObject({ token: "github_pat_PROPRIO" });
  });

  it("outro provedor e pasta local não recebem o token da conta", async () => {
    expect(await svc.credentialFor(await projeto("https://gitlab.com/kelvin/x.git"))).toBeNull();
    const pasta = path.join(dataDir, "projects", "site");
    await mkdir(pasta, { recursive: true });
    expect(await svc.credentialFor(await projeto(pasta, "existing"))).toBeNull();
  });
});
