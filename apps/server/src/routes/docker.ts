import type { FastifyPluginAsync } from "fastify";
import type { DockerContainersResponse } from "@paas/core";
import { listContainers } from "../services/docker-service.js";

const dockerRoutes: FastifyPluginAsync = async (app) => {
  // Visão não-invasiva: todos os containers, gerenciados marcados com managed=true.
  app.get("/api/docker/containers", async (_request, reply) => {
    const containers = await listContainers();
    const response: DockerContainersResponse = { containers };
    return reply.send(response);
  });
};

export default dockerRoutes;
