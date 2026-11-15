/**
 * compose-config.test.ts — loadCanonicalCompose e composeEnv sem Docker: o executor do `docker compose config` é um
 * dublê (o terceiro argumento), e o ambiente filtrado é conferido direto. O mesmo caminho pelo `docker compose config`
 * real está em compose-hostil.docker-real.test.ts (só com PAAS_TEST_REAL_DOCKER=1).
 */
import { describe, expect, it } from "vitest";
import { composeEnv, loadCanonicalCompose } from "../src/compose-config.js";

describe("loadCanonicalCompose / composeEnv", () => {
  it("composeEnv repassa só o que o docker precisa", () => {
    const env = composeEnv({
      PATH: "/usr/bin",
      HOME: "/home/tws",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HTTPS_PROXY: "http://proxy:3128",
      SETUP_TOKEN: "x",
      SESSION_SECRET: "y",
      PAAS_DATA_DIR: "/data",
      LC_ALL: "C",
    });
    expect(Object.keys(env).sort()).toEqual(["DOCKER_HOST", "HOME", "HTTPS_PROXY", "LC_ALL", "PATH"]);
  });

  it("falha do config: devolve o erro e as variáveis obrigatórias que faltam", async () => {
    const r = await loadCanonicalCompose(["compose"], async () => ({
      code: 1,
      stdout: "",
      stderr: "required variable DB_PASS is missing a value: defina\nrequired variable DB_PASS is missing a value",
    }));
    expect(r).toMatchObject({ ok: false, missing: ["DB_PASS"] });
  });

  it("saída que não é JSON vira erro, não exceção", async () => {
    const r = await loadCanonicalCompose(["compose"], async () => ({ code: 0, stdout: "name: x", stderr: "" }));
    expect(r).toMatchObject({ ok: false });
  });

  it("repassa o ambiente filtrado e o prazo ao executar", async () => {
    let visto: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {};
    await loadCanonicalCompose(["compose"], async (_f, _a, opts) => {
      visto = opts ?? {};
      return { code: 0, stdout: "{}", stderr: "" };
    });
    expect(visto.timeoutMs).toBeGreaterThan(0);
    expect(visto.env).not.toHaveProperty("SETUP_TOKEN");
  });
});
