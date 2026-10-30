import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFramework } from "../src/framework.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-framework-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectFramework", () => {
  it("reconhece Laravel: laravel/framework no composer.json e o arquivo artisan", async () => {
    await writeFile(path.join(dir, "composer.json"), JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11.0" } }));
    await writeFile(path.join(dir, "artisan"), "#!/usr/bin/env php\n");
    expect(await detectFramework(dir)).toBe("laravel");
  });

  it("sem artisan na raiz não é o app", async () => {
    await writeFile(path.join(dir, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11.0" } }));
    expect(await detectFramework(dir)).toBeNull();
  });

  it("artisan que é uma pasta não conta", async () => {
    await writeFile(path.join(dir, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11.0" } }));
    await mkdir(path.join(dir, "artisan"));
    expect(await detectFramework(dir)).toBeNull();
  });

  it("composer.json sem o framework, sem require, ou require que não é objeto", async () => {
    await writeFile(path.join(dir, "artisan"), "x");
    for (const body of [{ require: { "symfony/console": "^7" } }, {}, { require: "laravel/framework" }, { require: null }]) {
      await writeFile(path.join(dir, "composer.json"), JSON.stringify(body));
      expect(await detectFramework(dir)).toBeNull();
    }
  });

  it("composer.json ausente, inválido, pasta ou grande demais", async () => {
    expect(await detectFramework(dir)).toBeNull();
    await writeFile(path.join(dir, "composer.json"), "{ não é json");
    expect(await detectFramework(dir)).toBeNull();
    await rm(path.join(dir, "composer.json"));
    await mkdir(path.join(dir, "composer.json"));
    expect(await detectFramework(dir)).toBeNull();
    await rm(path.join(dir, "composer.json"), { recursive: true });
    await writeFile(path.join(dir, "composer.json"), " ".repeat(600 * 1024));
    expect(await detectFramework(dir)).toBeNull();
  });
});
