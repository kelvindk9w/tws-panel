/**
 * DeployEngine.composeTimezone — Dockerfile e env_file do repositório do usuário são lidos como
 * arquivo comum, sem seguir link simbólico e com teto de tamanho (um `Dockerfile -> /dev/zero`
 * não pode travar o painel). Sem Docker.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeployEngine } from "../src/engine.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-fuso-"));
  await mkdir(path.join(root, "web"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Fn = (src: string, compose: string, dotenv: Record<string, string>, tz: string | null, log: (s: string) => void) => Promise<Record<string, Record<string, string>>>;
const compose = "services:\n  web:\n    build: ./web\n    env_file: ./web.env\n  db:\n    image: postgres:17\n  job:\n    image: alpine\n";
function run(log: string[]) {
  const engine = new DeployEngine({} as never);
  return (engine as unknown as { composeTimezone: Fn }).composeTimezone(root, compose, {}, "America/Sao_Paulo", (s) => log.push(s));
}

describe("composeTimezone", () => {
  it("link simbólico para /dev/zero é ignorado: o serviço recebe o TZ; banco fica de fora", async () => {
    await symlink("/dev/zero", path.join(root, "web", "Dockerfile"));
    await symlink("/dev/zero", path.join(root, "web.env"));
    const log: string[] = [];
    expect(await run(log)).toEqual({ web: { TZ: "America/Sao_Paulo" }, job: { TZ: "America/Sao_Paulo" } });
    expect(log.join("")).toContain("db (postgres:17) é banco/cache");
  });

  it("arquivo enorme é lido só até o teto", async () => {
    await writeFile(path.join(root, "web", "Dockerfile"), "FROM node\n" + "# x\n".repeat(400_000) + "ENV TZ=Asia/Tokyo\n");
    expect(Object.keys(await run([]))).toEqual(["web", "job"]);
  });

  it("ENV TZ do Dockerfile legível vale e não é sobrescrito", async () => {
    await writeFile(path.join(root, "web", "Dockerfile"), "FROM node\nENV TZ=Asia/Tokyo\n");
    const log: string[] = [];
    expect(Object.keys(await run(log))).toEqual(["job"]);
    expect(log.join("")).toContain("no ENV do Dockerfile");
  });
});
