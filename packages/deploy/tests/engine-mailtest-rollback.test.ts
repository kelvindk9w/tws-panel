/** REPRODUÇÃO (revisão): Mailpit falha no deploy node-server com keepPrevious -> o container no ar é apagado. */
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_f: string, args: string[]): Promise<Result> => {
    calls.push(args);
    if (args[0] === "rename") return { code: 1, stdout: "", stderr: "No such container" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async () => 0),
}));
const { DeployEngine } = await import("../src/engine.js");
describe("rev: Mailpit indisponível no node-server", () => {
  it("não pode remover o container que está no ar", async () => {
    const engine = new DeployEngine({
      projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443,
      mailTestForProject: async () => { throw new Error("mail_test_unavailable"); },
    });
    const p = { id: "loja", name: "loja", slug: "loja", proxyPort: 3000 } as unknown as Project;
    await expect((engine as any).runNodeServerContainer(p, "img", () => {}, {}, null, true)).rejects.toThrow(/mail_test_unavailable/);
    expect(calls).not.toContainEqual(["rm", "-f", "paas-loja-app"]);
    // nada do que está no ar foi tocado: nem renomeado, nem parado
    expect(calls.some((c) => c[0] === "rename" || c[0] === "stop" || c[0] === "start")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("sem o problema do Mailpit, falha do docker run continua religando a versão anterior", async () => {
    calls.length = 0;
    const failing = vi.mocked((await import("../src/exec.js")).run);
    failing.mockImplementation(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "run") return { code: 1, stdout: "", stderr: "boom" };
      if (args[0] === "rename" && args[1] === "paas-loja-app-previous") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const engine = new DeployEngine({
      projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443,
      mailTestForProject: async () => ({ network: "paas-mailtest-loja" }),
    });
    const p = { id: "loja", name: "loja", slug: "loja", proxyPort: 3000 } as unknown as Project;
    await expect((engine as any).runNodeServerContainer(p, "img", () => {}, {}, null, true)).rejects.toThrow(/falha ao subir/);
    expect(calls).toContainEqual(["rename", "paas-loja-app-previous", "paas-loja-app"]);
  });
});
