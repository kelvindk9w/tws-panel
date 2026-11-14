/**
 * docker-service.test.ts — listContainers() com o Docker do dublê (tests/helpers/docker-duble.ts): nada aqui fala
 * com o Docker da máquina. A mesma listagem contra o Docker de verdade está em docker-service.docker-real.test.ts
 * (só com PAAS_TEST_REAL_DOCKER=1).
 *
 * Cobre dois bugs do review 2026-08-24:
 *  1) falha silenciosa: docker ausente/socket inacessível devolvia `[]`
 *     (200 indistinguível de "nenhum container") — agora lança
 *     DockerUnavailableError, uma falha de domínio observável.
 *  2) DOCKER_SOCKET_PATH não influenciava a listagem (só o terminal via
 *     docker-socket.ts) — agora vira DOCKER_HOST do subprocesso `docker`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerUnavailableError, classifyContainer, listContainers } from "../src/services/docker-service.js";
import { dockerDuble } from "./helpers/docker-duble.js";

const PS = [
  { ID: "a1", Names: "paas-loja-app", Image: "paas-loja:latest", State: "running", Status: "Up 2 minutes", Labels: "paas.managed=true,paas.project=loja", Ports: "" },
  { ID: "b2", Names: "blog-web-1", Image: "nginx", State: "exited", Status: "Exited (0) 1 hour ago", Labels: "com.docker.compose.project=blog", Ports: "" },
]
  .map((c) => JSON.stringify(c))
  .join("\n");

describe("listContainers", () => {
  let socketAntes: string | undefined;
  beforeEach(() => {
    socketAntes = process.env.DOCKER_SOCKET_PATH;
    delete process.env.DOCKER_SOCKET_PATH;
  });
  afterEach(() => {
    if (socketAntes === undefined) delete process.env.DOCKER_SOCKET_PATH;
    else process.env.DOCKER_SOCKET_PATH = socketAntes;
  });

  it("socket padrão → lista os containers (gerenciados e externos) pelo `docker ps`, sem lançar", async () => {
    dockerDuble.responder = () => ({ code: 0, stdout: `${PS}\n` });
    const containers = await listContainers();
    expect(containers.map((c) => [c.name, c.managed, c.projectSlug])).toEqual([
      ["paas-loja-app", true, "loja"],
      ["blog-web-1", false, null],
    ]);
    expect(dockerDuble.chamadas).toEqual([["ps", "-a", "--format", "{{json .}}"]]);
    expect(dockerDuble.hosts).toEqual(["unix:///var/run/docker.sock"]);
  });

  it("DOCKER_SOCKET_PATH vale para quem não passa o socket", async () => {
    process.env.DOCKER_SOCKET_PATH = "/srv/outro/docker.sock";
    dockerDuble.responder = () => ({ code: 0, stdout: "" });
    expect(await listContainers()).toEqual([]);
    expect(dockerDuble.hosts).toEqual(["unix:///srv/outro/docker.sock"]);
  });

  it("socket configurado explicitamente → vira o DOCKER_HOST do docker (parâmetro é respeitado)", async () => {
    dockerDuble.responder = () => ({ code: 0, stdout: PS });
    expect(await listContainers("/run/user/1000/docker.sock")).toHaveLength(2);
    expect(await listContainers("tcp://10.0.0.5:2375")).toHaveLength(2);
    expect(dockerDuble.hosts).toEqual(["unix:///run/user/1000/docker.sock", "tcp://10.0.0.5:2375"]);
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
      expect((err as Error).message).toContain("Cannot connect to the Docker daemon");
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

  it("container descartável do teste de restauração (nome exato + rótulo): de ninguém; o rótulo num projeto não esconde nada", () => {
    const forged = labels({ "tws.restore-check": "1", "paas.managed": "true", "paas.project": "loja" });
    expect(classifyContainer(forged, "tws-rc-0a1b2c3d4e5f6a7b")).toEqual({ managed: false, projectSlug: null, composeProject: null });
    expect(classifyContainer(forged, "paas-loja-app").projectSlug).toBe("loja");
    expect(classifyContainer(forged).projectSlug).toBe("loja");
  });
});
