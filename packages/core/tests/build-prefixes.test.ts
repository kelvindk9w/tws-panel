/**
 * Prefixos públicos conhecidos (sugeridos como "de build" na seção Variáveis) e os tipos que a pessoa
 * pode escolher à mão no assistente.
 */
import { describe, expect, it } from "vitest";
import { CHOOSABLE_PROJECT_TYPES, PROJECT_TYPES, PUBLIC_BUILD_PREFIXES, hasPublicBuildPrefix } from "../src/deploy";

describe("hasPublicBuildPrefix", () => {
  it("VITE_, NEXT_PUBLIC_, PUBLIC_ e REACT_APP_ com algo depois", () => {
    for (const name of ["VITE_API_URL", "NEXT_PUBLIC_KEY", "PUBLIC_SITE", "REACT_APP_X"]) {
      expect(hasPublicBuildPrefix(name), name).toBe(true);
    }
    expect([...PUBLIC_BUILD_PREFIXES]).toEqual(["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"]);
  });

  it("o prefixo sozinho, nome parecido e segredo comum não contam", () => {
    for (const name of ["VITE_", "PUBLIC_", "DATABASE_URL", "MY_VITE_X", "vite_api", "PUBLICO_X", "SEGREDO"]) {
      expect(hasPublicBuildPrefix(name), name).toBe(false);
    }
  });
});

describe("CHOOSABLE_PROJECT_TYPES", () => {
  it("todos os tipos menos 'unknown'", () => {
    expect([...CHOOSABLE_PROJECT_TYPES].sort()).toEqual(PROJECT_TYPES.filter((t) => t !== "unknown").sort());
  });
});
