import { describe, expect, it } from "vitest";
import {
  BUILD_VAR_MAX_CHARS,
  ENV_MAX_BODY_BYTES,
  ENV_MAX_VALUE_CHARS,
  ENV_MAX_VARS,
  buildVarProblem,
  buildVarProblemCode,
} from "../src/env-build";

describe("limites compartilhados das Variáveis", () => {
  it("1000 variáveis, corpo de 1 MiB e valor de 32 KB", () => {
    expect(ENV_MAX_VARS).toBe(1000);
    expect(ENV_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(ENV_MAX_VALUE_CHARS).toBe(32 * 1024);
  });
});

describe("buildVarProblem", () => {
  it("o código acompanha o texto", () => {
    expect(buildVarProblemCode("PATH")).toBe("reserved");
    expect(buildVarProblemCode("1X")).toBe("name");
    expect(buildVarProblemCode("A", "x".repeat(BUILD_VAR_MAX_CHARS + 1))).toBe("size");
    expect(buildVarProblemCode("A", "a\nb")).toBe("newline");
    expect(buildVarProblemCode("A", "ok")).toBeNull();
  });

  it("aceita nome e valor comuns", () => {
    expect(buildVarProblem("VITE_API_URL", "https://api.example.com")).toBeNull();
    expect(buildVarProblem("VITE_API_URL")).toBeNull();
  });

  it("recusa nome inválido, reservado (exato, extra e por prefixo)", () => {
    expect(buildVarProblem("1RUIM")).toBe("nome inválido");
    expect(buildVarProblem("PATH")).toBe("nome reservado");
    expect(buildVarProblem("HTTP_PROXY")).toBe("nome reservado");
    expect(buildVarProblem("DOCKER_HOST")).toBe("nome reservado");
    expect(buildVarProblem("LD_PRELOAD")).toBe("nome reservado");
  });

  it("recusa valor grande demais e com quebra de linha ou nulo", () => {
    expect(buildVarProblem("VITE_A", "x".repeat(BUILD_VAR_MAX_CHARS + 1))).toBe("valor grande demais");
    expect(buildVarProblem("VITE_A", "a\nb")).toBe("valor com quebra de linha");
    expect(buildVarProblem("VITE_A", "a\0b")).toBe("valor com quebra de linha");
  });
});
