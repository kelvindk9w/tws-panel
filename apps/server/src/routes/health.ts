import type { FastifyPluginAsync } from "fastify";
import { scanSystemHealth } from "../services/system-info.js";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/health/scan", async (_request, reply) => {
    const result = await scanSystemHealth();
    return reply.send(result);
  });
};

export default healthRoutes;
