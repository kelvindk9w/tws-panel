import type { FastifyPluginAsync } from "fastify";
import type { DockerContainersResponse } from "@paas/core";
import { DockerUnavailableError, listContainers } from "../services/docker-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

const dockerRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  // Sem entrada do cliente (nenhum body/querystring/params) — não há o que
  // validar por schema; o handler acima só padroniza o formato de erro.
  // Visão não-invasiva: todos os containers, gerenciados marcados com managed=true.
  app.get("/api/docker/containers", async (_request, reply) => {
    let containers;
    try {
      containers = await listContainers();
    } catch (err) {
      if (err instanceof DockerUnavailableError) {
        // Falha de domínio observável: NUNCA 200 com `containers: []` quando
        // o Docker está fora — isso seria indistinguível de "nenhum
        // container" e o dashboard mostraria "tudo certo" enganosamente.
        return reply.code(503).send({ error: "docker_unavailable", message: err.message });
      }
      throw err;
    }
    const response: DockerContainersResponse = { containers };
    return reply.send(response);
  });
};

export default dockerRoutes;
