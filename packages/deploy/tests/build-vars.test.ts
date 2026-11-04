/**
 * build-vars.ts — quais Variáveis marcadas como "de build" o painel aceita passar ao build.
 */
import { describe, expect, it } from "vitest";
import { buildArgsFor, buildVarProblem, renderBuildEnvFile, secretLookingNote, selectBuildVars } from "../src/build-vars.js";
import { BUILD_VAR_MAX_CHARS } from "../src/next-build.js";

describe("buildVarProblem", () => {
  it("aceita os nomes públicos de sempre", () => {
    for (const name of ["VITE_API_URL", "NEXT_PUBLIC_KEY", "PUBLIC_X", "REACT_APP_Y", "MEU_SITE_ID", "_x"]) {
      expect(buildVarProblem(name, "valor"), name).toBeNull();
    }
  });

  it("recusa nome inválido e reservado (shell, Node, Docker, proxy, git, npm...)", () => {
    expect(buildVarProblem("1ABC")).toBe("nome inválido");
    expect(buildVarProblem("A-B")).toBe("nome inválido");
    expect(buildVarProblem("")).toBe("nome inválido");
    for (const name of ["PATH", "HOME", "NODE_OPTIONS", "NODE_ENV", "HTTP_PROXY", "https_proxy", "NO_PROXY", "TZ", "LD_PRELOAD", "npm_config_x", "NPM_CONFIG_REGISTRY", "DOCKER_HOST", "BUILDKIT_PROGRESS", "COMPOSE_FILE", "GIT_SSH_COMMAND", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]) {
      expect(buildVarProblem(name), name).toBe("nome reservado");
    }
  });

  it("recusa valor grande demais e com quebra de linha ou NUL (não cabem num arquivo de ambiente)", () => {
    expect(buildVarProblem("VITE_A", "x".repeat(BUILD_VAR_MAX_CHARS + 1))).toBe("valor grande demais");
    expect(buildVarProblem("VITE_A", "x".repeat(BUILD_VAR_MAX_CHARS))).toBeNull();
    for (const value of ["a\nb", "a\rb", "a\0b"]) expect(buildVarProblem("VITE_A", value)).toBe("valor com quebra de linha");
  });
});

describe("secretLookingNote", () => {
  it("só os nomes com cara de segredo entram no aviso (sem valor); nenhum, nenhum aviso", () => {
    expect(secretLookingNote(["VITE_API_URL", "PUBLIC_SITE"])).toBe("");
    const nota = secretLookingNote(["VITE_API_URL", "VITE_SECRET_KEY", "DB_PASSWORD"]);
    expect(nota).toContain("VITE_SECRET_KEY, DB_PASSWORD tem nome de segredo");
    expect(nota).toContain("docker history");
    expect(nota).not.toContain("VITE_API_URL");
  });
});

describe("selectBuildVars / buildArgsFor / renderBuildEnvFile", () => {
  it("separa as aceitas (em ordem de nome) das recusadas, sem valores nas recusadas", () => {
    const { vars, skipped } = selectBuildVars({ VITE_B: "2", VITE_A: "1", PATH: "/x", VITE_QUEBRA: "a\nb" });
    expect(Object.keys(vars)).toEqual(["VITE_A", "VITE_B"]);
    expect(skipped).toEqual([
      { name: "PATH", reason: "nome reservado" },
      { name: "VITE_QUEBRA", reason: "valor com quebra de linha" },
    ]);
    expect(JSON.stringify(skipped)).not.toContain("/x");
    expect(selectBuildVars(undefined)).toEqual({ vars: {}, skipped: [] });
  });

  it("buildArgsFor passa só as declaradas e lista as demais", () => {
    expect(buildArgsFor({ A: "1", B: "2", C: "3" }, ["B", "C", "Z"])).toEqual({ args: { B: "2", C: "3" }, notDeclared: ["A"] });
    expect(buildArgsFor({}, ["A"])).toEqual({ args: {}, notDeclared: [] });
  });

  it("o arquivo de ambiente é NOME=valor por linha, literal", () => {
    expect(renderBuildEnvFile({ A: "1", B: "a b=c'\"$x" })).toBe("A=1\nB=a b=c'\"$x\n");
    expect(renderBuildEnvFile({})).toBe("");
  });
});
