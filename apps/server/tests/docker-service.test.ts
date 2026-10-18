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
import { DockerUnavailableError, classifyContainer, listContainers } from "../src/services/docker-service.js";

describe("listContainers", () => {
  // Estes dois casos falam com o Docker REAL da máquina: levam ~1,5s sozinhos e
  // mais quando os 6 workspaces rodam em paralelo. O limite padrão de 5s do
  // vitest gera falso negativo sob carga — o teto maior não deixa o caso feliz
  // mais lento, apenas evita que a máquina ocupada reprove código correto.
  it("socket padrão (Docker real da máquina) → lista containers sem lançar", { timeout: 20_000 }, async () => {
    const containers = await listContainers();
    expect(Array.isArray(containers)).toBe(true);
  });

  it("socket configurado explicitamente (mesmo válido) → também funciona (parâmetro é respeitado)", { timeout: 20_000 }, async () => {
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

describe("classifyContainer — labels forjadas (M9)", () => {
  const labels = (o: Record<string, string>) => new Map(Object.entries(o));

  it("imagem com LABEL paas.project=vitima num container do compose do atacante: é do atacante", () => {
    expect(
      classifyContainer(labels({ "com.docker.compose.project": "paas-atacante", "paas.project": "vitima", "paas.managed": "true" })),
    ).toEqual({ managed: true, projectSlug: "atacante", composeProject: "paas-atacante" });
  });

  it("container do painel (docker run) segue identificado pela label do painel", () => {
    expect(classifyContainer(labels({ "paas.managed": "true", "paas.project": "loja" }))).toEqual({
      managed: true,
      projectSlug: "loja",
      composeProject: null,
    });
  });

  it("stack externa continua externa, mesmo com labels do painel herdadas", () => {
    expect(classifyContainer(labels({ "com.docker.compose.project": "blog", "paas.managed": "true", "paas.project": "loja" }))).toEqual({
      managed: false,
      projectSlug: null,
      composeProject: "blog",
    });
  });
});
