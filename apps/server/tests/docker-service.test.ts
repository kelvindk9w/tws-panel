/**
 * docker-service.test.ts — listContainers() contra o Docker REAL da máquina
 * (mesmo padrão de docker-socket.test.ts: comportamento real, não mockado).
 *
 * Cobre dois bugs do review 2026-08-24:
 *  1) falha silenciosa: docker ausente/socket inacessível devolvia `[]`
 *     (200 indistinguível de "nenhum container") — agora lança
 *     DockerUnavailableError, uma falha de domínio observável.
 *  2) DOCKER_SOCKET_PATH não influenciava a listagem (só o terminal via
 *     docker-socket.ts) — agora vira DOCKER_HOST do subprocesso `docker`.
 */
import { describe, expect, it } from "vitest";
import { DockerUnavailableError, listContainers } from "../src/services/docker-service.js";

describe("listContainers", () => {
  it("socket padrão (Docker real da máquina) → lista containers sem lançar", async () => {
    const containers = await listContainers();
    expect(Array.isArray(containers)).toBe(true);
  });

  it("socket configurado explicitamente (mesmo válido) → também funciona (parâmetro é respeitado)", async () => {
    const containers = await listContainers("/var/run/docker.sock");
    expect(Array.isArray(containers)).toBe(true);
  });

  it("socket inacessível → lança DockerUnavailableError (NUNCA [] silencioso)", async () => {
    await expect(
      listContainers("/tmp/paas-test-does-not-exist.sock"),
    ).rejects.toBeInstanceOf(DockerUnavailableError);
  });

  it("erro carrega detalhe do docker (não é uma mensagem genérica vazia)", async () => {
    try {
      await listContainers("/tmp/paas-test-does-not-exist.sock");
      expect.unreachable("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(DockerUnavailableError);
      expect((err as Error).message.length).toBeGreaterThan(10);
      expect((err as Error).message).toContain("/tmp/paas-test-does-not-exist.sock");
    }
  });
});
