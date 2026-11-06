/**
 * guardrail-dispensas.test.ts — "Não procede — não avisar mais" no DeployService: o achado dispensado some do
 * relatório e não bloqueia mais (nem o deploy automático, que nunca tem override), a abrangência "só neste
 * serviço" contra "em todos os serviços", regra inegociável recusada, "Voltar a avisar", Auditoria e a exclusão
 * do projeto levando as dispensas junto.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDRAIL_DISMISSALS_MAX, type GuardrailDismissal, type GuardrailReport } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let srcDir: string;
let svc: DeployService;
let engineDeploy: ReturnType<typeof vi.fn>;
const audits: Array<{ action: string; actor?: string; detail: string }> = [];

/** O caso real: a mesma variável (que não é senha) em quatro serviços. */
const QUATRO = ["web", "api", "worker", "cron"]
  .map((s) => `  ${s}:\n    image: node:22\n    environment:\n      APP_TOKEN_TTL: "3600"\n`)
  .join("");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-dispensas-"));
  srcDir = path.join(dataDir, "projects", "loja");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "compose.yml"), `services:\n${QUATRO}`);
  await writeFile(path.join(srcDir, "app.js"), 'const API_TOKEN = "Zq8vR2mXk9LpT4wYb7Nc";\n');
  audits.length = 0;
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async (e: { action: string; actor?: string; detail: string }) => void audits.push(e)) } as never, alerts: { create: vi.fn(async () => ({})) } as never },
  );
  engineDeploy = vi.fn(async () => undefined);
  const engine = (svc as unknown as { engine: Record<string, unknown> }).engine;
  engine.deploy = engineDeploy;
  engine.remove = vi.fn(async () => undefined);
  engine.syncCaddy = vi.fn(async () => undefined);
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await removeDir(dataDir);
});

async function project() {
  const p = await svc.createProject({ name: "loja", ingestMode: "existing", source: srcDir, domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type: "compose", composeFile: "compose.yml", warnings: [], details: [] } as never;
  return p;
}

async function report(id: string): Promise<GuardrailReport> {
  return (await svc.guardrailsForProject(id)).report!;
}

const weak = (service: string) => ({ rule: "weak-credentials", title: "Credencial fraca ou trivial em APP_TOKEN_TTL", service, target: "APP_TOKEN_TTL", evidence: `compose.yml: serviço "${service}" define APP_TOKEN_TTL com valor fraco/previsível` });

describe("marcar como \"não procede\"", () => {
  it("em todos os serviços: os quatro somem, o deploy deixa de ser bloqueado e a Auditoria registra quem, o quê e o motivo", async () => {
    const p = await project();
    const before = await report(p.id);
    expect(before.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(4);
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "guardrail_blocked" });

    const d = await svc.dismissGuardrail(p.id, { finding: weak("api"), scope: "project", reason: "  É o tempo de vida do token, não uma senha. " }, "admin");
    expect(d).toMatchObject({ rule: "weak-credentials", service: null, match: "target", value: "APP_TOKEN_TTL", reason: "É o tempo de vida do token, não uma senha.", by: "admin" });

    const after = await report(p.id);
    expect(after.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(0);
    expect(after.blockers).toBe(0);
    expect(after.dismissed).toBe(4);
    expect(audits.at(-1)).toMatchObject({ action: "guardrail.dismiss", actor: "admin" });
    expect(audits.at(-1)!.detail).toContain("[weak-credentials]");
    expect(audits.at(-1)!.detail).toContain("em todos os serviços");
    expect(audits.at(-1)!.detail).toContain("Motivo: É o tempo de vida do token");
    expect(audits.at(-1)!.detail).not.toContain("3600"); // valor de variável nunca vai à Auditoria

    // gravado junto do projeto
    const file = JSON.parse(await readFile(path.join(dataDir, "projects.json"), "utf8")) as { projects: Array<{ id: string; guardrailDismissals?: GuardrailDismissal[] }> };
    expect(file.projects.find((x) => x.id === p.id)?.guardrailDismissals).toEqual([d]);
  });

  it("só neste serviço: os outros três continuam e o deploy segue bloqueado por eles", async () => {
    const p = await project();
    await svc.dismissGuardrail(p.id, { finding: weak("api"), scope: "service" }, "admin");
    const after = await report(p.id);
    expect(after.findings.filter((f) => f.rule === "weak-credentials").map((f) => f.service).sort()).toEqual(["cron", "web", "worker"]);
    expect(after.dismissed).toBe(1);
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "guardrail_blocked" });
    expect(audits.at(-1)!.action).toBe("deploy.blocked");
    expect(audits.find((a) => a.action === "guardrail.dismiss")!.detail).toContain('no serviço "api"');
  });

  it("aviso (secret-in-code) dispensado some dos avisos; sem alvo nem serviço só vale a abrangência do projeto", async () => {
    const p = await project();
    const secret = (await report(p.id)).findings.find((f) => f.rule === "secret-in-code")!;
    expect(secret.target).toMatch(/^app\.js \(.+\)$/);
    await expect(svc.dismissGuardrail(p.id, { finding: secret, scope: "service" }, "admin")).rejects.toMatchObject({ statusCode: 400, code: "service_required" });
    await svc.dismissGuardrail(p.id, { finding: secret, scope: "project" }, "admin");
    const after = await report(p.id);
    expect(after.findings.some((f) => f.rule === "secret-in-code")).toBe(false);
    expect(after.warnings).toBe(0);
  });

  it("pedido repetido não grava nem audita de novo; a dispensa do projeto substitui as feitas serviço a serviço", async () => {
    const p = await project();
    const one = await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "service" }, "admin");
    expect(await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "service" }, "admin")).toEqual(one);
    expect(audits.filter((a) => a.action === "guardrail.dismiss")).toHaveLength(1);
    await svc.dismissGuardrail(p.id, { finding: weak("api"), scope: "service" }, "admin");
    const all = await svc.dismissGuardrail(p.id, { finding: weak("cron"), scope: "project" }, "admin");
    expect(await svc.guardrailDismissals(p.id)).toEqual([all]);
    // e, coberto pelo projeto, pedir de novo para um serviço não muda nada
    expect(await svc.dismissGuardrail(p.id, { finding: weak("worker"), scope: "service" }, "admin")).toEqual(all);
  });

  it("regra inegociável (privileged, docker.sock, rede do host, isolamento do painel) é recusada e nada é gravado", async () => {
    const p = await project();
    for (const rule of ["privileged-container", "panel-resource", "host-namespace", "network-hijack", "reserved-name", "panel-image", "proxy-port-conflict", "invalid-compose"]) {
      await expect(svc.dismissGuardrail(p.id, { finding: { rule, title: "x", service: "web", evidence: "e" }, scope: "project" }, "admin")).rejects.toMatchObject({ statusCode: 400, code: "not_dismissible" });
    }
    await expect(svc.dismissGuardrail(p.id, { finding: { rule: "regra-inventada", title: "x", evidence: "e" }, scope: "project" }, "admin")).rejects.toMatchObject({ code: "unknown_rule" });
    expect(await svc.guardrailDismissals(p.id)).toEqual([]);
    expect(audits.some((a) => a.action === "guardrail.dismiss")).toBe(false);
  });

  it("pedido malformado: serviço inválido, achado vazio, motivo longo demais, lista cheia", async () => {
    const p = await project();
    await expect(svc.dismissGuardrail(p.id, { finding: { ...weak("web"), service: "../x" }, scope: "service" }, "admin")).rejects.toMatchObject({ code: "invalid_service" });
    await expect(svc.dismissGuardrail(p.id, { finding: { rule: "host-mount", title: "x" }, scope: "project" }, "admin")).rejects.toMatchObject({ code: "invalid_finding" });
    await expect(svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project", reason: "x".repeat(501) }, "admin")).rejects.toMatchObject({ code: "reason_too_long" });
    const stored = (await svc.getProject(p.id))!;
    stored.guardrailDismissals = Array.from({ length: GUARDRAIL_DISMISSALS_MAX }, (_, i) => ({ id: `d${i}`, rule: "latest-tag", service: null, match: "target" as const, value: `img${i}`, title: "", reason: null, by: "admin", at: "2026-11-06T00:00:00.000Z" }));
    await expect(svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project" }, "admin")).rejects.toMatchObject({ statusCode: 409, code: "too_many_dismissals" });
    // achado sem título: guarda a regra no lugar
    stored.guardrailDismissals = [];
    expect((await svc.dismissGuardrail(p.id, { finding: { ...weak("web"), title: "  " }, scope: "project" }, "admin")).title).toBe("weak-credentials");
  });

  it("entrada estragada no arquivo é ignorada (não derruba a lista nem o deploy)", async () => {
    const p = await project();
    const ok = await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project" }, "admin");
    (await svc.getProject(p.id))!.guardrailDismissals = [{ lixo: true } as never, ok];
    expect(await svc.guardrailDismissals(p.id)).toEqual([ok]);
    expect((await report(p.id)).blockers).toBe(0);
  });
});

describe("Voltar a avisar", () => {
  it("o achado volta (e volta a bloquear), a Auditoria registra; dispensa que não existe dá 404", async () => {
    const p = await project();
    const d = await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project" }, "admin");
    const other = await svc.dismissGuardrail(p.id, { finding: { rule: "latest-tag", title: "t", service: "web", target: "node" }, scope: "project" }, "admin");
    await svc.restoreGuardrail(p.id, d.id, "admin");
    expect(await svc.guardrailDismissals(p.id)).toEqual([other]);
    expect((await report(p.id)).findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(4);
    expect(audits.at(-1)).toMatchObject({ action: "guardrail.undismiss", actor: "admin" });
    expect(audits.at(-1)!.detail).toContain("Voltou a avisar: [weak-credentials]");
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "guardrail_blocked" });
    await svc.restoreGuardrail(p.id, other.id, "admin");
    expect((await svc.getProject(p.id))!.guardrailDismissals).toBeUndefined();
    await expect(svc.restoreGuardrail(p.id, "nao-existe", "admin")).rejects.toMatchObject({ statusCode: 404, code: "dismissal_not_found" });
  });
});

describe("deploy automático respeita as dispensas", () => {
  it("redeploy sem override (restauração, reinício, aviso de atualização) passa quando o único bloqueio foi dispensado", async () => {
    const p = await project();
    await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project" }, "admin");
    // como app.ts chama no redeploy da restauração: sem opções, sem override
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(audits.some((a) => a.action === "guardrail.override")).toBe(false);
    expect(audits.some((a) => a.action === "deploy.blocked")).toBe(false);
    // o engine recebe o projeto com as dispensas (ele as aplica de novo depois da ingestão e no compose resolvido)
    const [deployed, , , opts] = engineDeploy.mock.calls[0]! as [{ guardrailDismissals?: GuardrailDismissal[] }, unknown, unknown, { guardrailOverride: boolean; precomputedGuardrailReport?: GuardrailReport }];
    expect(deployed.guardrailDismissals).toHaveLength(1);
    expect(opts.guardrailOverride).toBe(false);
    expect(opts.precomputedGuardrailReport?.blockers).toBe(0);
  });
});

describe("exclusão do projeto", () => {
  it("as dispensas saem junto com o projeto", async () => {
    const p = await project();
    await svc.dismissGuardrail(p.id, { finding: weak("web"), scope: "project" }, "admin");
    await svc.deleteProject(p.id, false, () => undefined);
    const raw = await readFile(path.join(dataDir, "projects.json"), "utf8");
    expect(raw).not.toContain("APP_TOKEN_TTL");
    expect(raw).not.toContain("guardrailDismissals");
    await expect(svc.guardrailDismissals(p.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
