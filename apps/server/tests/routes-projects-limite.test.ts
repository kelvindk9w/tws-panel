/**
 * GET /api/projects com mais projetos que o limite de montagem simultânea (8): todos saem,
 * na ordem do cadastro, e nunca há mais de 8 sendo montados ao mesmo tempo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

let ctx: AuthTestContext;
afterEach(async () => closeAuthTestApp(ctx));

describe("GET /api/projects com muitos projetos", () => {
  it("monta todos, na ordem do cadastro, com no máximo 8 ao mesmo tempo", async () => {
    ctx = await buildAuthTestApp("tk");
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    let active = 0;
    let peak = 0;
    ctx.app.decorate("deployService", {
      listContainers: async () => [],
      listProjects: async () => ids.map((id) => ({ id, slug: id, name: id, domain: `${id}.example.com` })),
      statusOf: async (p: { id: string }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, p.id === "p0" ? 30 : 2));
        active -= 1;
        return { status: "stopped", containers: [] };
      },
      projectUrl: (p: { domain: string }) => `https://${p.domain}`,
      credentialInfo: async () => ({ configured: false }),
    } as never);
    await ctx.app.register(projectsRoutes);
    const res = await ctx.app.inject({ method: "GET", url: "/api/projects", headers: { [SETUP_TOKEN_HEADER]: "tk" } });
    expect(res.json().projects.map((p: { project: { id: string } }) => p.project.id)).toEqual(ids);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });
});
