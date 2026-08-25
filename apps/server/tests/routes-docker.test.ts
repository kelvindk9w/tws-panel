/**
 * routes-docker.test.ts — GET /api/docker/containers.
 *
 * Bug do review 2026-08-24 (falha silenciosa em listContainers): quando o
 * Docker está ausente/inacessível, a rota devolvia 200 com `containers: []`
 * — indistinguível de "nenhum container". Agora listContainers() lança
 * DockerUnavailableError (docker-service.ts) e a rota traduz isso em 503
 * com um código de erro claro, nunca um 200 enganoso.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";

const { listContainersMock } = vi.hoisted(() => ({ listContainersMock: vi.fn() }));

vi.mock("../src/services/docker-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/docker-service.js")>();
  return { ...actual, listContainers: listContainersMock };
});

const { DockerUnavailableError } = await import("../src/services/docker-service.js");
const dockerRoutes = (await import("../src/routes/docker.js")).default;

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(dockerRoutes);
  listContainersMock.mockReset();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/docker/containers", () => {
  it("Docker disponível → 200 com a lista", async () => {
    const containers: DockerContainerInfo[] = [
      {
        id: "abc123",
        name: "meu-app",
        image: "meu-app:latest",
        state: "running",
        status: "Up 2 minutes",
        managed: true,
        projectSlug: "meu-app",
        composeProject: "paas-meu-app",
        ports: [],
      },
    ];
    listContainersMock.mockResolvedValue(containers);

    const res = await app.inject({ method: "GET", url: "/api/docker/containers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ containers });
  });

  it("Docker indisponível → 503 docker_unavailable (NUNCA 200 com [] enganoso)", async () => {
    listContainersMock.mockRejectedValue(
      new DockerUnavailableError("não foi possível listar containers via Docker (socket /var/run/docker.sock): connection refused"),
    );

    const res = await app.inject({ method: "GET", url: "/api/docker/containers" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "docker_unavailable" });
    expect(res.json().message).toContain("connection refused");
  });

  it("erro inesperado (não é DockerUnavailableError) → segue o tratamento padrão, não vira 503 enganoso", async () => {
    listContainersMock.mockRejectedValue(new Error("bug qualquer"));

    const res = await app.inject({ method: "GET", url: "/api/docker/containers" });
    expect(res.statusCode).toBe(500);
  });
});
