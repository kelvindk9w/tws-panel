import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside } from "../src/services/projects-dir.js";

describe("isInside", () => {
  const root = path.resolve("/srv/projetos");

  it("aceita a própria raiz e o que está dentro, inclusive pasta cujo nome começa com '..'", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, "app"))).toBe(true);
    expect(isInside(root, path.join(root, "..cache"))).toBe(true);
    expect(isInside(root, path.join(root, "..cache", "x"))).toBe(true);
  });

  it("recusa o que está fora (pai, irmão, outra raiz)", () => {
    expect(isInside(root, path.dirname(root))).toBe(false);
    expect(isInside(root, path.resolve("/srv/outro"))).toBe(false);
    expect(isInside(root, path.resolve("/etc"))).toBe(false);
  });
});
