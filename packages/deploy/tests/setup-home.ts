/**
 * setup-home.ts — nenhum teste grava no HOME real.
 *
 * A checagem prévia do buildx cria ~/.docker, ~/.docker/buildx e ~/.cache quando as variáveis de configuração do
 * Docker não existem. Aqui o HOME aponta para uma pasta temporária (apagada ao fim) e DOCKER_CONFIG, BUILDX_CONFIG
 * e XDG_CACHE_HOME saem do ambiente antes de qualquer teste; quem precisa de uma delas a define por conta própria.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "paas-test-home-"));
process.env.HOME = home;
for (const name of ["DOCKER_CONFIG", "BUILDX_CONFIG", "XDG_CACHE_HOME"]) delete process.env[name];

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
