/**
 * docker-service.docker-real.test.ts — listContainers() contra o Docker REAL da máquina (integração).
 *
 * Só roda com PAAS_TEST_REAL_DOCKER=1 (docs/processo/testes-e-docker.md): é o pedido explícito para falar com o
 * Docker. A mesma regra com o dublê (sem Docker nenhum) está em docker-service.test.ts.
 */
import { describe, expect, it } from "vitest";
import { listContainers } from "../src/services/docker-service.js";
import { usarDockerReal } from "./helpers/docker-duble.js";

usarDockerReal();

describe.skipIf(process.env.PAAS_TEST_REAL_DOCKER !== "1")("listContainers com o Docker real", () => {
  // Levam ~1,5s sozinhos e mais com os pacotes rodando em paralelo: o teto maior só evita falso negativo sob carga.
  it("socket padrão (Docker real da máquina) → lista containers sem lançar", { timeout: 20_000 }, async () => {
    const containers = await listContainers();
    expect(Array.isArray(containers)).toBe(true);
  });

  it("socket configurado explicitamente (mesmo válido) → também funciona (parâmetro é respeitado)", { timeout: 20_000 }, async () => {
    const containers = await listContainers("/var/run/docker.sock");
    expect(Array.isArray(containers)).toBe(true);
  });
});
