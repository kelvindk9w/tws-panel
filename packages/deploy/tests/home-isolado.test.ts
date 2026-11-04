import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("HOME isolado nos testes do deploy", () => {
  it("o HOME fica dentro do tmpdir do sistema, em pasta paas-test-home-*", () => {
    const home = realpathSync(process.env.HOME!);
    expect(path.basename(home)).toMatch(/^paas-test-home-/);
    expect(home.startsWith(realpathSync(tmpdir()) + path.sep)).toBe(true);
    expect(homedir()).toBe(process.env.HOME);
  });

  it("as variáveis de configuração do Docker não vazam do ambiente real", () => {
    for (const name of ["DOCKER_CONFIG", "BUILDX_CONFIG", "XDG_CACHE_HOME"]) expect(process.env[name]).toBeUndefined();
  });
});
